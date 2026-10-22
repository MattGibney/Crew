import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type {
  CallerContext,
  ConfigurationSnapshot,
  RuntimeAccessBinding,
  RuntimeAccessProvider,
  RuntimeBinding,
  RuntimeError,
  RuntimeIsolationResult,
  RuntimeStartInput,
  Skill,
} from "../agents/contracts.mjs";
import {
  CodexPeer,
  object,
  record,
  type CodexLaunch,
} from "../agents/codex-peer.mjs";
import type { CodexLaunchResolution } from "../agents/codex-runtime.mjs";
import {
  boundedProcess,
  nativeSeatbeltPolicy,
  openModelEgress,
  verifyNativeBoundary,
} from "./native-boundary.mjs";

export interface NativeGatewayBinding {
  /** Service gateway endpoint. Both endpoints come from one authenticated host. */
  url: string;
  foundationUrl: string;
  bearerToken: string;
  bindingRef: string;
  release(): Promise<void>;
}
export interface CodexRuntimeAccessOptions {
  directory: string;
  projectId: string;
  executable: string;
  runtimeConfigRef?: string;
  gatewayFor(caller: CallerContext): Promise<NativeGatewayBinding>;
  resolveSkills(
    skills: Skill[],
  ): Promise<{ id: string; revision: number; nativePath: string }[]>;
}
export type SubscriptionStatus =
  | { state: "signed_in"; plan: string | null }
  | { state: "sign_in_required" }
  | { state: "blocked"; reason: string };
const key = (caller: CallerContext) =>
  JSON.stringify([caller.projectId, caller.agentId, caller.sessionId]);
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const FEATURES = [
  "shell_tool",
  "unified_exec",
  "shell_snapshot",
  "js_repl",
  "multi_agent",
  "apps",
  "plugins",
  "remote_plugin",
  "remote_control",
  "hooks",
  "memories",
  "browser_use",
  "computer_use",
  "image_generation",
];
const blocked = (reason: string): RuntimeIsolationResult => ({
  state: "blocked",
  reason,
  limitations: [
    "Native access is restricted to Crew-brokered tools. Actual project work requires the separately authorized environment executor; chat and broker access alone do not establish usable project work.",
    "Owner ChatGPT sign-in in Crew's separate native home is required. Personal authentication is never copied.",
  ],
});
// A failed open must not lose the only guard against launching another process
// against the same native home. Entries disappear only on a confirmed exit.
const unconfirmedNativePeers = new Map<string, Set<CodexPeer>>();
const pendingExitMessage =
  "An owned native process has not confirmed exit. Further native launches are blocked until it exits; Crew has not force-stopped it.";

type Bound = {
  binding: RuntimeAccessBinding;
  configurationHash: string;
  launch: CodexLaunch;
  skills: { id: string; revision: number; nativePath: string }[];
  gateway: NativeGatewayBinding;
};

/** Concrete macOS process containment. No boolean/callback can attest readiness.
 * Actual native config/account reads and synthetic boundary probes must succeed.
 * Owner sign-in is explicit. The environment executor is a separate boundary. */
export class CodexRuntimeAccessProvider implements RuntimeAccessProvider {
  private options: CodexRuntimeAccessOptions | null = null;
  private root = "";
  private binary = "";
  private egress: Awaited<ReturnType<typeof openModelEgress>> | null = null;
  private bindings = new Map<string, Bound>();
  private releasedSessions = new Set<string>();
  private signing: { peer: CodexPeer; loginId: string | null } | null = null;
  private signInStarting = false;
  private signInGeneration = 0;
  private signInStartDone: Promise<void> | null = null;
  private signInCancelTask: Promise<void> | null = null;
  private readonly ownedPeers = new Set<CodexPeer>();
  private readonly stoppingPeers = new Set<CodexPeer>();
  private readonly peerStops = new Map<CodexPeer, Promise<void>>();
  private closeTask: Promise<void> | null = null;
  private closed = false;
  private tail: Promise<unknown> = Promise.resolve();
  // Empty construction remains safely blocked for callers awaiting configuration.
  constructor() {}
  static async open(
    options: CodexRuntimeAccessOptions,
  ): Promise<CodexRuntimeAccessProvider> {
    if (process.platform !== "darwin")
      throw new Error("The current native boundary requires macOS.");
    if (
      !isAbsolute(options.directory) ||
      !isAbsolute(options.executable) ||
      !options.projectId
    )
      throw new Error("Trusted absolute native paths are required.");
    const result = new CodexRuntimeAccessProvider();
    result.options = options;
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(options.directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.mode & 0o077 ||
      stat.uid !== process.getuid?.()
    )
      throw new Error("Native home must be private and controller owned.");
    result.root = await realpath(options.directory);
    if (unconfirmedNativePeers.get(result.root)?.size)
      throw new Error(pendingExitMessage);
    if (
      result.root === homedir() ||
      result.root === join(homedir(), ".codex") ||
      homedir().startsWith(result.root + "/")
    )
      throw new Error("Personal home cannot be the Crew native boundary.");
    result.binary = await realpath(options.executable);
    const binary = await lstat(result.binary);
    if (!binary.isFile() || binary.mode & 0o022)
      throw new Error(
        "Codex executable must be trusted and not writable by other users.",
      );
    const marker = join(result.root, "crew-native.json");
    const expected = JSON.stringify({
      version: 1,
      projectId: options.projectId,
      policy: "macos-broker-only-v1",
    });
    try {
      const file = await open(
        marker,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        if ((await file.readFile("utf8")) !== expected)
          throw new Error("Native home belongs to another project or policy.");
      } finally {
        await file.close();
      }
    } catch (error) {
      if (!(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
      if ((await readdir(result.root)).length)
        throw new Error(
          "Choose an empty Crew native home; existing files are not imported.",
        );
      await writeFile(marker, expected, { flag: "wx", mode: 0o600 });
    }
    for (const directory of ["home", "codex", "tmp", "workspace", "policies"])
      await mkdir(join(result.root, directory), {
        recursive: true,
        mode: 0o700,
      });
    result.egress = await openModelEgress();
    try {
      const launch = await result.launch("owner", null, []);
      await verifyNativeBoundary(launch.args[1]!, result.root, launch.env);
      const version = await boundedProcess(
        launch.executable,
        ["-f", launch.args[1]!, result.binary, "--version"],
        launch.env,
        launch.cwd,
      );
      if (
        version.code !== 0 ||
        version.stdout.trim() !== "codex-cli 0.163.0-alpha.11"
      )
        throw new Error(
          "This Codex version has not passed the native policy contract; validate it before use.",
        );
      const peer = await result.peer(launch);
      try {
        await result.verifyConfiguration(peer, null);
      } finally {
        await result.stopPeer(peer);
      }
      await writeFile(
        join(result.root, "boundary-evidence.json"),
        JSON.stringify({
          checkedAt: new Date().toISOString(),
          nativeVersion: version.stdout.trim(),
          policy: "macos-broker-only-v1",
          checks: [
            "owned-file-read",
            "outside-file-denied",
            "descendant-denied",
            "other-process-denied",
            "keychain-denied",
            "host-tcp-denied",
            "host-unix-socket-denied",
            "native-config-verified",
          ],
        }),
        { mode: 0o600 },
      );
      return result;
    } catch (error) {
      await result.close();
      throw error;
    }
  }
  private async launch(
    label: string,
    gateway: NativeGatewayBinding | null,
    skills: Bound["skills"],
  ): Promise<CodexLaunch> {
    this.assertLaunchable();
    if (!this.options || !this.egress)
      throw new Error("Native boundary is unavailable.");
    const ports = [this.egress.port];
    if (gateway) {
      for (const endpoint of [gateway.url, gateway.foundationUrl]) {
        const url = new URL(endpoint);
        if (
          url.protocol !== "http:" ||
          url.hostname !== "127.0.0.1" ||
          !url.port ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          !gateway.bearerToken ||
          !gateway.bindingRef
        )
          throw new Error(
            "Trusted authenticated loopback Crew endpoints are required.",
          );
        if (!ports.includes(Number(url.port))) ports.push(Number(url.port));
      }
      if (gateway.url === gateway.foundationUrl)
        throw new Error(
          "Foundation and service gateway endpoints must be distinct.",
        );
    }
    const readRoots: string[] = [];
    for (const skill of skills) {
      if (
        !isAbsolute(skill.nativePath) ||
        (await realpath(skill.nativePath)) !== skill.nativePath ||
        !skill.nativePath.endsWith("/SKILL.md")
      )
        throw new Error("Selected skills need exact immutable native paths.");
      const root = dirname(skill.nativePath);
      if (
        root === homedir() ||
        root.startsWith(join(homedir(), ".codex") + "/") ||
        root.startsWith(join(homedir(), ".ssh") + "/")
      )
        throw new Error("Personal skill roots are not permitted.");
      readRoots.push(root);
    }
    const profile = join(
      this.root,
      "policies",
      `${hash([label, ports, readRoots])}.sb`,
    );
    await writeFile(
      profile,
      nativeSeatbeltPolicy({
        root: this.root,
        executable: this.binary,
        ports,
        readRoots,
      }),
      { mode: 0o600 },
    );
    const overrides = [
      'cli_auth_credentials_store="file"',
      'mcp_oauth_credentials_store="file"',
      'forced_login_method="chatgpt"',
      'sandbox_mode="read-only"',
      'approval_policy="on-request"',
      'web_search="disabled"',
      "allow_login_shell=false",
      'shell_environment_policy.inherit="none"',
      "features.code_mode.enabled=false",
      "include_apps_instructions=false",
      ...FEATURES.map((feature) => `features.${feature}=false`),
      "mcp_servers={}",
      "plugins={}",
      "marketplaces={}",
    ];
    if (gateway) {
      for (const [name, url] of Object.entries({
        crew: gateway.foundationUrl,
        services: gateway.url,
      }))
        overrides.push(
          `mcp_servers.${name}.url=${JSON.stringify(url)}`,
          `mcp_servers.${name}.bearer_token_env_var="CREW_SESSION_TOKEN"`,
          `mcp_servers.${name}.required=true`,
        );
    }
    const env: Record<string, string> = {
      PATH: "/usr/bin:/bin",
      HOME: join(this.root, "home"),
      CODEX_HOME: join(this.root, "codex"),
      // Native TLS must not depend on personal keychain access inside Seatbelt.
      // Codex supports this explicit public system CA bundle for login/model TLS.
      CODEX_CA_CERTIFICATE: "/private/etc/ssl/cert.pem",
      CFFIXED_USER_HOME: join(this.root, "home"),
      TMPDIR: join(this.root, "tmp"),
      HTTPS_PROXY: `http://127.0.0.1:${this.egress.port}`,
      HTTP_PROXY: `http://127.0.0.1:${this.egress.port}`,
      ALL_PROXY: `http://127.0.0.1:${this.egress.port}`,
      NO_PROXY: "127.0.0.1",
      LANG: "en_US.UTF-8",
    };
    if (gateway) env.CREW_SESSION_TOKEN = gateway.bearerToken;
    this.assertLaunchable();
    return {
      executable: "/usr/bin/sandbox-exec",
      args: [
        "-f",
        profile,
        this.binary,
        "app-server",
        "--listen",
        "stdio://",
        ...overrides.flatMap((value) => ["-c", value]),
      ],
      cwd: join(this.root, "workspace"),
      env,
    };
  }
  private assertLaunchable(): void {
    if (this.closed) throw new Error("Native boundary is closed.");
    if (this.stoppingPeers.size || unconfirmedNativePeers.get(this.root)?.size)
      throw new Error(pendingExitMessage);
  }
  private trackPeer(peer: CodexPeer): void {
    if (this.ownedPeers.has(peer)) return;
    this.ownedPeers.add(peer);
    void peer.exited.then(() => {
      this.ownedPeers.delete(peer);
      this.stoppingPeers.delete(peer);
      const retained = unconfirmedNativePeers.get(this.root);
      retained?.delete(peer);
      if (retained?.size === 0) unconfirmedNativePeers.delete(this.root);
      if (this.signing?.peer === peer) this.signing = null;
    });
  }
  private stopPeer(peer: CodexPeer): Promise<void> {
    const existing = this.peerStops.get(peer);
    if (existing) return existing;
    this.trackPeer(peer);
    this.stoppingPeers.add(peer);
    const operation = (async () => {
      let confirmed = false;
      try {
        confirmed = await peer.close();
      } catch {
        /* Preserve ownership. */
      }
      if (!confirmed && this.ownedPeers.has(peer)) {
        const retained =
          unconfirmedNativePeers.get(this.root) ?? new Set<CodexPeer>();
        retained.add(peer);
        unconfirmedNativePeers.set(this.root, retained);
        throw new Error(pendingExitMessage);
      }
      this.ownedPeers.delete(peer);
      this.stoppingPeers.delete(peer);
      if (this.signing?.peer === peer) this.signing = null;
    })();
    this.peerStops.set(peer, operation);
    void operation.finally(() => this.peerStops.delete(peer)).catch(() => {});
    return operation;
  }
  private async peer(launch: CodexLaunch): Promise<CodexPeer> {
    this.assertLaunchable();
    const peer = new CodexPeer(
      launch,
      () => {},
      () => {},
      15_000,
    );
    this.trackPeer(peer);
    try {
      await peer.rpc("initialize", {
        clientInfo: {
          name: "crew_native_access",
          title: "Crew",
          version: "0.18.0",
        },
        capabilities: { experimentalApi: true },
      });
      peer.send({ method: "initialized", params: {} });
      return peer;
    } catch {
      await this.stopPeer(peer);
      throw new Error("Native access initialization failed.");
    }
  }
  private async verifyConfiguration(
    peer: CodexPeer,
    gateway: NativeGatewayBinding | null,
  ): Promise<void> {
    const response = record(
      await peer.rpc("config/read", { includeLayers: true }),
    );
    const config = record(response.config);
    const features = record(config.features);
    if (
      FEATURES.some((feature) => features[feature] !== false) ||
      config.forced_login_method !== "chatgpt" ||
      config.cli_auth_credentials_store !== "file" ||
      config.web_search !== "disabled" ||
      config.allow_login_shell !== false
    )
      throw new Error(
        "Native configuration did not retain the broker-only restrictions.",
      );
    const servers = record(config.mcp_servers);
    if (
      Object.keys(servers).sort().join(",") !== (gateway ? "crew,services" : "")
    )
      throw new Error("Unexpected native MCP configuration.");
    if (gateway) {
      for (const [name, url] of Object.entries({
        crew: gateway.foundationUrl,
        services: gateway.url,
      })) {
        const server = record(servers[name]);
        if (
          server.url !== url ||
          server.bearer_token_env_var !== "CREW_SESSION_TOKEN" ||
          server.required !== true
        )
          throw new Error("Crew native endpoint binding changed.");
      }
    }
    for (const field of ["plugins", "marketplaces", "model_providers"])
      if (Object.keys(record(config[field] ?? {})).length)
        throw new Error("Unexpected native provider/plugin configuration.");
    if (config.model_provider !== null && config.model_provider !== "openai")
      throw new Error("Only native subscription access is permitted.");
  }
  async subscriptionStatus(): Promise<SubscriptionStatus> {
    try {
      const peer = await this.peer(await this.launch("owner", null, []));
      try {
        await this.verifyConfiguration(peer, null);
        const response = record(
          await peer.rpc("account/read", { refreshToken: false }),
        );
        if (object(response.account) && response.account.type === "chatgpt") {
          await this.cancelSignIn();
          return {
            state: "signed_in",
            plan:
              typeof response.account.planType === "string"
                ? response.account.planType
                : null,
          };
        }
        return response.account === null
          ? { state: "sign_in_required" }
          : {
              state: "blocked",
              reason:
                "Crew requires native ChatGPT subscription sign-in, without an API-key fallback.",
            };
      } finally {
        await this.stopPeer(peer);
      }
    } catch {
      return {
        state: "blocked",
        reason:
          this.stoppingPeers.size || unconfirmedNativePeers.get(this.root)?.size
            ? pendingExitMessage
            : "Crew could not verify its isolated native subscription configuration.",
      };
    }
  }
  /** Mount only on authenticated owner ingress, invoked by explicit owner action. */
  async beginSignIn(): Promise<{
    loginId: string;
    verificationUrl: string;
    userCode: string;
  }> {
    this.assertLaunchable();
    if (this.signing || this.signInStarting || this.signInCancelTask)
      throw new Error("A Crew sign-in or cancellation is already pending.");
    this.signInStarting = true;
    let finishStarting!: () => void;
    const started = new Promise<void>((resolve) => {
      finishStarting = resolve;
    });
    this.signInStartDone = started;
    const generation = ++this.signInGeneration;
    let peer: CodexPeer | null = null;
    try {
      peer = await this.peer(await this.launch("owner", null, []));
      if (this.closed || generation !== this.signInGeneration)
        throw new Error("Crew sign-in was cancelled.");
      this.signing = { peer, loginId: null };
      await this.verifyConfiguration(peer, null);
      const login = record(
        await peer.rpc("account/login/start", { type: "chatgptDeviceCode" }),
      );
      if (
        login.type !== "chatgptDeviceCode" ||
        typeof login.loginId !== "string" ||
        typeof login.userCode !== "string" ||
        login.verificationUrl !== "https://auth.openai.com/codex/device"
      )
        throw new Error("Unsupported native sign-in response.");
      if (
        this.closed ||
        generation !== this.signInGeneration ||
        this.signing?.peer !== peer
      )
        throw new Error("Crew sign-in was cancelled.");
      this.signing.loginId = login.loginId;
      return {
        loginId: login.loginId,
        verificationUrl: login.verificationUrl,
        userCode: login.userCode,
      };
    } catch {
      if (peer) await this.stopPeer(peer);
      if (
        this.stoppingPeers.size ||
        unconfirmedNativePeers.get(this.root)?.size
      )
        throw new Error(pendingExitMessage);
      throw new Error(
        "Native device sign-in could not start. Check network access and try again.",
      );
    } finally {
      this.signInStarting = false;
      if (this.signInStartDone === started) this.signInStartDone = null;
      finishStarting();
    }
  }
  async cancelSignIn(): Promise<void> {
    if (this.signInCancelTask) return this.signInCancelTask;
    const operation = (async () => {
      this.signInGeneration++;
      const starting = this.signInStartDone;
      const signing = this.signing;
      if (signing) {
        try {
          if (signing.loginId)
            await signing.peer.rpc("account/login/cancel", {
              loginId: signing.loginId,
            });
        } catch {
          /* Cancellation response is not process-exit evidence. */
        }
        // Preserve the reference until stopPeer observes exit; a false result is
        // retained and blocks duplicate sign-in even when the RPC was accepted.
        await this.stopPeer(signing.peer);
      }
      // Cancellation during initial RPC setup must wait for that exact attempt
      // to notice its generation and close its peer before allowing a new one.
      if (starting) await starting;
      if (
        this.stoppingPeers.size ||
        unconfirmedNativePeers.get(this.root)?.size
      )
        throw new Error(pendingExitMessage);
    })();
    this.signInCancelTask = operation;
    try {
      await operation;
    } finally {
      if (this.signInCancelTask === operation) this.signInCancelTask = null;
    }
  }
  async prepare(
    caller: CallerContext,
    configuration: ConfigurationSnapshot,
  ): Promise<RuntimeIsolationResult> {
    const operation = this.tail.then(
      async (): Promise<RuntimeIsolationResult> => {
        if (
          this.stoppingPeers.size ||
          unconfirmedNativePeers.get(this.root)?.size
        )
          return blocked(pendingExitMessage);
        if (
          !this.options ||
          this.closed ||
          this.releasedSessions.has(key(caller)) ||
          caller.projectId !== this.options.projectId
        )
          return blocked(
            "A verified active Crew native access boundary is required.",
          );
        if (
          configuration.runtimeConfig.id !==
          (this.options.runtimeConfigRef ?? "crew.codex.broker-only.v1")
        )
          return blocked(
            "The selected runtime policy is not supported by this boundary.",
          );
        const existing = this.bindings.get(key(caller));
        if (existing)
          return existing.configurationHash === hash(configuration)
            ? {
                state: "ready",
                runtimeAccess: structuredClone(existing.binding),
                checkedAt: new Date().toISOString(),
                evidenceRef: `native-boundary:${hash(existing.binding)}`,
              }
            : blocked(
                "Prepared configuration changed; release it before preparing again.",
              );
        const status = await this.subscriptionStatus();
        if (status.state !== "signed_in")
          return blocked(
            status.state === "blocked"
              ? status.reason
              : "Sign in to ChatGPT in Crew Subscription settings. This uses a separate native home and does not copy personal Codex sign-in.",
          );
        let gateway: NativeGatewayBinding | null = null;
        try {
          const skills = await this.options.resolveSkills(configuration.skills);
          if (
            skills.length !== configuration.skills.length ||
            configuration.skills.some(
              (skill) =>
                !skills.some(
                  (item) =>
                    item.id === skill.id && item.revision === skill.revision,
                ),
            )
          )
            throw new Error("Selected skill revisions unavailable.");
          gateway = await this.options.gatewayFor(caller);
          const launch = await this.launch(key(caller), gateway, skills);
          await verifyNativeBoundary(launch.args[1]!, this.root, launch.env);
          const peer = await this.peer(launch);
          try {
            await this.verifyConfiguration(peer, gateway);
          } finally {
            await this.stopPeer(peer);
          }
          const binding: RuntimeAccessBinding = {
            caller: structuredClone(caller),
            environmentPolicies: [],
            runtimeConfigRef: configuration.runtimeConfig.id,
            privateWorkspaceRef: `native-workspace:${randomUUID()}`,
            brokerBindingRef: gateway.bindingRef,
          };
          if (this.closed || this.releasedSessions.has(key(caller)))
            throw new Error("Native session was closed during preparation.");
          this.bindings.set(key(caller), {
            binding,
            configurationHash: hash(configuration),
            launch,
            skills,
            gateway,
          });
          return {
            state: "ready",
            runtimeAccess: structuredClone(binding),
            checkedAt: new Date().toISOString(),
            evidenceRef: `native-boundary:${hash(binding)}`,
          };
        } catch {
          await gateway?.release();
          return blocked(
            "Native access preparation failed. No runtime launch was authorized.",
          );
        }
      },
    );
    this.tail = operation.catch(() => {});
    return operation;
  }
  readonly resolveLaunch = async (
    input: RuntimeStartInput,
  ): Promise<CodexLaunchResolution> => {
    const bound = this.bindings.get(key(input.caller));
    if (
      this.closed ||
      this.stoppingPeers.size > 0 ||
      Boolean(unconfirmedNativePeers.get(this.root)?.size) ||
      this.releasedSessions.has(key(input.caller)) ||
      !bound ||
      hash(input.access) !== hash(bound.binding) ||
      hash(input.configuration) !== bound.configurationHash
    )
      return {
        state: "blocked",
        error: {
          code: "isolation_blocked",
          message:
            "No exact prepared native access binding exists for this session.",
        },
      };
    return {
      state: "ready",
      launch: structuredClone(bound.launch),
      skills: structuredClone(bound.skills),
    };
  };
  /** Trusted host-only retained-history launch. The host must first match this
   * binding against its durable agent/thread record. No service session is reopened. */
  readonly resolveHistoryLaunch = async (
    binding: RuntimeBinding,
  ): Promise<
    | { state: "ready"; launch: CodexLaunch }
    | { state: "blocked"; error: RuntimeError }
  > => {
    if (
      !this.options ||
      this.closed ||
      binding.projectId !== this.options.projectId ||
      !binding.agentId ||
      !binding.threadId ||
      !binding.sessionId
    )
      return {
        state: "blocked",
        error: {
          code: "identity_mismatch",
          message:
            "Retained history requires a matching Crew project identity.",
        },
      };
    try {
      return {
        state: "ready",
        launch: await this.launch(`history:${key(binding)}`, null, []),
      };
    } catch {
      return {
        state: "blocked",
        error: {
          code: "isolation_blocked",
          message: "The isolated native history launch is unavailable.",
        },
      };
    }
  };
  async release(caller: CallerContext): Promise<void> {
    this.releasedSessions.add(key(caller));
    const bound = this.bindings.get(key(caller));
    await bound?.gateway.release();
    this.bindings.delete(key(caller));
  }
  async close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closed = true;
    const operation = (async () => {
      let accessCleanupFailed = false;
      // Revoke transport access even if a native process refuses to exit. Every
      // cleanup is attempted; an early failure must not leave model egress open.
      const cleanup = [
        ...[...this.bindings.entries()].map(async ([id, bound]) => {
          try {
            await bound.gateway.release();
            this.bindings.delete(id);
          } catch {
            accessCleanupFailed = true;
          }
        }),
        (async () => {
          const egress = this.egress;
          if (!egress) return;
          try {
            await egress.close();
            if (this.egress === egress) this.egress = null;
          } catch {
            accessCleanupFailed = true;
          }
        })(),
        this.cancelSignIn(),
        ...[...this.ownedPeers].map((peer) => this.stopPeer(peer)),
      ];
      await Promise.allSettled(cleanup);
      await this.tail;
      // A preparation already awaiting gateway creation will have noticed closed
      // and released that binding. Revisit any peer still awaiting confirmed exit.
      await Promise.allSettled(
        [...this.ownedPeers].map((peer) => this.stopPeer(peer)),
      );
      if (
        this.ownedPeers.size ||
        this.stoppingPeers.size ||
        unconfirmedNativePeers.get(this.root)?.size
      )
        throw new Error(pendingExitMessage);
      if (accessCleanupFailed)
        throw new Error(
          "Native shutdown could not confirm all tool and model transport cleanup.",
        );
    })();
    this.closeTask = operation;
    try {
      await operation;
    } finally {
      if (this.closeTask === operation) this.closeTask = null;
    }
  }
}
