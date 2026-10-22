import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { Ajv } from "ajv";
import type {
  Actor,
  Agent,
  AgentEnvironmentService,
  CallerContext,
  EnvironmentPolicy,
  ExecutionAdmissionGate,
  JsonObject,
  JsonValue,
} from "./contracts.mjs";
import type {
  WorkspaceCommandResult,
  WorkspaceExecutionPolicy,
  WorkspaceProcessSettlement,
} from "../access/workspace-executor.mjs";
import { canonicalJson } from "../gateway/json.mjs";

type Action = "create" | "attach" | "execute" | "dispose";
type DirectoryIdentity = { path: string; device: number; inode: number };
export interface ApprovedWorkspace {
  policy: EnvironmentPolicy;
  workspace: DirectoryIdentity;
  writable: boolean;
  executableDirectories: DirectoryIdentity[];
  managedWorktreeRoot: DirectoryIdentity | null;
  gitDirectory: DirectoryIdentity | null;
}
export interface ProjectEnvironment {
  id: string;
  agentId: string;
  policyId: string;
  kind: "attached_workspace" | "managed_worktree";
  directory: string;
  identity: DirectoryIdentity | null;
  state: "creating" | "attached" | "detached" | "uncertain";
  createdAt: string;
  updatedAt: string;
  /** Detachment never claims that files or services were removed. */
  retained: true;
}
export interface EnvironmentOperation {
  id: string;
  caller: CallerContext;
  targetAgentId: string;
  requestId: string;
  action: Action;
  fingerprint: string;
  environmentId: string;
  policy: EnvironmentPolicy;
  state: "running" | "completed" | "uncertain";
  executionSettled: boolean;
  /** Private helper receipts; never exposed by model-facing operation views. */
  processEvidenceRefs: string[];
  /** False when a helper may have launched but its response/ref was lost. */
  processEvidenceComplete: boolean;
  result: JsonObject | null;
  createdAt: string;
  updatedAt: string;
}
interface EnvironmentState {
  schema: 1;
  projectId: string;
  ownerUserId: string;
  workspaces: ApprovedWorkspace[];
  environments: ProjectEnvironment[];
  operations: EnvironmentOperation[];
}
export interface WorkspaceApproval {
  policyId: string;
  workspaceDirectory: string;
  writable: boolean;
  executableDirectories: string[];
  /** Existing, private, owner-controlled root. No implicit directory setup. */
  managedWorktreeRoot?: string;
}
export interface ProjectEnvironmentOptions {
  directory: string;
  /** Trusted composition roots containing native auth, vaults and journals.
   * Never supplied by model JSON or overridden by workspace approval. */
  protectedDirectories: string[];
  projectId: string;
  ownerUserId: string;
  admission: ExecutionAdmissionGate;
  /** Fresh Crew action, target, group membership AND exact policy reference. */
  authorize(
    caller: CallerContext,
    action: Action | "read",
    targetAgentId: string,
    policy: EnvironmentPolicy,
  ): Promise<void>;
  /** Must reject stale/stopped sessions and the final lifecycle reservation. */
  verifyExecution(caller: CallerContext): Promise<void>;
  /** Called inside the shared gate. Must not acquire that gate recursively. */
  noteExecutionAdmitted(caller: CallerContext): Promise<void>;
  /** Trusted composition only; inject the actual enforced workspace executor. */
  execute(
    policy: WorkspaceExecutionPolicy,
    input: { command: string; relativeCwd?: string; timeoutMs?: number },
  ): Promise<WorkspaceCommandResult>;
  /** Read-only helper; never launches, signals, replays, or guesses identities. */
  observeExecution(
    privateDirectory: string,
    processEvidenceRef: string,
  ): Promise<WorkspaceProcessSettlement>;
}

const now = () => new Date().toISOString();
const MAX_STATE = 32 * 1024 * 1024;
const MAX_OPERATIONS = 10_000;
const evidenceRef =
  /^workspace-process:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const idValid = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  !/[\u0000-\u001f\u007f]/.test(value);
const inside = (root: string, candidate: string) => {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
};
const overlaps = (a: string, b: string) => inside(a, b) || inside(b, a);
const sameCaller = (a: CallerContext, b: CallerContext) =>
  a.projectId === b.projectId &&
  a.agentId === b.agentId &&
  a.sessionId === b.sessionId;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const commandText = (argv: string[]) => argv.map(quote).join(" ");
const digest = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
const jsonObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const strict = (value: JsonObject, keys: string[]) => {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error(
      "Unknown environment argument; filesystem roots and credentials are not agent arguments.",
    );
};
function validCaller(caller: CallerContext, projectId: string) {
  if (
    !caller ||
    Object.keys(caller).length !== 3 ||
    !idValid(caller.agentId) ||
    !idValid(caller.sessionId) ||
    caller.projectId !== projectId
  )
    throw new Error("Invalid environment caller.");
}
function boundedCommand(args: JsonObject) {
  strict(args, ["environmentId", "command", "relativeCwd", "timeoutMs"]);
  const command = args.command;
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.length > 256 ||
    command.some((part) => typeof part !== "string" || part.includes("\0")) ||
    typeof command[0] !== "string" ||
    command[0].length === 0 ||
    Buffer.byteLength(JSON.stringify(command)) > 48 * 1024
  )
    throw new Error("Command must be a bounded nonempty argv array.");
  const relativeCwd = args.relativeCwd ?? ".";
  if (
    typeof relativeCwd !== "string" ||
    relativeCwd.length > 4096 ||
    relativeCwd.includes("\0") ||
    isAbsolute(relativeCwd) ||
    relativeCwd.split(/[\\/]/).includes("..")
  )
    throw new Error(
      "Command working directory must stay inside its environment.",
    );
  const timeoutMs = args.timeoutMs ?? 30_000;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 120_000
  )
    throw new Error(
      "Command timeout must be between 100 and 120000 milliseconds.",
    );
  const quotedCommand = commandText(command as string[]);
  if (Buffer.byteLength(quotedCommand) > 64 * 1024)
    throw new Error("Quoted command exceeds the executor input limit.");
  return { command: quotedCommand, relativeCwd, timeoutMs };
}

// The journal contains trusted policy paths and bounded command results, never
// credential handles or command bodies. Validate before accepting recovered state.
const text = { type: "string", maxLength: 4096 };
const id = {
  type: "string",
  minLength: 1,
  maxLength: 512,
  pattern: "^[^\\u0000-\\u001f\\u007f]+$",
};
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const nullable = (value: unknown) => ({ anyOf: [value, { type: "null" }] });
const array = (items: unknown, maxItems = 10_000) => ({
  type: "array",
  items,
  maxItems,
});
const directorySchema = object({
  path: text,
  device: { type: "number" },
  inode: { type: "number" },
});
const policySchema = object({
  id,
  projectId: id,
  revision: { type: "integer", minimum: 1 },
  enforcementConfigRef: id,
});
const validate = new Ajv({
  allErrors: false,
  strict: false,
}).compile<EnvironmentState>(
  object({
    schema: { const: 1 },
    projectId: id,
    ownerUserId: id,
    workspaces: array(
      object({
        policy: policySchema,
        workspace: directorySchema,
        writable: { type: "boolean" },
        executableDirectories: array(directorySchema, 32),
        managedWorktreeRoot: nullable(directorySchema),
        gitDirectory: nullable(directorySchema),
      }),
      1000,
    ),
    environments: array(
      object({
        id,
        agentId: id,
        policyId: id,
        kind: { enum: ["attached_workspace", "managed_worktree"] },
        directory: text,
        identity: nullable(directorySchema),
        state: { enum: ["creating", "attached", "detached", "uncertain"] },
        createdAt: text,
        updatedAt: text,
        retained: { const: true },
      }),
    ),
    operations: array(
      object({
        id,
        caller: object({ projectId: id, agentId: id, sessionId: id }),
        targetAgentId: id,
        requestId: id,
        action: { enum: ["create", "attach", "execute", "dispose"] },
        fingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
        environmentId: id,
        policy: policySchema,
        state: { enum: ["running", "completed", "uncertain"] },
        executionSettled: { type: "boolean" },
        processEvidenceRefs: array(
          { type: "string", pattern: evidenceRef.source },
          2,
        ),
        processEvidenceComplete: { type: "boolean" },
        result: nullable({ type: "object" }),
        createdAt: text,
        updatedAt: text,
      }),
      MAX_OPERATIONS,
    ),
  }),
);

/** One private journal per project. An abandoned writer lock requires confirmed
 * controller recovery; this service never removes another writer's lock. */
export class ProjectEnvironmentService implements AgentEnvironmentService {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private failed = false;
  private closing: Promise<void> | null = null;
  private readonly active = new Set<Promise<unknown>>();
  private readonly listeners = new Set<() => void>();
  private constructor(
    private readonly options: ProjectEnvironmentOptions,
    private readonly lock: FileHandle,
    private state: EnvironmentState,
  ) {}

  static async open(
    options: ProjectEnvironmentOptions,
  ): Promise<ProjectEnvironmentService> {
    if (
      !isAbsolute(options.directory) ||
      !idValid(options.projectId) ||
      !idValid(options.ownerUserId) ||
      !Array.isArray(options.protectedDirectories) ||
      options.protectedDirectories.length === 0 ||
      options.protectedDirectories.length > 32 ||
      options.protectedDirectories.some(
        (path) => typeof path !== "string" || !isAbsolute(path),
      )
    )
      throw new Error("Invalid environment service identity.");
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    for (const path of options.protectedDirectories) {
      if ((await realpath(path)) !== path || !(await lstat(path)).isDirectory())
        throw new Error(
          "Protected controller roots must be canonical existing directories.",
        );
    }
    if (
      !options.protectedDirectories.some((path) =>
        inside(path, options.directory),
      )
    )
      throw new Error(
        "Protected roots must include the environment journal directory.",
      );
    const directory = await realpath(options.directory);
    const info = await lstat(directory);
    if (
      directory !== options.directory ||
      !info.isDirectory() ||
      info.mode & 0o077 ||
      info.uid !== process.getuid?.()
    )
      throw new Error(
        "Environment state directory must be canonical, private and owner-controlled.",
      );
    const lock = await open(join(directory, "environments.lock"), "wx", 0o600);
    const initial: EnvironmentState = {
      schema: 1,
      projectId: options.projectId,
      ownerUserId: options.ownerUserId,
      workspaces: [],
      environments: [],
      operations: [],
    };
    const service: ProjectEnvironmentService = new ProjectEnvironmentService(
      options,
      lock,
      initial,
    );
    try {
      await lock.writeFile(
        JSON.stringify({ pid: process.pid, token: randomUUID() }),
      );
      await lock.sync();
      let file: FileHandle | undefined;
      try {
        file = await open(
          join(directory, "environments.json"),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (file) {
        try {
          const stat = await file.stat();
          if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            stat.mode & 0o077 ||
            stat.uid !== process.getuid?.() ||
            stat.size > MAX_STATE
          )
            throw new Error("Unsafe environment journal.");
          const saved: unknown = JSON.parse(await file.readFile("utf8"));
          // Earlier receipts predate process observation. Preserve their known
          // results, but never invent missing evidence for an unsettled command.
          if (jsonObject(saved) && Array.isArray(saved.operations)) {
            for (const operation of saved.operations)
              if (jsonObject(operation)) {
                if (operation.processEvidenceRefs === undefined)
                  operation.processEvidenceRefs = [];
                if (operation.processEvidenceComplete === undefined)
                  operation.processEvidenceComplete = false;
              }
          }
          service.validateState(saved);
          service.state = saved;
        } finally {
          await file.close();
        }
      }
      for (const operation of service.state.operations) {
        if (operation.state === "running") {
          operation.state = "uncertain";
          operation.executionSettled = false;
          operation.updatedAt = now();
          const environment = service.state.environments.find(
            (row) => row.id === operation.environmentId,
          );
          if (environment?.state === "creating")
            environment.state = "uncertain";
        }
      }
      await service.persist(service.state);
      return service;
    } catch {
      await service.close().catch(() => {});
      throw new Error(
        "Environment state could not be opened safely; retain it for recovery.",
      );
    }
  }

  private validateState(value: unknown): asserts value is EnvironmentState {
    if (!validate(value)) throw new Error("Invalid environment state.");
    const state = value;
    if (
      state.projectId !== this.options.projectId ||
      state.ownerUserId !== this.options.ownerUserId
    )
      throw new Error("Foreign environment state.");
    for (const rows of [
      state.workspaces.map((row) => row.policy.id),
      state.environments.map((row) => row.id),
      state.operations.map((row) => row.id),
      state.operations.map((row) =>
        digest({ caller: row.caller, requestId: row.requestId }),
      ),
    ])
      if (new Set(rows).size !== rows.length)
        throw new Error("Duplicate environment identity.");
    for (const workspace of state.workspaces) {
      if (
        workspace.policy.projectId !== state.projectId ||
        workspace.policy.enforcementConfigRef !==
          this.policyRef(workspace.policy.id, workspace.policy.revision) ||
        Boolean(workspace.gitDirectory) !==
          Boolean(workspace.managedWorktreeRoot)
      )
        throw new Error("Invalid workspace policy.");
      for (const entry of [
        workspace.workspace,
        ...workspace.executableDirectories,
        workspace.managedWorktreeRoot,
        workspace.gitDirectory,
      ])
        if (entry && !isAbsolute(entry.path))
          throw new Error("Invalid workspace path.");
    }
    for (const environment of state.environments)
      if (
        !isAbsolute(environment.directory) ||
        !state.workspaces.some(
          (row) => row.policy.id === environment.policyId,
        ) ||
        (environment.identity &&
          environment.identity.path !== environment.directory)
      )
        throw new Error("Invalid environment reference.");
    for (const operation of state.operations) {
      validCaller(operation.caller, state.projectId);
      const environment = state.environments.find(
        (row) => row.id === operation.environmentId,
      );
      if (
        !environment ||
        environment.agentId !== operation.targetAgentId ||
        environment.policyId !== operation.policy.id ||
        operation.policy.projectId !== state.projectId ||
        (operation.state === "running" && operation.executionSettled)
      )
        throw new Error("Invalid environment operation.");
    }
  }
  private policyRef(policyId: string, revision: number) {
    return `crew-workspace:${digest({ projectId: this.options.projectId, policyId, revision })}`;
  }
  private owner(actor: Actor) {
    if (actor?.type !== "user" || actor.userId !== this.options.ownerUserId)
      throw new Error("Project owner authentication is required.");
  }
  private async ownsLock() {
    try {
      const held = await this.lock.stat(),
        current = await lstat(
          join(this.options.directory, "environments.lock"),
        );
      return (
        current.isFile() &&
        !current.isSymbolicLink() &&
        held.ino === current.ino &&
        held.dev === current.dev
      );
    } catch {
      return false;
    }
  }
  private async persist(state: EnvironmentState) {
    if (!(await this.ownsLock()))
      throw new Error("Environment writer ownership was lost.");
    this.validateState(state);
    const serialized = JSON.stringify(state);
    if (Buffer.byteLength(serialized) > MAX_STATE)
      throw new Error(
        "Environment journal limit reached; owner maintenance is required.",
      );
    const temporary = join(
      this.options.directory,
      `environment-${randomUUID()}.tmp`,
    );
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(serialized);
      await file.sync();
      await file.close();
      if (!(await this.ownsLock()))
        throw new Error("Environment writer ownership was lost.");
      await rename(
        temporary,
        join(this.options.directory, "environments.json"),
      );
      const directory = await open(this.options.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await file.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
  }
  private transaction<T>(change: (draft: EnvironmentState) => T): Promise<T> {
    const result = this.tail.then(async () => {
      if (this.closed || this.failed)
        throw new Error("Environment service requires recovery.");
      const draft = structuredClone(this.state);
      const returned = change(draft);
      try {
        await this.persist(draft);
      } catch {
        this.failed = true;
        throw new Error(
          "Environment operation could not be committed; do not repeat execution.",
        );
      }
      this.state = draft;
      for (const listener of this.listeners) {
        try {
          listener();
        } catch {
          /* Observers cannot invalidate a durable result. */
        }
      }
      return structuredClone(returned);
    });
    this.tail = result.catch(() => {});
    return result;
  }

  private protectedPath(path: string) {
    const forbidden = [
      ...this.options.protectedDirectories,
      this.options.directory,
      join(homedir(), ".codex", "auth.json"),
      join(homedir(), ".codex", "config.toml"),
      join(homedir(), ".codex", "sessions"),
      join(homedir(), ".ssh"),
      join(homedir(), ".aws"),
      join(homedir(), "Library", "Application Support", "Crew"),
    ];
    return (
      path === "/" ||
      inside(path, homedir()) ||
      forbidden.some((entry) => overlaps(path, entry))
    );
  }
  private async identifyDirectory(
    path: string,
    privateRoot = false,
  ): Promise<DirectoryIdentity> {
    if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0"))
      throw new Error("Owner-approved absolute directory required.");
    const canonical = await realpath(path),
      stat = await lstat(canonical);
    if (
      !stat.isDirectory() ||
      this.protectedPath(canonical) ||
      (privateRoot &&
        (stat.uid !== process.getuid?.() || Boolean(stat.mode & 0o077)))
    )
      throw new Error(
        "Workspace roots must be specific project folders, separate from private authentication and controller state.",
      );
    return { path: canonical, device: stat.dev, inode: stat.ino };
  }
  private async verifyDirectory(identity: DirectoryIdentity) {
    const current = await lstat(identity.path);
    if (
      this.protectedPath(identity.path) ||
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== identity.device ||
      current.ino !== identity.inode ||
      (await realpath(identity.path)) !== identity.path
    )
      throw new Error(
        "Approved workspace directory changed; owner review is required.",
      );
  }
  private async verifyWorkspace(workspace: ApprovedWorkspace) {
    for (const entry of [
      workspace.workspace,
      ...workspace.executableDirectories,
      workspace.managedWorktreeRoot,
      workspace.gitDirectory,
    ])
      if (entry) await this.verifyDirectory(entry);
  }

  async approveWorkspace(
    actor: Actor,
    input: WorkspaceApproval,
    expectedRevision: number | null,
  ): Promise<ApprovedWorkspace> {
    this.owner(actor);
    input = structuredClone(input);
    if (
      !idValid(input.policyId) ||
      typeof input.writable !== "boolean" ||
      !Array.isArray(input.executableDirectories) ||
      input.executableDirectories.length > 32 ||
      !(
        expectedRevision === null ||
        (Number.isSafeInteger(expectedRevision) && expectedRevision > 0)
      )
    )
      throw new Error("Invalid workspace approval.");
    const workspace = await this.identifyDirectory(input.workspaceDirectory);
    const executableDirectories = await Promise.all(
      input.executableDirectories.map((path) => this.identifyDirectory(path)),
    );
    if (
      new Set(executableDirectories.map((entry) => entry.path)).size !==
      executableDirectories.length
    )
      throw new Error("Executable directories must be unique.");
    let managedWorktreeRoot: DirectoryIdentity | null = null,
      gitDirectory: DirectoryIdentity | null = null;
    if (input.managedWorktreeRoot) {
      if (!input.writable)
        throw new Error(
          "Managed worktree creation requires owner-approved writes.",
        );
      managedWorktreeRoot = await this.identifyDirectory(
        input.managedWorktreeRoot,
        true,
      );
      if (overlaps(workspace.path, managedWorktreeRoot.path))
        throw new Error("Managed worktrees require a separate dedicated root.");
      // This first bounded creator accepts ordinary repositories only. Existing
      // worktrees remain attachable; no .git indirection is guessed or widened.
      const gitPath = join(workspace.path, ".git");
      const gitStat = await lstat(gitPath);
      if (!gitStat.isDirectory() || gitStat.isSymbolicLink())
        throw new Error(
          "Managed creation currently requires an ordinary repository with a local .git directory; attach existing worktrees instead.",
        );
      gitDirectory = await this.identifyDirectory(gitPath);
    }
    return this.options.admission.run(async () => {
      this.owner(actor);
      const record: ApprovedWorkspace = {
        policy: {
          id: input.policyId,
          projectId: this.options.projectId,
          revision: (expectedRevision ?? 0) + 1,
          enforcementConfigRef: this.policyRef(
            input.policyId,
            (expectedRevision ?? 0) + 1,
          ),
        },
        workspace,
        writable: input.writable,
        executableDirectories,
        managedWorktreeRoot,
        gitDirectory,
      };
      await this.verifyWorkspace(record);
      return this.transaction((draft) => {
        const previous = draft.workspaces.find(
          (row) => row.policy.id === input.policyId,
        );
        // Owner setup spans this journal and access policy publication. Return
        // the same exact approval after a lost response, never broaden a retry.
        if (
          previous?.policy.revision === (expectedRevision ?? 0) + 1 &&
          canonicalJson({ ...previous, policy: null }) ===
            canonicalJson({ ...record, policy: null })
        )
          return previous;
        if ((previous?.policy.revision ?? null) !== expectedRevision)
          throw new Error("Workspace approval revision conflict.");
        if (
          previous &&
          draft.environments.some(
            (row) =>
              row.policyId === input.policyId && row.state !== "detached",
          ) &&
          (canonicalJson(previous.workspace) !== canonicalJson(workspace) ||
            canonicalJson(previous.managedWorktreeRoot) !==
              canonicalJson(managedWorktreeRoot) ||
            canonicalJson(previous.gitDirectory) !==
              canonicalJson(gitDirectory))
        )
          throw new Error(
            "Detach existing environments before changing approved workspace roots.",
          );
        if (previous) Object.assign(previous, record);
        else draft.workspaces.push(record);
        return record;
      });
    });
  }

  ownerSnapshot(actor: Actor) {
    this.owner(actor);
    return structuredClone({
      workspaces: this.state.workspaces,
      environments: this.state.environments,
      operations: this.state.operations,
    });
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  resources(agentId: string): Agent["resources"] {
    return this.state.environments
      .filter((row) => row.agentId === agentId && row.state !== "detached")
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        location: row.directory,
        metadata: { policyId: row.policyId, state: row.state, retained: true },
      }));
  }
  async reconcileOperation(
    actor: Actor,
    operationId: string,
  ): Promise<JsonObject> {
    this.owner(actor);
    if (!idValid(operationId)) throw new Error("Invalid operation identity.");
    const operation = structuredClone(
      this.state.operations.find((row) => row.id === operationId),
    );
    if (!operation) throw new Error("Unknown environment operation.");
    if (
      operation.state === "running" ||
      operation.executionSettled ||
      !operation.processEvidenceComplete
    )
      return this.operationView(operation);
    // Observation is read-only and outside the short shared gate. Each ref was
    // durably returned by this operation; no directory scan or guessed PID.
    const observations = await Promise.all(
      operation.processEvidenceRefs.map((ref) =>
        this.options
          .observeExecution(this.options.directory, ref)
          .catch(() => null),
      ),
    );
    const settled = observations.every(
      (observation, index) =>
        observation?.processesSettled === true &&
        observation.processEvidenceRef === operation.processEvidenceRefs[index],
    );
    if (!settled) return this.operationView(operation);
    return this.options.admission.run(async () => {
      this.owner(actor);
      return this.transaction((draft) => {
        const current = draft.operations.find((row) => row.id === operationId)!;
        if (
          current.state !== "running" &&
          current.processEvidenceComplete &&
          canonicalJson(current.processEvidenceRefs) ===
            canonicalJson(operation.processEvidenceRefs)
        ) {
          // Outcome uncertainty is deliberately retained. Only process activity
          // becomes settled; this never marks a command successful or replays it.
          current.executionSettled = true;
          current.updatedAt = now();
        }
        return this.operationView(current);
      });
    });
  }
  async list(caller: CallerContext, agentId: string): Promise<JsonValue> {
    validCaller(caller, this.options.projectId);
    if (!idValid(agentId)) throw new Error("Invalid environment target.");
    const entries: JsonObject[] = [];
    for (const workspace of this.state.workspaces) {
      try {
        await this.options.authorize(caller, "read", agentId, workspace.policy);
      } catch {
        continue;
      }
      entries.push({
        policy: { ...workspace.policy },
        workspaceDirectory: workspace.workspace.path,
        writable: workspace.writable,
        managedCreationAvailable: workspace.managedWorktreeRoot !== null,
        environments: this.state.environments
          .filter(
            (row) =>
              row.agentId === agentId && row.policyId === workspace.policy.id,
          )
          .map((row) => this.environmentView(row)),
      });
    }
    return entries;
  }
  settlement(caller?: CallerContext) {
    if (caller) validCaller(caller, this.options.projectId);
    // Lifecycle ownership follows the exact submitting native session. The
    // resource itself still blocks disposal while any caller has unsettled work.
    const operations = this.state.operations.filter(
      (row) => !caller || sameCaller(row.caller, caller),
    );
    return {
      inFlightOperationIds: operations
        .filter((row) => row.state === "running")
        .map((row) => row.id),
      uncertainOperationIds: operations
        .filter((row) => row.state !== "running" && !row.executionSettled)
        .map((row) => row.id),
      observedAt: now(),
    };
  }
  private environmentView(environment: ProjectEnvironment): JsonObject {
    return {
      environmentId: environment.id,
      agentId: environment.agentId,
      policyId: environment.policyId,
      kind: environment.kind,
      directory: environment.directory,
      state: environment.state,
      retained: true,
    };
  }
  private operationView(operation: EnvironmentOperation): JsonObject {
    return {
      operationId: operation.id,
      requestId: operation.requestId,
      environmentId: operation.environmentId,
      state: operation.state,
      executionSettled: operation.executionSettled,
      result: operation.result,
    };
  }
  private executionPolicy(
    workspace: ApprovedWorkspace,
    environment: ProjectEnvironment,
    creating = false,
  ): WorkspaceExecutionPolicy {
    return {
      workspaceDirectory: environment.directory,
      privateDirectory: this.options.directory,
      writable: workspace.writable,
      readableRoots:
        environment.kind === "managed_worktree" && workspace.gitDirectory
          ? [creating ? workspace.workspace.path : workspace.gitDirectory.path]
          : [],
      writableRoots:
        environment.kind === "managed_worktree" && workspace.gitDirectory
          ? [workspace.gitDirectory.path]
          : [],
      executableDirectories: workspace.executableDirectories.map(
        (entry) => entry.path,
      ),
    };
  }

  invoke(
    input: Parameters<AgentEnvironmentService["invoke"]>[0],
  ): Promise<JsonValue> {
    if (this.closed || this.closing)
      return Promise.reject(new Error("Environment service is closing."));
    const task = this.perform(structuredClone(input));
    this.active.add(task);
    void task.finally(() => this.active.delete(task)).catch(() => {});
    return task;
  }
  private async perform(
    input: Parameters<AgentEnvironmentService["invoke"]>[0],
  ): Promise<JsonValue> {
    validCaller(input.caller, this.options.projectId);
    if (
      !idValid(input.agentId) ||
      !idValid(input.requestId) ||
      !["create", "attach", "execute", "dispose"].includes(input.action) ||
      !jsonObject(input.arguments)
    )
      throw new Error("Invalid environment operation.");
    const args = input.arguments;
    let command: {
      command: string;
      relativeCwd?: string;
      timeoutMs?: number;
    } | null = null;
    if (input.action === "execute") command = boundedCommand(args);
    else if (input.action === "dispose") strict(args, ["environmentId"]);
    else {
      strict(
        args,
        input.action === "create" ? ["policyId", "ref"] : ["policyId"],
      );
      if (!idValid(args.policyId))
        throw new Error("Approved workspace policy required.");
      if (
        args.ref !== undefined &&
        (typeof args.ref !== "string" ||
          args.ref.length === 0 ||
          args.ref.length > 512 ||
          args.ref.startsWith("-") ||
          /[\u0000-\u0020\u007f]/.test(args.ref))
      )
        throw new Error("Invalid worktree commit reference.");
    }
    if (
      (input.action === "execute" || input.action === "dispose") &&
      !idValid(args.environmentId)
    )
      throw new Error("Exact environment identity required.");
    const fingerprint = digest({
      targetAgentId: input.agentId,
      action: input.action,
      arguments: args,
    });
    const admitted = await this.options.admission.run(async () => {
      if (this.closed || this.failed)
        throw new Error("Environment service requires recovery.");
      const existing = this.state.operations.find(
        (row) =>
          sameCaller(row.caller, input.caller) &&
          row.requestId === input.requestId,
      );
      if (existing && existing.fingerprint !== fingerprint)
        throw new Error(
          "Environment request identity was reused with different arguments.",
        );
      let environment = existing
        ? this.state.environments.find(
            (row) => row.id === existing.environmentId,
          )
        : this.state.environments.find((row) => row.id === args.environmentId);
      if (environment && environment.agentId !== input.agentId)
        throw new Error(
          "Environment does not belong to the exact target agent.",
        );
      const policyId = environment?.policyId ?? args.policyId;
      const workspace = this.state.workspaces.find(
        (row) => row.policy.id === policyId,
      );
      if (!workspace)
        throw new Error(
          "Workspace has not been approved by the project owner.",
        );
      await this.options.authorize(
        input.caller,
        input.action,
        input.agentId,
        workspace.policy,
      );
      await this.options.verifyExecution(input.caller);
      if (existing)
        return {
          replay: this.operationView(existing),
          operation: null,
          workspace: null,
          environment: null,
        };
      await this.verifyWorkspace(workspace);
      if (environment && environment.state !== "attached")
        throw new Error(
          "Environment is not attached; uncertain resources require owner recovery.",
        );
      if (environment?.identity)
        await this.verifyDirectory(environment.identity);
      if (
        (input.action === "execute" || input.action === "dispose") &&
        !environment
      )
        throw new Error("Unknown environment.");
      if (
        input.action === "create" &&
        (!workspace.managedWorktreeRoot ||
          !workspace.gitDirectory ||
          !workspace.writable)
      )
        throw new Error(
          "Managed worktree creation needs an owner-approved writable repository and managed root; attach is available separately.",
        );
      if (
        environment &&
        this.state.operations.some(
          (row) =>
            row.environmentId === environment!.id &&
            (row.state === "running" || !row.executionSettled),
        )
      )
        throw new Error(
          "Environment has running or uncertain execution; settle it before another operation.",
        );
      if (!environment && input.action === "attach")
        environment = this.state.environments.find(
          (row) =>
            row.agentId === input.agentId &&
            row.policyId === workspace.policy.id &&
            row.kind === "attached_workspace" &&
            row.state === "attached",
        );
      const timestamp = now();
      if (!environment) {
        const id = randomUUID();
        environment = {
          id,
          agentId: input.agentId,
          policyId: workspace.policy.id,
          kind:
            input.action === "create"
              ? "managed_worktree"
              : "attached_workspace",
          directory:
            input.action === "create"
              ? join(workspace.managedWorktreeRoot!.path, `crew-${id}`)
              : workspace.workspace.path,
          identity: input.action === "create" ? null : workspace.workspace,
          state: input.action === "create" ? "creating" : "attached",
          createdAt: timestamp,
          updatedAt: timestamp,
          retained: true,
        };
      }
      await this.options.noteExecutionAdmitted(input.caller);
      const operation = await this.transaction((draft) => {
        if (draft.operations.length >= MAX_OPERATIONS)
          throw new Error(
            "Environment operation limit reached; owner maintenance required.",
          );
        let savedEnvironment = draft.environments.find(
          (row) => row.id === environment!.id,
        );
        if (!savedEnvironment) {
          savedEnvironment = structuredClone(environment!);
          draft.environments.push(savedEnvironment);
        }
        const immediate =
          input.action === "attach" || input.action === "dispose";
        if (input.action === "dispose") {
          savedEnvironment.state = "detached";
          savedEnvironment.updatedAt = timestamp;
        }
        const operation: EnvironmentOperation = {
          id: randomUUID(),
          caller: input.caller,
          targetAgentId: input.agentId,
          requestId: input.requestId,
          action: input.action,
          fingerprint,
          environmentId: savedEnvironment.id,
          policy: workspace.policy,
          state: immediate ? "completed" : "running",
          executionSettled: immediate,
          processEvidenceRefs: [],
          processEvidenceComplete: immediate,
          result: immediate ? this.environmentView(savedEnvironment) : null,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        draft.operations.push(operation);
        return operation;
      });
      return {
        replay: null,
        operation,
        workspace: structuredClone(workspace),
        environment: structuredClone(environment),
      };
    });
    if (admitted.replay) return admitted.replay;
    const { operation, workspace, environment } = admitted;
    if (!operation || !workspace || !environment)
      throw new Error("Environment admission failed.");
    if (operation.state === "completed") return this.operationView(operation);
    // Execution deliberately occurs after release of the shared admission gate.
    // The already committed running receipt is the reservation/Stop blocker.
    try {
      let result: WorkspaceCommandResult;
      let evidenceComplete = true;
      const captureEvidence = async (
        returned: WorkspaceCommandResult,
        final: boolean,
      ) => {
        if (
          !["exited", "timed_out", "not_started"].includes(returned.state) ||
          typeof returned.stdout !== "string" ||
          typeof returned.stderr !== "string" ||
          typeof returned.mayHaveExecuted !== "boolean" ||
          typeof returned.processesSettled !== "boolean" ||
          !(
            returned.processEvidenceRef === null ||
            evidenceRef.test(returned.processEvidenceRef)
          )
        )
          throw new Error("Invalid executor result.");
        evidenceComplete =
          evidenceComplete &&
          (!returned.mayHaveExecuted || returned.processEvidenceRef !== null);
        await this.transaction((draft) => {
          const saved = draft.operations.find(
            (row) => row.id === operation.id,
          )!;
          if (
            returned.processEvidenceRef &&
            !saved.processEvidenceRefs.includes(returned.processEvidenceRef)
          )
            saved.processEvidenceRefs.push(returned.processEvidenceRef);
          saved.processEvidenceComplete = final && evidenceComplete;
          saved.updatedAt = now();
        });
      };
      let identity: DirectoryIdentity | null = environment.identity;
      if (input.action === "create") {
        await mkdir(environment.directory, { mode: 0o700 });
        identity = await this.identifyDirectory(environment.directory);
        result = await this.options.execute(
          this.executionPolicy(workspace, environment, true),
          {
            command: commandText([
              "git",
              "-C",
              workspace.workspace.path,
              "-c",
              "core.hooksPath=/dev/null",
              "-c",
              "core.fsmonitor=false",
              "worktree",
              "add",
              "--detach",
              "--",
              environment.directory,
              typeof args.ref === "string" ? args.ref : "HEAD",
            ]),
            timeoutMs: 120_000,
          },
        );
        const verifyRegistration =
          result.state === "exited" && result.exitCode === 0;
        await captureEvidence(result, !verifyRegistration);
        if (verifyRegistration) {
          const registered = await this.options.execute(
            this.executionPolicy(workspace, environment),
            {
              command: commandText([
                "git",
                "-c",
                "core.fsmonitor=false",
                "rev-parse",
                "--show-toplevel",
                "--git-common-dir",
              ]),
              timeoutMs: 10_000,
            },
          );
          await captureEvidence(registered, true);
          const paths = registered.stdout.trim().split("\n");
          if (
            registered.state !== "exited" ||
            registered.exitCode !== 0 ||
            paths[0] !== environment.directory ||
            !paths[1] ||
            (await realpath(
              isAbsolute(paths[1])
                ? paths[1]
                : join(environment.directory, paths[1]),
            )) !== workspace.gitDirectory!.path
          )
            throw new Error(
              "Managed worktree registration could not be confirmed.",
            );
          result.processesSettled =
            result.processesSettled === true &&
            registered.processesSettled === true;
        }
      } else {
        result = await this.options.execute(
          this.executionPolicy(workspace, environment),
          command!,
        );
        await captureEvidence(result, true);
      }
      if (
        !["exited", "timed_out", "not_started"].includes(result.state) ||
        typeof result.stdout !== "string" ||
        typeof result.stderr !== "string" ||
        typeof result.mayHaveExecuted !== "boolean"
      )
        throw new Error("Invalid executor result.");
      const completed = await this.transaction((draft) => {
        const saved = draft.operations.find((row) => row.id === operation.id)!;
        saved.state = "completed";
        saved.executionSettled =
          !result.mayHaveExecuted || result.processesSettled === true;
        saved.updatedAt = now();
        const stdout = Buffer.from(result.stdout)
            .subarray(0, 32 * 1024)
            .toString("utf8"),
          stderr = Buffer.from(result.stderr)
            .subarray(0, 32 * 1024)
            .toString("utf8");
        saved.result = {
          state: result.state,
          exitCode: result.exitCode,
          stdout,
          stderr,
          truncated:
            result.truncated ||
            stdout !== result.stdout ||
            stderr !== result.stderr,
          mayHaveExecuted: result.mayHaveExecuted,
        };
        if (input.action === "create") {
          const row = draft.environments.find(
            (entry) => entry.id === environment.id,
          )!;
          row.identity = identity;
          row.state =
            result.state === "exited" && result.exitCode === 0
              ? "attached"
              : "uncertain";
          row.updatedAt = now();
          saved.result.environment = this.environmentView(row);
        }
        return saved;
      });
      return this.operationView(completed);
    } catch {
      const uncertain = await this.transaction((draft) => {
        const saved = draft.operations.find((row) => row.id === operation.id)!;
        saved.state = "uncertain";
        saved.executionSettled = false;
        saved.updatedAt = now();
        saved.result = {
          message:
            "Execution outcome is uncertain. Preserve the environment and inspect the existing operation; do not replay it.",
        };
        if (input.action === "create")
          draft.environments.find((row) => row.id === environment.id)!.state =
            "uncertain";
        return saved;
      });
      return this.operationView(uncertain);
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      // Callers must close the ingress first. Already admitted commands retain
      // their receipts and are allowed to finish; closing never kills resources.
      await Promise.allSettled([...this.active]);
      this.closed = true;
      await this.tail;
      this.listeners.clear();
      try {
        if (await this.ownsLock())
          await unlink(join(this.options.directory, "environments.lock"));
      } finally {
        await this.lock.close();
      }
    })();
    return this.closing;
  }
}
