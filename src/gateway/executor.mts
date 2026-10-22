import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type {
  AuthorizationService,
  BrokerCallOptions,
  BrokerInvocation,
  ExecutionPermit,
  ExecutorResult,
  OperationReceipt,
  ServiceCapability,
  ServiceConnection,
  ServiceExecutor,
  VerificationResult,
} from "../agents/contracts.mjs";
import type {
  CliConfiguration,
  GatewayCredentialVault,
  GatewayExecutionAdmission,
  ExecutorConfiguration,
  GatewayConnections,
  McpHttpConfiguration,
  ResolveExecutorConfiguration,
} from "./config.mjs";
import { assertHttpEndpoint, configurationReference } from "./config.mjs";
import { GatewayCredentials } from "./credentials.mjs";
import {
  canonicalJson,
  jsonObject,
  normalizeArguments,
  Sanitizer,
  sha256,
} from "./json.mjs";
import { atomicJson, operationKey } from "./store.mjs";

export const capabilityId = (connectionId: string, upstreamName: string) =>
  `svc_${sha256(canonicalJson([connectionId, upstreamName])).slice(0, 48)}`;
const noExecution = (reason: string, evidence: string): ExecutorResult => ({
  state: "not_executed",
  reason,
  evidenceRef: evidence,
});

export class TrustedServiceExecutor implements ServiceExecutor {
  readonly activeInvocationIds = new Set<string>();
  private readonly credentials: GatewayCredentials;
  constructor(
    private readonly options: {
      authorization: AuthorizationService;
      vault: GatewayCredentialVault;
      admission: GatewayExecutionAdmission;
      catalogue?: (
        connection: ServiceConnection,
      ) => Promise<ServiceCapability[]>;
      connections: GatewayConnections;
      resolveConfiguration: ResolveExecutorConfiguration;
      privateDirectory: string;
      /** Durable cancellation and host lifecycle admission, checked again at dispatch. */
      canDispatch(invocation: BrokerInvocation): Promise<boolean>;
    },
  ) {
    this.credentials = new GatewayCredentials(
      options.vault,
      options.connections,
      options.privateDirectory,
    );
  }
  private async configuration(
    connection: ServiceConnection,
  ): Promise<ExecutorConfiguration> {
    const config = await this.options.resolveConfiguration(
      configurationReference(connection),
    );
    if (
      config.type !== connection.transport.type ||
      !Number.isSafeInteger(config.timeoutMs) ||
      config.timeoutMs < 1 ||
      config.timeoutMs > 120_000
    )
      throw new Error("Unsupported executor configuration.");
    return config;
  }
  async listCapabilities(
    connection: ServiceConnection,
  ): Promise<ServiceCapability[]> {
    return this.options.catalogue
      ? this.options.catalogue(connection)
      : this.discoverCapabilities(connection);
  }
  /** Host catalogue callback only; broker discovery uses listCapabilities. */
  async discoverCapabilities(
    connection: ServiceConnection,
    options: Pick<BrokerCallOptions, "signal"> = {},
  ): Promise<ServiceCapability[]> {
    options.signal?.throwIfAborted();
    const config = await this.configuration(connection);
    const capabilities = await this.credentials.use(
      connection,
      config,
      async (_handle, token, sanitizer) => {
        const tools =
          config.type === "cli"
            ? config.operations.map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
                outputSchema: null,
              }))
            : await this.withMcp(
                config,
                token,
                async (client) => {
                  const tools = [];
                  let cursor: string | undefined;
                  const seen = new Set<string>();
                  do {
                    const page = await client.listTools(
                      cursor ? { cursor } : {},
                      { timeout: config.timeoutMs, signal: options.signal },
                    );
                    tools.push(...page.tools);
                    if (
                      tools.length > 500 ||
                      seen.size >= 20 ||
                      (page.nextCursor && seen.has(page.nextCursor))
                    )
                      throw new Error(
                        "Upstream catalogue exceeds supported bounds.",
                      );
                    cursor = page.nextCursor;
                    if (cursor) seen.add(cursor);
                  } while (cursor);
                  return tools;
                },
                options.signal,
              );
        options.signal?.throwIfAborted();
        const names = new Set<string>();
        return tools.map((tool): ServiceCapability => {
          if (
            !tool.name ||
            names.has(tool.name) ||
            sanitizer.text(tool.name) !== tool.name
          )
            throw new Error("Invalid upstream tool catalogue.");
          names.add(tool.name);
          const inputSchema = jsonObject(sanitizer.value(tool.inputSchema));
          if (inputSchema.type !== "object")
            throw new Error("Only object tool schemas are supported.");
          return {
            id: capabilityId(connection.id, tool.name),
            connectionId: connection.id,
            upstreamName: tool.name,
            description: sanitizer.text(tool.description ?? ""),
            inputSchema,
            outputSchema: tool.outputSchema
              ? jsonObject(sanitizer.value(tool.outputSchema))
              : null,
            verification: config.verify ? "read_only" : "unsupported",
          };
        });
      },
    );
    return capabilities;
  }

  async execute(
    invocation: BrokerInvocation,
    permit: ExecutionPermit,
    options: BrokerCallOptions = {},
  ): Promise<ExecutorResult> {
    let admitted = false;
    const evidence = `gateway:before-dispatch:${permit.attemptId}`;
    try {
      if (permit.invocationId !== invocation.operation.invocationId)
        return noExecution("Permit identity mismatch.", evidence);
      const connection = await this.options.connections.get(
        invocation.operation.connectionId,
      );
      if (!connection || connection.projectId !== invocation.caller.projectId)
        return noExecution("Connection is unavailable.", evidence);
      const config = await this.configuration(connection);
      return await this.credentials.use(
        connection,
        config,
        async (handle, token, sanitizer) => {
          // Credential-bearing input is rejected before dispatch, including values under innocent keys.
          const encoded = canonicalJson(invocation.operation.arguments);
          if (
            canonicalJson(sanitizer.value(invocation.operation.arguments)) !==
            encoded
          )
            return noExecution(
              "Credential-bearing arguments are prohibited.",
              evidence,
            );
          const dispatch = async (
            action: () => Promise<ExecutorResult>,
          ): Promise<ExecutorResult> => {
            if (
              options.signal?.aborted ||
              !(await this.options.canDispatch(invocation))
            )
              return noExecution(
                "Execution admission denied or cancelled.",
                evidence,
              );
            const admission = await this.options.admission.run(
              invocation,
              permit,
              async () => {
                if (
                  options.signal?.aborted ||
                  !(await this.options.canDispatch(invocation))
                )
                  return noExecution(
                    "Execution cancelled before dispatch.",
                    evidence,
                  );
                return this.credentials.withCurrent(
                  connection,
                  handle,
                  async () => {
                    if (options.signal?.aborted)
                      return noExecution(
                        "Execution cancelled before dispatch.",
                        evidence,
                      );
                    admitted = true;
                    return action();
                  },
                );
              },
            );
            return admission.state === "admitted"
              ? admission.result
              : noExecution(
                  "Execution admission denied or cancelled.",
                  evidence,
                );
          };
          if (config.type === "cli")
            return this.executeCli(
              config,
              invocation,
              permit,
              token,
              sanitizer,
              dispatch,
              evidence,
              options,
            );
          return this.withMcp(config, token, async (client) => {
            const capabilities = await this.discoverForCall(
              client,
              connection,
              config,
            );
            const capability = capabilities.find(
              (item) => item.id === invocation.operation.operation,
            );
            if (
              !capability ||
              normalizeArguments(
                capability.inputSchema,
                invocation.operation.arguments,
              ).argumentsFingerprint !==
                invocation.operation.argumentsFingerprint
            )
              return noExecution("Tool schema or operation changed.", evidence);
            return dispatch(async () => {
              const result = await client.callTool(
                {
                  name: capability.upstreamName,
                  arguments: invocation.operation.arguments,
                },
                CallToolResultSchema,
                {
                  timeout: config.timeoutMs,
                  signal: options.signal,
                  onprogress: () =>
                    options.onProgress?.({
                      invocationId: invocation.operation.invocationId,
                      attemptId: permit.attemptId,
                      label: "Upstream progress",
                      detail: null,
                    }),
                },
              );
              const safe = jsonObject(sanitizer.value(result));
              if (result.isError)
                return {
                  state: "failed",
                  externalReference: null,
                  reason: `Upstream tool error: ${canonicalJson(safe).slice(0, 2000)}`,
                };
              return {
                state: "succeeded",
                externalReference: null,
                content: [{ type: "data", value: { crewMcpResult: safe } }],
              };
            });
          });
        },
      );
    } catch {
      // Network/parser/process errors can contain headers, URLs or raw provider bodies.
      return admitted
        ? {
            state: "uncertain",
            verificationRef: null,
            reason:
              "Upstream execution has no confirmed outcome; verify before any retry.",
          }
        : noExecution(
            "Connection, authentication or executor preparation failed before admission.",
            evidence,
          );
    }
  }

  async verify(
    receipt: OperationReceipt,
    options: BrokerCallOptions = {},
  ): Promise<VerificationResult> {
    try {
      if (this.activeInvocationIds.has(receipt.operation.invocationId))
        return {
          state: "unknown",
          reason: "The owned CLI process has not confirmed exit.",
        };
      const connection = await this.options.connections.get(
        receipt.operation.connectionId,
      );
      if (!connection || connection.projectId !== receipt.caller.projectId)
        return {
          state: "unknown",
          reason: "Connection unavailable for read-only verification.",
        };
      const config = await this.configuration(connection);
      let cliMarker = null;
      try {
        cliMarker = jsonObject(
          JSON.parse(
            await readFile(
              this.cliMarker(receipt.caller, receipt.operation.invocationId),
              "utf8",
            ),
          ),
        );
      } catch (error) {
        if (!(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        ))
          throw error;
      }
      if (cliMarker !== null || config.type === "cli") {
        // A child can survive a controller crash. No recorded close for this exact attempt
        // means no retry, even when a point-in-time provider lookup finds no effect yet.
        if (
          cliMarker?.attemptId !== receipt.attempts.at(-1)?.id ||
          cliMarker?.state !== "exited"
        )
          return {
            state: "unknown",
            reason:
              "Retained CLI exit is unverified; owner process evidence is required.",
          };
      }
      if (!config.verify)
        return {
          state: "unknown",
          reason: "This connection has no read-only outcome verifier.",
        };
      return await this.credentials.use(
        connection,
        config,
        async (handle, _token, sanitizer) => {
          const signal = AbortSignal.any([
            AbortSignal.timeout(config.timeoutMs),
            ...(options.signal ? [options.signal] : []),
          ]);
          const result = await new Promise<VerificationResult>(
            (resolve, reject) => {
              const aborted = () =>
                resolve({
                  state: "unknown",
                  reason: "Read-only verification timed out or was cancelled.",
                });
              signal.addEventListener("abort", aborted, { once: true });
              if (signal.aborted) {
                aborted();
                return;
              }
              config.verify!(receipt, handle, { ...options, signal })
                .then(resolve, reject)
                .finally(() => signal.removeEventListener("abort", aborted));
            },
          );
          // Preserve the contract's discriminated union while sanitizing every string/data field.
          if (result.state === "executed")
            return {
              ...result,
              externalReference:
                result.externalReference === null
                  ? null
                  : sanitizer.text(result.externalReference),
              evidenceRef: sanitizer.text(result.evidenceRef),
              content: result.content.map((item) => {
                if (item.type === "text")
                  return { ...item, text: sanitizer.text(item.text) };
                if (item.type === "data")
                  return { ...item, value: sanitizer.value(item.value) };
                if (item.type === "image")
                  return {
                    ...item,
                    fileRef: sanitizer.text(item.fileRef),
                    caption:
                      item.caption === null
                        ? null
                        : sanitizer.text(item.caption),
                  };
                return {
                  ...item,
                  fileRef: sanitizer.text(item.fileRef),
                  name: sanitizer.text(item.name),
                  mediaType: sanitizer.text(item.mediaType),
                };
              }),
            };
          if (result.state === "not_executed")
            return {
              ...result,
              evidenceRef: sanitizer.text(result.evidenceRef),
              explanation: sanitizer.text(result.explanation),
            };
          return { state: "unknown", reason: sanitizer.text(result.reason) };
        },
      );
    } catch {
      return {
        state: "unknown",
        reason: "Read-only outcome verification is unavailable.",
      };
    }
  }

  private async discoverForCall(
    client: Client,
    connection: ServiceConnection,
    config: McpHttpConfiguration,
  ): Promise<ServiceCapability[]> {
    const tools: ServiceCapability[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, {
        timeout: config.timeoutMs,
      });
      for (const tool of page.tools)
        tools.push({
          id: capabilityId(connection.id, tool.name),
          connectionId: connection.id,
          upstreamName: tool.name,
          description: "",
          inputSchema: jsonObject(tool.inputSchema),
          outputSchema: null,
          verification: "unsupported",
        });
      cursor = page.nextCursor;
      if (tools.length > 500 || seen.size >= 20 || (cursor && seen.has(cursor)))
        throw new Error("Invalid upstream catalogue.");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return tools;
  }

  private async withMcp<T>(
    config: McpHttpConfiguration,
    token: string | null,
    action: (client: Client) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const url = assertHttpEndpoint(config.url, config.allowLoopbackHttp);
    const transport = new StreamableHTTPClientTransport(url, {
      // No SDK authProvider: it may automatically resend POST after OAuth. The broker alone retries.
      requestInit: {
        headers: token === null ? {} : { Authorization: `Bearer ${token}` },
        redirect: "error",
      },
      reconnectionOptions: {
        maxRetries: 0,
        maxReconnectionDelay: 1000,
        initialReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
      fetch: async (input, init) => {
        if (String(input) !== url.href)
          throw new Error("Unexpected upstream destination.");
        const response = await fetch(input, {
          ...init,
          redirect: "error",
          signal: AbortSignal.any([
            ...(init?.signal ? [init.signal] : []),
            ...(signal ? [signal] : []),
            AbortSignal.timeout(config.timeoutMs),
          ]),
        });
        if (!response.body) return response;
        let bytes = 0;
        const body = response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              bytes += chunk.byteLength;
              if (bytes > 512 * 1024)
                controller.error(
                  new Error("Upstream response exceeds supported bounds."),
                );
              else controller.enqueue(chunk);
            },
          }),
        );
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      },
    });
    const client = new Client(
      { name: "crew-service-gateway", version: "1.0.0" },
      { capabilities: {} },
    );
    try {
      await client.connect(transport, { timeout: config.timeoutMs, signal });
      return await action(client);
    } finally {
      await client.close().catch(() => {});
    }
  }

  private cliMarker(
    caller: BrokerInvocation["caller"],
    invocationId: string,
  ): string {
    return join(
      this.options.privateDirectory,
      `cli-${operationKey(caller, invocationId)}.json`,
    );
  }
  private async executeCli(
    config: CliConfiguration,
    invocation: BrokerInvocation,
    permit: ExecutionPermit,
    token: string | null,
    sanitizer: Sanitizer,
    dispatch: (
      action: () => Promise<ExecutorResult>,
    ) => Promise<ExecutorResult>,
    evidence: string,
    options: BrokerCallOptions,
  ): Promise<ExecutorResult> {
    const tool = config.operations.find(
      (item) =>
        capabilityId(invocation.operation.connectionId, item.name) ===
        invocation.operation.operation,
    );
    if (
      !tool ||
      normalizeArguments(tool.inputSchema, invocation.operation.arguments)
        .argumentsFingerprint !== invocation.operation.argumentsFingerprint
    )
      return noExecution("CLI operation or schema changed.", evidence);
    if (
      !isAbsolute(config.executable) ||
      !isAbsolute(config.cwd) ||
      sha256(await readFile(config.executable)) !== config.executableSha256 ||
      (await realpath(config.cwd)) !== config.cwd
    )
      return noExecution(
        "Trusted executable or directory validation failed.",
        evidence,
      );
    const mapped = tool.map(invocation.operation.arguments);
    if (
      !Array.isArray(mapped.argv) ||
      mapped.argv.some(
        (value) => typeof value !== "string" || value.includes("\0"),
      ) ||
      canonicalJson(mapped.argv).length > 32 * 1024 ||
      mapped.argv.some((value) => sanitizer.text(value) !== value)
    )
      return noExecution(
        "Invalid or credential-bearing CLI arguments.",
        evidence,
      );
    const environment = { ...config.environment };
    let stdin = mapped.stdin ?? "";
    if (config.credentialInput.type === "environment") {
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.credentialInput.name) ||
        token === null
      )
        return noExecution("CLI credential input is unavailable.", evidence);
      environment[config.credentialInput.name] = token;
    } else if (config.credentialInput.type === "stdin") {
      if (mapped.stdin !== undefined || token === null)
        return noExecution(
          "CLI stdin credential mapping is ambiguous.",
          evidence,
        );
      stdin = token;
    } else if (token !== null)
      return noExecution("CLI credential mapping is required.", evidence);
    if (Buffer.byteLength(stdin) > 128 * 1024)
      return noExecution("CLI input exceeds supported bounds.", evidence);
    const marker = this.cliMarker(
      invocation.caller,
      invocation.operation.invocationId,
    );
    await atomicJson(marker, { attemptId: permit.attemptId, state: "pending" });
    return dispatch(
      () =>
        new Promise<ExecutorResult>((resolve) => {
          const child = spawn(config.executable, mapped.argv, {
            cwd: config.cwd,
            env: environment,
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
          });
          const id = invocation.operation.invocationId;
          this.activeInvocationIds.add(id);
          const stdout: Buffer[] = [],
            stderr: Buffer[] = [];
          let outBytes = 0,
            errBytes = 0,
            overflow = false,
            cancelled = false,
            done = false;
          let grace: ReturnType<typeof setTimeout> | undefined;
          const finish = (result: ExecutorResult) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (grace) clearTimeout(grace);
            options.signal?.removeEventListener("abort", cancel);
            resolve(result);
          };
          const exited = async (result: ExecutorResult) => {
            try {
              await atomicJson(marker, {
                attemptId: permit.attemptId,
                state: "exited",
              });
              finish(result);
            } catch {
              finish({
                state: "uncertain",
                verificationRef: null,
                reason: "CLI exit could not be recorded durably.",
              });
            }
          };
          const cancel = () => {
            if (cancelled) return;
            cancelled = true;
            child.kill("SIGTERM"); // Cooperative signal to this owned child only; never force-kill.
            grace = setTimeout(
              () =>
                finish({
                  state: "uncertain",
                  verificationRef: null,
                  reason:
                    "CLI cancellation requested; execution/exit is unconfirmed.",
                }),
              500,
            );
          };
          const timer = setTimeout(cancel, config.timeoutMs);
          options.signal?.addEventListener("abort", cancel, { once: true });
          if (options.signal?.aborted) cancel();
          child.stdout.on("data", (chunk: Buffer) => {
            outBytes += chunk.length;
            if (outBytes <= 64 * 1024) stdout.push(chunk);
            else {
              overflow = true;
              cancel();
            }
          });
          child.stderr.on("data", (chunk: Buffer) => {
            errBytes += chunk.length;
            if (errBytes <= 64 * 1024) stderr.push(chunk);
            else {
              overflow = true;
              cancel();
            }
          });
          child.stdin.on("error", () => {});
          child.on("error", () => {
            if (child.pid === undefined) {
              this.activeInvocationIds.delete(id);
              void exited(
                noExecution("CLI process was not spawned.", evidence),
              );
            } else
              finish({
                state: "uncertain",
                verificationRef: null,
                reason: "CLI process observation failed.",
              });
          });
          child.on("close", (code, signal) => {
            this.activeInvocationIds.delete(id);
            if (cancelled || signal || overflow)
              return void exited({
                state: "uncertain",
                verificationRef: null,
                reason:
                  "CLI was interrupted or exceeded output limits; outcome needs verification.",
              });
            if (code !== 0)
              return void exited({
                state: "failed",
                externalReference: null,
                reason: `CLI exited ${code ?? "without a code"}: ${sanitizer.text(Buffer.concat(stderr).toString("utf8")).slice(0, 2000)}`,
              });
            void exited({
              state: "succeeded",
              externalReference: null,
              content: [
                {
                  type: "data",
                  value: {
                    stdout: sanitizer.text(
                      Buffer.concat(stdout).toString("utf8"),
                    ),
                    stderr: sanitizer.text(
                      Buffer.concat(stderr).toString("utf8"),
                    ),
                    exitCode: code,
                  },
                },
              ],
            });
          });
          child.stdin.end(stdin);
        }),
    );
  }
}
