import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CallerContext, JsonObject } from "./contracts.mjs";
import type { AgentFoundation } from "./foundation.mjs";
import { createFoundationAgentTools } from "./tools.mjs";
import {
  NativeTransportStore,
  type NativeToolReceipt,
} from "./transport-store.mjs";
import type { DurableOperationBroker } from "../gateway/broker.mjs";
import { createGatewayMcpServer } from "../gateway/mcp.mjs";
import { jsonObject, normalizeArguments } from "../gateway/json.mjs";

export interface AgentToolExtension {
  list(
    caller: CallerContext,
  ): Promise<{ name: string; description: string; inputSchema: JsonObject }[]>;
  /** The extension must check its own current Crew capabilities before action. */
  call(
    caller: CallerContext,
    name: string,
    arguments_: JsonObject,
  ): Promise<unknown>;
}
export interface NativeMcpBinding {
  bindingRef: string;
  foundationUrl: string;
  gatewayUrl: string;
  /** Trusted launch handoff only. Never serialize in owner/agent snapshots. */
  bearerToken: string;
}
type Channel = "foundation" | "gateway";
type Endpoint = {
  id: string;
  channel: Channel;
  transport: StreamableHTTPServerTransport;
  server: Server;
  requests: Map<string, NativeToolReceipt>;
};
type Binding = {
  caller: CallerContext;
  value: NativeMcpBinding;
  bearerDigest: Buffer;
  endpoints: Map<string, Endpoint>;
  revoked: boolean;
  observedState: string;
};
const callerKey = (caller: CallerContext) =>
  JSON.stringify([caller.projectId, caller.agentId, caller.sessionId]);
const requestKey = (id: string | number) => JSON.stringify(id);
const hash = (value: string) => createHash("sha256").update(value).digest();
const outcome = (
  text: string,
  receipt?: NativeToolReceipt,
  isError = true,
): CallToolResult => ({
  isError,
  ...(receipt
    ? {
        _meta: {
          "crew/invocationId": receipt.invocationId,
          "crew/state": receipt.state,
          "crew/resultReferences": receipt.resultReferences,
        },
      }
    : {}),
  content: [{ type: "text", text }],
});

/** One trusted host, with separate authenticated native capability endpoints.
 * Issuing a binding does not authorize tools, start a model turn or install config.
 * Only an exact current starting/started logical session can discover tools;
 * actual calls require current execution admission and domain authorization. */
export async function startAgentMcpHost(options: {
  privateDirectory: string;
  foundation: AgentFoundation;
  broker: DurableOperationBroker;
  additionalTools?: AgentToolExtension;
}) {
  const foundation = options.foundation;
  const projectId = foundation.store.snapshot().projectId;
  const store = await NativeTransportStore.open(
    options.privateDirectory,
    projectId,
  );
  const bindings = new Map<string, Binding>();
  const active = new Map<string, Promise<CallToolResult>>();
  let origin = "";
  let closed = false;
  let closeTask: Promise<void> | null = null;
  let httpClosed = false;
  let closeComplete = false;

  const current = (binding: Binding): boolean => {
    if (closed || binding.revoked) return false;
    const state = foundation.store.snapshot();
    const agent = state.agents.find(
      (entry) => entry.id === binding.caller.agentId,
    );
    return (
      state.projectId === binding.caller.projectId &&
      !!agent &&
      !agent.archivedAt &&
      agent.runtime.session.sessionId === binding.caller.sessionId &&
      agent.runtime.session.desiredState === "started" &&
      ["starting", "started"].includes(agent.runtime.session.observedState)
    );
  };
  const allowCall = (binding: Binding) =>
    current(binding) && foundation.executionAllowed(binding.caller);

  async function foundationServer(
    binding: Binding,
    endpoint: Endpoint,
  ): Promise<Server> {
    const tools = createFoundationAgentTools(foundation, binding.caller);
    const server = new Server(
      { name: "crew-agents", version: "1.0.0" },
      { capabilities: { tools: { listChanged: true } } },
    );
    const catalogue = async (): Promise<Tool[]> => {
      if (!current(binding))
        throw new Error("Authenticated Crew session required.");
      const native = tools.list();
      const extra = (await options.additionalTools?.list(binding.caller)) ?? [];
      const all = [...native, ...extra];
      if (new Set(all.map((entry) => entry.name)).size !== all.length)
        throw new Error("Duplicate Crew tool name.");
      return all.map((entry) => ({
        ...entry,
        inputSchema: { ...entry.inputSchema, type: "object" },
      }));
    };
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: await catalogue(),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      if (!allowCall(binding))
        return outcome(
          "Calling Crew session is unavailable or execution is reserved.",
        );
      const receipt = endpoint.requests.get(requestKey(extra.requestId));
      if (!receipt)
        return outcome(
          "Durable request correlation is unavailable; no tool was dispatched.",
        );
      const running = active.get(receipt.key);
      if (running) return running;
      const operation = (async () => {
        let attempted = false;
        try {
          const schema = (await catalogue()).find(
            (entry) => entry.name === request.params.name,
          );
          if (!schema)
            return outcome("Unknown Crew tool; no tool was dispatched.");
          const arguments_ = normalizeArguments(
            jsonObject(schema.inputSchema),
            request.params.arguments ?? {},
          ).arguments;
          const claim = await store.claim(receipt.key);
          if (!claim.dispatch)
            return outcome(
              claim.receipt.state === "completed"
                ? "This exact request already completed. Read the affected records using the retained result references; it was not repeated."
                : "The earlier outcome is uncertain. Inspect the retained state and reconcile it before issuing another mutation; this request was not repeated.",
              claim.receipt,
              claim.receipt.state !== "completed",
            );
          attempted = true;
          // Recheck after async catalogue/state persistence; native transport is not authority.
          if (!allowCall(binding))
            throw new Error("Session closed before dispatch.");
          const result = tools
            .list()
            .some((entry) => entry.name === request.params.name)
            ? await tools.call(request.params.name, arguments_)
            : await options.additionalTools!.call(
                binding.caller,
                request.params.name,
                arguments_,
              );
          await store.settle(receipt.key, "completed", result);
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(result ?? null) },
            ],
            _meta: {
              "crew/invocationId": receipt.invocationId,
              "crew/state": "completed",
            },
          };
        } catch {
          if (attempted)
            await store.settle(receipt.key, "uncertain", null).catch(() => {});
          return outcome(
            attempted
              ? "The Crew tool outcome could not be confirmed. Retain this invocation identity and inspect current state before another mutation."
              : "The Crew tool request was invalid or unavailable; no tool was dispatched.",
            receipt,
          );
        }
      })();
      active.set(receipt.key, operation);
      try {
        return await operation;
      } finally {
        active.delete(receipt.key);
      }
    });
    return server;
  }

  async function createEndpoint(
    binding: Binding,
    channel: Channel,
  ): Promise<Endpoint> {
    const id = randomUUID();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      enableJsonResponse: true,
      maxRequestBodySize: 256 * 1024,
      onsessionclosed: async () => {
        binding.endpoints.delete(id);
      },
    });
    const endpoint: Endpoint = {
      id,
      channel,
      transport,
      requests: new Map(),
      server: undefined!,
    };
    endpoint.server =
      channel === "foundation"
        ? await foundationServer(binding, endpoint)
        : createGatewayMcpServer({
            broker: options.broker,
            authenticatedCaller: async () =>
              current(binding) ? structuredClone(binding.caller) : null,
            invocationIdForRequest: async (requestId) => {
              if (!allowCall(binding))
                throw new Error("Current execution authority is required.");
              const receipt = endpoint.requests.get(requestKey(requestId));
              if (!receipt)
                throw new Error("Durable invocation identity missing.");
              return receipt.invocationId;
            },
          });
    endpoint.server.registerCapabilities({ tools: { listChanged: true } });
    await endpoint.server.connect(transport);
    binding.endpoints.set(id, endpoint);
    return endpoint;
  }

  function reply(response: ServerResponse, status: number, text: string) {
    if (response.headersSent) return response.end();
    response.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify({ error: text }));
  }
  async function body(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > 256 * 1024) throw new Error("Request exceeds its bound.");
      chunks.push(bytes);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  const http = createServer(async (request, response) => {
    try {
      if (
        closed ||
        request.headers.host !== new URL(origin).host ||
        (request.headers.origin !== undefined &&
          request.headers.origin !== origin) ||
        request.headers["sec-fetch-site"] === "cross-site"
      )
        return reply(
          response,
          403,
          "Same-host authenticated native transport required.",
        );
      const route = /^\/native\/([a-f0-9-]{36})\/(foundation|gateway)$/.exec(
        request.url ?? "",
      );
      const binding = route && bindings.get(route[1]);
      const authorization = request.headers.authorization;
      if (
        !binding ||
        !current(binding) ||
        typeof authorization !== "string" ||
        authorization.length > 128 ||
        !authorization.startsWith("Bearer ") ||
        !timingSafeEqual(hash(authorization.slice(7)), binding.bearerDigest)
      )
        return reply(
          response,
          401,
          "Authenticated current Crew session required.",
        );
      const channel = route![2] as Channel;
      if (!["GET", "POST", "DELETE"].includes(request.method ?? ""))
        return reply(response, 405, "Unsupported native transport method.");
      const sessionId = request.headers["mcp-session-id"];
      if (sessionId !== undefined && typeof sessionId !== "string")
        return reply(response, 400, "Invalid transport session identity.");
      let endpoint =
        typeof sessionId === "string"
          ? binding.endpoints.get(sessionId)
          : undefined;
      let parsed: unknown;
      if (request.method === "POST") {
        if (!request.headers["content-type"]?.startsWith("application/json"))
          return reply(response, 415, "JSON native transport required.");
        parsed = await body(request);
      }
      if (!endpoint) {
        if (sessionId !== undefined)
          return reply(
            response,
            404,
            "Native transport session is no longer available.",
          );
        if (request.method !== "POST" || !isInitializeRequest(parsed))
          return reply(response, 400, "Initialize the native transport first.");
        if (binding.endpoints.size >= 8)
          return reply(
            response,
            429,
            "Native transport session bound reached.",
          );
        endpoint = await createEndpoint(binding, channel);
      }
      if (endpoint.channel !== channel)
        return reply(response, 403, "Transport channel does not match.");
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        "method" in parsed &&
        parsed.method === "tools/call"
      ) {
        if (!allowCall(binding))
          return reply(
            response,
            409,
            "Crew session is not ready for tool execution.",
          );
        const toolRequest = CallToolRequestSchema.parse(parsed);
        if (
          !("id" in parsed) ||
          (typeof parsed.id !== "string" && typeof parsed.id !== "number")
        )
          return reply(
            response,
            400,
            "A correlated request identity is required.",
          );
        const receipt = await store.identify(
          {
            caller: binding.caller,
            channel,
            transportId: endpoint.id,
            requestId: parsed.id,
          },
          jsonObject({
            name: toolRequest.params.name,
            arguments: toolRequest.params.arguments ?? {},
            invocationId:
              toolRequest.params._meta?.["crew/invocationId"] ?? null,
          }),
        );
        endpoint.requests.set(requestKey(parsed.id), receipt);
      }
      await endpoint.transport.handleRequest(request, response, parsed);
    } catch {
      reply(
        response,
        400,
        "Native transport request could not be validated or completed. Retain uncertain invocation identities.",
      );
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(0, "127.0.0.1", resolve);
    });
  } catch (failure) {
    await store.close();
    throw failure;
  }
  const address = http.address();
  if (!address || typeof address === "string")
    throw new Error("Native transport did not bind loopback.");
  origin = `http://127.0.0.1:${address.port}`;
  const refreshTools = async () => {
    await Promise.allSettled(
      [...bindings.values()]
        .filter(current)
        .flatMap((binding) =>
          [...binding.endpoints.values()].map((endpoint) =>
            endpoint.server.sendToolListChanged(),
          ),
        ),
    );
  };
  const unsubscribe = foundation.store.subscribe(() => {
    let changed = false;
    for (const binding of bindings.values()) {
      const state =
        foundation.store
          .snapshot()
          .agents.find((agent) => agent.id === binding.caller.agentId)?.runtime
          .session.observedState ?? "missing";
      if (state !== binding.observedState) {
        binding.observedState = state;
        changed = true;
      }
    }
    if (changed) void refreshTools();
  });
  const revoke = async (caller: CallerContext) => {
    const matching = [...bindings.values()].filter(
      (binding) => callerKey(binding.caller) === callerKey(caller),
    );
    for (const binding of matching) {
      binding.revoked = true;
      binding.value.bearerToken = "";
      await Promise.allSettled(
        [...binding.endpoints.values()].map((endpoint) =>
          endpoint.server.close(),
        ),
      );
      binding.endpoints.clear();
      bindings.delete(binding.value.bindingRef);
    }
  };
  return {
    async bind(caller: CallerContext): Promise<NativeMcpBinding> {
      const existing = [...bindings.values()].find(
        (binding) => callerKey(binding.caller) === callerKey(caller),
      );
      if (existing && current(existing)) return { ...existing.value };
      const bindingRef = randomUUID();
      const bearerToken = randomBytes(32).toString("base64url");
      const value: NativeMcpBinding = {
        bindingRef,
        bearerToken,
        foundationUrl: `${origin}/native/${bindingRef}/foundation`,
        gatewayUrl: `${origin}/native/${bindingRef}/gateway`,
      };
      const binding: Binding = {
        caller: structuredClone(caller),
        value,
        bearerDigest: hash(bearerToken),
        endpoints: new Map(),
        revoked: false,
        observedState: "starting",
      };
      if (!current(binding))
        throw new Error(
          "Native binding requires the exact current logical session.",
        );
      bindings.set(bindingRef, binding);
      return { ...value };
    },
    resolve(
      bindingRef: string,
      caller: CallerContext,
    ): NativeMcpBinding | null {
      const binding = bindings.get(bindingRef);
      return binding &&
        current(binding) &&
        callerKey(binding.caller) === callerKey(caller)
        ? { ...binding.value }
        : null;
    },
    revoke,
    refreshTools,
    async close() {
      if (closeComplete) return;
      if (closeTask) return closeTask;
      closed = true;
      const operation = (async () => {
        unsubscribe();
        await Promise.allSettled(
          [...bindings.values()].map((binding) => revoke(binding.caller)),
        );
        await Promise.allSettled([...active.values()]);
        if (!httpClosed) {
          await new Promise<void>((resolve, reject) =>
            http.close((failure) => (failure ? reject(failure) : resolve())),
          );
          httpClosed = true;
        }
        await store.close();
        closeComplete = true;
      })();
      closeTask = operation;
      try {
        await operation;
      } finally {
        if (closeTask === operation) closeTask = null;
      }
    },
  };
}

export type AgentMcpHost = Awaited<ReturnType<typeof startAgentMcpHost>>;
