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
  CodexRpcError,
  object,
  record,
  type CodexEnvelope,
  type CodexLaunch,
} from "../agents/codex-peer.mjs";
import type { CodexLaunchResolution } from "../agents/codex-runtime.mjs";
import { readCodexSubscriptionUsage } from "../agents/codex-usage-reader.mjs";
import type { SubscriptionUsageSnapshot } from "../agents/codex-usage.mjs";
import type { RuntimeResult } from "../agents/contracts.mjs";
import { boundedProcess, openModelEgress } from "./native-boundary.mjs";

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
  /** Trusted managed-skill store: verify the exact revision and all resource
   * manifests on every call. Called again immediately before native launch. */
  resolveSkills(
    skills: Skill[],
  ): Promise<{ id: string; revision: number; nativePath: string }[]>;
}
type SignInStage =
  | "initialization"
  | "configuration"
  | "request"
  | "response"
  | "completion"
  | "transport";
export type SubscriptionSignInStatus =
  | { state: "pending"; reason: null }
  | {
      state: "failed";
      reason: string;
      stage: SignInStage;
      code: number | null;
    };
export type SubscriptionStatus =
  | { state: "signed_in"; plan: string | null }
  | { state: "sign_in_required"; signIn?: SubscriptionSignInStatus }
  | { state: "blocked"; reason: string };
function validBrowserAuthorizationUrl(value: string): boolean {
  if (value.length > 4096) return false;
  try {
    const url = new URL(value);
    if (
      url.origin !== "https://auth.openai.com" ||
      url.username ||
      url.password ||
      url.hash
    )
      return false;
    const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
    return (
      redirect.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname) &&
      redirect.port === "1455" &&
      redirect.pathname === "/auth/callback" &&
      !redirect.username &&
      !redirect.password &&
      !redirect.search &&
      !redirect.hash
    );
  } catch {
    return false;
  }
}
const signInFailure = (
  stage: SignInStage,
  error?: unknown,
): SubscriptionSignInStatus => ({
  state: "failed",
  stage,
  // Never expose arbitrary native error text: it can include auth response data.
  code:
    error instanceof CodexRpcError && Number.isSafeInteger(error.code)
      ? error.code
      : null,
  reason: {
    initialization:
      "Crew could not initialize its native sign-in process. Try again.",
    configuration: "Crew could not verify the isolated sign-in configuration.",
    request:
      "The native browser sign-in request failed. Check network access and try again.",
    response:
      "Native sign-in returned an unsupported response. No sign-in link was accepted.",
    completion:
      "Crew could not confirm successful native sign-in. Start a new sign-in attempt.",
    transport:
      "The native sign-in connection ended before completion. Start a new sign-in attempt.",
  }[stage],
});
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
  nativePermissions: { profileId: string; approvalPolicy: "never" };
};

/** The pinned native host is trusted with its own subscription authentication.
 * Native named permissions constrain model tools; they do not sandbox host RPCs.
 * Owner sign-in is explicit. The environment executor is a separate boundary. */
export class CodexRuntimeAccessProvider implements RuntimeAccessProvider {
  private options: CodexRuntimeAccessOptions | null = null;
  private root = "";
  private binary = "";
  private readonly storageIdentities = new Map<string, string>();
  private egress: Awaited<ReturnType<typeof openModelEgress>> | null = null;
  private bindings = new Map<string, Bound>();
  private releasedSessions = new Set<string>();
  private signing: {
    peer: CodexPeer;
    loginId: string | null;
    generation: number;
    completed: boolean;
  } | null = null;
  private signInStatus: SubscriptionSignInStatus | null = null;
  private signInCompletedGeneration: number | null = null;
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
    result.storageIdentities.set(result.root, `${stat.dev}:${stat.ino}`);
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
    // The marker above remains storage identity for existing Crew auth homes;
    // policy evidence below is separate and never imports or resets credentials.
    for (const directory of ["home", "codex", "tmp", "workspace", "policies"]) {
      const path = join(result.root, directory);
      await mkdir(path, {
        recursive: true,
        mode: 0o700,
      });
      const entry = await lstat(path);
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        entry.uid !== process.getuid?.() ||
        entry.mode & 0o077 ||
        (await realpath(path)) !== path
      )
        throw new Error(
          "Native storage paths must remain private and canonical.",
        );
      result.storageIdentities.set(path, `${entry.dev}:${entry.ino}`);
    }
    result.egress = await openModelEgress();
    try {
      const launch = await result.launch("owner", null, []);
      const version = await boundedProcess(
        result.binary,
        ["--version"],
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
        join(result.root, "native-permissions-evidence.json"),
        JSON.stringify({
          checkedAt: new Date().toISOString(),
          nativeVersion: version.stdout.trim(),
          policy: "macos-native-model-permissions-v2",
          trustedNativeHost: true,
          modelToolProfile: result.permissionProfile([]).profileId,
          checks: ["native-version-pinned", "native-config-verified"],
        }),
        { mode: 0o600 },
      );
      return result;
    } catch (error) {
      await result.close();
      throw error;
    }
  }
  private async verifyStoragePaths(): Promise<void> {
    for (const [path, identity] of this.storageIdentities) {
      const entry = await lstat(path);
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        entry.uid !== process.getuid?.() ||
        entry.mode & 0o077 ||
        `${entry.dev}:${entry.ino}` !== identity ||
        (await realpath(path)) !== path
      )
        throw new Error("Prepared native storage changed.");
    }
  }
  private async selectedSkills(
    configuration: ConfigurationSnapshot,
  ): Promise<Bound["skills"]> {
    if (!this.options) throw new Error("Native boundary is unavailable.");
    const skills = await this.options.resolveSkills(configuration.skills);
    if (
      skills.length !== configuration.skills.length ||
      new Set(skills.map((skill) => skill.id)).size !== skills.length ||
      configuration.skills.some(
        (skill) =>
          !skills.some(
            (item) =>
              item.id === skill.id &&
              item.revision === skill.revision &&
              item.nativePath === join(skill.directoryRef, "SKILL.md"),
          ),
      )
    )
      throw new Error("Selected managed skill revisions unavailable.");
    return skills;
  }
  private permissionProfile(skills: Bound["skills"]) {
    const filesystem: Record<string, "deny" | "read"> = {
      ":root": "deny",
      ":minimal": "read",
      [homedir()]: "deny",
      [this.root]: "deny",
      [join(this.root, "workspace")]: "read",
    };
    for (const root of [
      ...new Set(skills.map((skill) => dirname(skill.nativePath))),
    ].sort())
      filesystem[root] = "read";
    return {
      profileId: `crew-model-v2-${hash(filesystem).slice(0, 20)}`,
      filesystem,
    };
  }
  private async launch(
    _label: string,
    gateway: NativeGatewayBinding | null,
    skills: Bound["skills"],
  ): Promise<CodexLaunch> {
    this.assertLaunchable();
    if (!this.options || !this.egress)
      throw new Error("Native boundary is unavailable.");
    await this.verifyStoragePaths();
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
      }
      if (gateway.url === gateway.foundationUrl)
        throw new Error(
          "Foundation and service gateway endpoints must be distinct.",
        );
    }
    for (const skill of skills) {
      if (
        !isAbsolute(skill.nativePath) ||
        (await realpath(skill.nativePath)) !== skill.nativePath ||
        !skill.nativePath.endsWith("/SKILL.md")
      )
        throw new Error("Selected skills need exact immutable native paths.");
      const root = dirname(skill.nativePath);
      const entry = await lstat(root);
      const file = await lstat(skill.nativePath);
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        entry.uid !== process.getuid?.() ||
        entry.mode & 0o022 ||
        !file.isFile() ||
        file.isSymbolicLink() ||
        file.uid !== process.getuid?.() ||
        file.mode & 0o022 ||
        root === dirname(root) ||
        root === this.root ||
        root.startsWith(this.root + "/") ||
        this.root.startsWith(root + "/") ||
        homedir() === root ||
        homedir().startsWith(root + "/") ||
        [".codex", ".ssh", ".aws", ".config"].some(
          (name) =>
            root === join(homedir(), name) ||
            root.startsWith(join(homedir(), name) + "/"),
        )
      )
        throw new Error(
          "Skills must use narrow immutable roots outside private native storage.",
        );
    }
    const profile = this.permissionProfile(skills);
    const overrides = [
      'cli_auth_credentials_store="file"',
      'mcp_oauth_credentials_store="file"',
      'forced_login_method="chatgpt"',
      `default_permissions=${JSON.stringify(profile.profileId)}`,
      'approval_policy="never"',
      'web_search="disabled"',
      "allow_login_shell=false",
      'shell_environment_policy={inherit="none",set={},include_only=[]}',
      "features.code_mode.enabled=false",
      "include_apps_instructions=false",
      ...FEATURES.map((feature) => `features.${feature}=false`),
      "mcp_servers={}",
      "plugins={}",
      "marketplaces={}",
      "permissions={}",
      `permissions.${profile.profileId}.extends=":read-only"`,
      `permissions.${profile.profileId}.filesystem={${Object.entries(
        profile.filesystem,
      )
        .map(
          ([path, mode]) => `${JSON.stringify(path)}=${JSON.stringify(mode)}`,
        )
        .join(",")}}`,
      `permissions.${profile.profileId}.network.enabled=false`,
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
          // Crew checks current grants at authenticated dispatch; avoid a second
          // native MCP approval without changing execution/escalation policy.
          `mcp_servers.${name}.default_tools_approval_mode="approve"`,
        );
    }
    const env: Record<string, string> = {
      PATH: "/usr/bin:/bin",
      HOME: join(this.root, "home"),
      CODEX_HOME: join(this.root, "codex"),
      // Native TLS must not depend on personal keychain configuration.
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
      executable: this.binary,
      args: [
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
  private async peer(
    launch: CodexLaunch,
    receive: (envelope: CodexEnvelope) => void = () => {},
    disconnected: () => void = () => {},
  ): Promise<CodexPeer> {
    this.assertLaunchable();
    const peer = new CodexPeer(launch, receive, disconnected, 15_000);
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
    skills: Bound["skills"] = [],
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
      config.mcp_oauth_credentials_store !== "file" ||
      config.web_search !== "disabled" ||
      config.allow_login_shell !== false
    )
      throw new Error(
        "Native configuration did not retain the broker-only restrictions.",
      );
    const expected = this.permissionProfile(skills);
    const permissions = record(config.permissions);
    const profile = record(permissions[expected.profileId]);
    const filesystem = record(profile.filesystem);
    const network = record(profile.network);
    const environment = record(config.shell_environment_policy);
    if (
      config.default_permissions !== expected.profileId ||
      config.approval_policy !== "never" ||
      Object.keys(permissions).join(",") !== expected.profileId ||
      profile.extends !== ":read-only" ||
      Object.entries(profile).some(
        ([name, value]) =>
          !["extends", "filesystem", "network"].includes(name) &&
          value !== null,
      ) ||
      filesystem.glob_scan_max_depth != null ||
      Object.keys(filesystem).filter((name) => name !== "glob_scan_max_depth")
        .length !== Object.keys(expected.filesystem).length ||
      Object.entries(expected.filesystem).some(
        ([path, mode]) => filesystem[path] !== mode,
      ) ||
      network.enabled !== false ||
      Object.entries(network).some(
        ([name, value]) => name !== "enabled" && value !== null,
      ) ||
      environment.inherit !== "none" ||
      Object.keys(record(environment.set ?? {})).length !== 0 ||
      !Array.isArray(environment.include_only) ||
      environment.include_only.length !== 0 ||
      Object.entries(environment).some(
        ([name, value]) =>
          !["inherit", "set", "include_only"].includes(name) && value !== null,
      )
    )
      throw new Error("Native model permission profile changed.");
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
          server.required !== true ||
          server.default_tools_approval_mode !== "approve" ||
          Object.keys(record(server.tools ?? {})).length !== 0
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
      const completedGeneration = this.signInCompletedGeneration;
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
        if (response.account === null) {
          // Account readback, not a completion event alone, establishes sign-in.
          if (
            completedGeneration !== null &&
            completedGeneration === this.signInGeneration
          ) {
            this.signInStatus = signInFailure("completion");
            if (this.signing) await this.stopPeer(this.signing.peer);
          }
          return {
            state: "sign_in_required",
            ...(this.signInStatus
              ? { signIn: structuredClone(this.signInStatus) }
              : {}),
          };
        }
        return {
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
  /** Read-only owner account operation. Uses the existing isolated sign-in;
   * it never starts/resumes a conversation or alters a pending login/reset. */
  async subscriptionUsage(): Promise<RuntimeResult<SubscriptionUsageSnapshot>> {
    try {
      const peer = await this.peer(await this.launch("owner-usage", null, []));
      try {
        await this.verifyConfiguration(peer, null);
        return await readCodexSubscriptionUsage(peer);
      } finally {
        await this.stopPeer(peer);
      }
    } catch {
      return {
        state: "failed",
        error: {
          code: "disconnected",
          message:
            "Crew could not read its isolated subscription allowance. Check the connection and refresh.",
        },
      };
    }
  }
  private currentSignInStatus(): SubscriptionSignInStatus | null {
    return this.signInStatus;
  }
  /** Mount only on authenticated owner ingress, invoked by explicit owner action. */
  async beginSignIn(): Promise<{
    type: "browser";
    loginId: string;
    authorizationUrl: string;
  }> {
    this.assertLaunchable();
    if (this.signing || this.signInStarting || this.signInCancelTask)
      throw new Error("A Crew sign-in or cancellation is already pending.");
    this.signInStarting = true;
    this.signInStatus = { state: "pending", reason: null };
    this.signInCompletedGeneration = null;
    let finishStarting!: () => void;
    const started = new Promise<void>((resolve) => {
      finishStarting = resolve;
    });
    this.signInStartDone = started;
    const generation = ++this.signInGeneration;
    let peer: CodexPeer | null = null;
    let stage: SignInStage = "initialization";
    const earlyCompletions = new Map<string, boolean>();
    let earlyCompletionOverflow = false;
    const complete = (completion: { loginId: string; success: boolean }) => {
      const signing = this.signing;
      if (
        !peer ||
        signing?.peer !== peer ||
        signing.generation !== this.signInGeneration ||
        signing.completed
      )
        return;
      if (signing.loginId === null) {
        if (!earlyCompletions.has(completion.loginId)) {
          if (earlyCompletions.size >= 8) earlyCompletionOverflow = true;
          else earlyCompletions.set(completion.loginId, completion.success);
        }
        return;
      }
      if (completion.loginId !== signing.loginId) return;
      signing.completed = true;
      if (completion.success) this.signInCompletedGeneration = generation;
      if (!completion.success) {
        this.signInStatus = signInFailure("completion");
        // Stop only the exact owned attempt; failed exit remains a launch blocker.
        void this.stopPeer(peer).catch(() => {});
      }
      // On success keep the peer until account/read confirms the stored account.
    };
    const disconnected = () => {
      const signing = this.signing;
      if (
        peer &&
        signing?.peer === peer &&
        signing.generation === this.signInGeneration &&
        !signing.completed &&
        !this.stoppingPeers.has(peer)
      ) {
        this.signInStatus = signInFailure("transport");
        void this.stopPeer(peer).catch(() => {});
      }
    };
    try {
      peer = await this.peer(
        await this.launch("owner-browser-sign-in", null, []),
        (event) => {
          if (event.method !== "account/login/completed") return;
          if (
            typeof event.params.loginId === "string" &&
            event.params.loginId &&
            typeof event.params.success === "boolean"
          ) {
            complete({
              loginId: event.params.loginId,
              success: event.params.success,
            });
            return;
          }
          // The native schema permits an omitted/null ID. That cannot prove
          // exact completion; fail the owned attempt without guessing success.
          const signing = this.signing;
          if (
            peer &&
            signing?.peer === peer &&
            signing.generation === this.signInGeneration &&
            !signing.completed
          ) {
            signing.completed = true;
            this.signInStatus = signInFailure("completion");
            void this.stopPeer(peer).catch(() => {});
          }
        },
        disconnected,
      );
      if (this.closed || generation !== this.signInGeneration)
        throw new Error("Crew sign-in was cancelled.");
      this.signing = { peer, loginId: null, generation, completed: false };
      stage = "configuration";
      await this.verifyConfiguration(peer, null);
      stage = "request";
      const response = await peer.rpc("account/login/start", {
        type: "chatgpt",
      });
      stage = "response";
      const login = record(response);
      if (
        login.type !== "chatgpt" ||
        typeof login.loginId !== "string" ||
        !login.loginId ||
        typeof login.authUrl !== "string" ||
        !validBrowserAuthorizationUrl(login.authUrl)
      )
        throw new Error("Unsupported native sign-in response.");
      if (
        this.closed ||
        generation !== this.signInGeneration ||
        this.signing?.peer !== peer
      )
        throw new Error("Crew sign-in was cancelled.");
      this.signing.loginId = login.loginId;
      if (earlyCompletionOverflow)
        throw new Error(
          "Native sign-in completion correlation exceeded its bound.",
        );
      const earlySuccess = earlyCompletions.get(login.loginId);
      if (earlySuccess !== undefined)
        complete({ loginId: login.loginId, success: earlySuccess });
      if (this.currentSignInStatus()?.state === "failed") {
        stage = "completion";
        throw new Error("Native sign-in ended before link delivery.");
      }
      return {
        type: "browser",
        loginId: login.loginId,
        authorizationUrl: login.authUrl,
      };
    } catch (error) {
      if (!this.closed && generation === this.signInGeneration)
        this.signInStatus =
          this.currentSignInStatus()?.state === "failed"
            ? this.signInStatus
            : signInFailure(stage, error);
      if (peer) await this.stopPeer(peer);
      if (
        this.stoppingPeers.size ||
        unconfirmedNativePeers.get(this.root)?.size
      )
        throw new Error(pendingExitMessage);
      throw new Error(
        this.closed || generation !== this.signInGeneration
          ? "Crew sign-in was cancelled."
          : (this.signInStatus?.reason ??
              "Native browser sign-in could not start."),
      );
    } finally {
      earlyCompletions.clear();
      this.signInStarting = false;
      if (this.signInStartDone === started) this.signInStartDone = null;
      finishStarting();
    }
  }
  async cancelSignIn(): Promise<void> {
    if (this.signInCancelTask) return this.signInCancelTask;
    const operation = (async () => {
      this.signInGeneration++;
      this.signInStatus = null;
      this.signInCompletedGeneration = null;
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
          const skills = await this.selectedSkills(configuration);
          gateway = await this.options.gatewayFor(caller);
          const launch = await this.launch(key(caller), gateway, skills);
          const peer = await this.peer(launch);
          try {
            await this.verifyConfiguration(peer, gateway, skills);
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
            nativePermissions: {
              profileId: this.permissionProfile(skills).profileId,
              approvalPolicy: "never",
            },
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
    try {
      const skills = await this.selectedSkills(input.configuration);
      if (hash(skills) !== hash(bound.skills))
        throw new Error("Prepared skill revisions changed.");
      const launch = await this.launch(
        key(input.caller),
        bound.gateway,
        skills,
      );
      if (
        hash(launch) !== hash(bound.launch) ||
        this.closed ||
        this.releasedSessions.has(key(input.caller)) ||
        this.bindings.get(key(input.caller)) !== bound
      )
        throw new Error("Prepared native session changed.");
      const resolution = {
        state: "ready" as const,
        launch,
        skills: structuredClone(skills),
        nativePermissions: structuredClone(bound.nativePermissions),
      };
      return resolution;
    } catch {
      return {
        state: "blocked",
        error: {
          code: "isolation_blocked",
          message:
            "Prepared native paths or skill revisions changed. No runtime launch was authorized.",
        },
      };
    }
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
