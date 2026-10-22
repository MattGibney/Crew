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
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { Actor, Agent, CallerContext } from "./contracts.mjs";
import { satisfiesToolVersion } from "../toolchains/tool-requirements.mjs";

export interface EnvironmentToolRequirement {
  name: "node" | "npm";
  versionRequirement: string | null;
}
export interface EnvironmentTemplateDraft {
  name: string;
  description: string;
  tools: EnvironmentToolRequirement[];
  /** Explicit existing installations. Preparation resolves and verifies these paths. */
  executableDirectories: string[];
  readableDirectories: string[];
  /** Nonsecret owner configuration only; never ambient process environment. */
  environment: Record<string, string>;
  /** Owner-approved host-wide Docker authority, including daemon-wide control
   * and host mounts beyond this workspace. Never supplies Docker credentials. */
  hostDocker?: { socketPath: string; hostAccessAcknowledged: true };
  capabilities: {
    packageDownloads: boolean;
    network: boolean;
    localhostPorts: number[];
    /** Explicit incoming TCP on these ports on ALL interfaces, independent of
     * outbound network access. Omission means none; retain old revision bytes. */
    inboundPorts?: number[];
  };
  preparation: { instructions: string; commands: string[][] };
}
export interface EnvironmentTemplate extends EnvironmentTemplateDraft {
  id: string;
  projectId: string;
  revision: number;
  updatedAt: string;
}
export interface EnvironmentTemplateAssignment {
  agentId: string;
  revision: number;
  templateId: string | null;
  templateRevision: number | null;
  updatedAt: string;
}
export interface EnvironmentToolInspection {
  name: EnvironmentToolRequirement["name"];
  state:
    "available" | "missing" | "inaccessible" | "wrong_version" | "unavailable";
  requestedVersion: string | null;
  observedVersion: string | null;
  executablePath: string | null;
  reason: string | null;
}
export interface EnvironmentTemplateInspection {
  templateId: string;
  templateRevision: number;
  checkedAt: string;
  tools: EnvironmentToolInspection[];
  limitations: string[];
  /** Execution receipts from the trusted inspector, retained by preparation. */
  processEvidenceRefs?: string[];
  /** Whether every potentially launched helper has a returned receipt. */
  processEvidenceComplete?: boolean;
  /** Omission means process settlement evidence was not supplied. */
  processesSettled?: boolean;
}
export interface EnvironmentPreparationRequest {
  caller: CallerContext;
  agentId: string;
  environmentId: string;
  requestId: string;
  expectedAssignmentRevision: number;
}
export interface EnvironmentPreparationPlan {
  request: EnvironmentPreparationRequest;
  assignment: EnvironmentTemplateAssignment;
  template: EnvironmentTemplate;
}
export interface EnvironmentTemplateSnapshot {
  templates: EnvironmentTemplate[];
  assignments: EnvironmentTemplateAssignment[];
}
export interface EnvironmentTemplateCatalogueOptions {
  directory: string;
  projectId: string;
  ownerUserId: string;
  protectedDirectories: string[];
  /** Raw foundation identities, without recursive environment-resource projection. */
  listAgents(): Promise<Agent[]>;
  /** Explicit bounded inspection through trusted host/executor tooling. Saving and
   * assignment never call this, and missing inspection never means missing tools. */
  inspect?(
    template: EnvironmentTemplate,
  ): Promise<EnvironmentTemplateInspection>;
}
interface CatalogueState {
  schema: 1;
  projectId: string;
  ownerUserId: string;
  versions: EnvironmentTemplate[];
  assignments: EnvironmentTemplateAssignment[];
}
const MAX_BYTES = 8 * 1024 * 1024;
const identifier = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 &&
  !/[\u0000-\u001f\u007f]/.test(value);
const isRevision = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;
const object = (value: unknown, keys: string[]): Record<string, unknown> => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error("Invalid environment template fields.");
  return value as Record<string, unknown>;
};
function boundedText(
  value: unknown,
  limit: number,
  allowEmpty = true,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > limit ||
    value.includes("\0") ||
    (!allowEmpty && !value.trim())
  )
    throw new Error("Invalid environment template text.");
}
const inside = (root: string, path: string) => {
  const suffix = relative(root, path);
  return suffix === "" || (!suffix.startsWith("..") && !isAbsolute(suffix));
};
function directories(
  value: unknown,
  protectedRoots: string[],
): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.length > 32 ||
    new Set(value).size !== value.length
  )
    throw new Error("Invalid template tool directories.");
  for (const path of value) {
    boundedText(path, 4096, false);
    if (
      !isAbsolute(path) ||
      path.split(/[\\/]/).includes("..") ||
      ["/", homedir(), dirname(homedir()), join(homedir(), "Library")].includes(
        path,
      ) ||
      [
        ...protectedRoots,
        join(homedir(), ".codex"),
        join(homedir(), ".ssh"),
        join(homedir(), "Library"),
      ].some((root) => inside(root, path) || inside(path, root))
    )
      throw new Error(
        "Template tool directories must be narrow and outside private controller data.",
      );
  }
}

/** Inspection may observe unavailable paths, but must never follow a configured
 * alias into personal configuration or an unreviewed installation. */
async function verifyInspectionDirectory(path: string): Promise<void> {
  let existing = path;
  for (;;) {
    try {
      if ((await realpath(existing)) !== existing)
        throw new Error(
          "Template inspection requires canonical tool directories.",
        );
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") return;
      if (code !== "ENOENT" || dirname(existing) === existing) throw error;
      existing = dirname(existing);
    }
  }
}
/** Configuration validation does not inspect, execute or install host tools. */
export function validateEnvironmentTemplateDraft(
  value: unknown,
  protectedRoots: string[] = [],
): asserts value is EnvironmentTemplateDraft {
  const draft = object(value, [
    "name",
    "description",
    "tools",
    "executableDirectories",
    "readableDirectories",
    "environment",
    "hostDocker",
    "capabilities",
    "preparation",
  ]);
  boundedText(draft.name, 120, false);
  boundedText(draft.description, 4096);
  if (!Array.isArray(draft.tools) || draft.tools.length > 2)
    throw new Error("Choose optional supported Node/npm requirements.");
  const names = new Set<string>();
  for (const entry of draft.tools) {
    const tool = object(entry, ["name", "versionRequirement"]);
    if ((tool.name !== "node" && tool.name !== "npm") || names.has(tool.name))
      throw new Error("Invalid or duplicate template tool.");
    names.add(tool.name);
    if (tool.versionRequirement !== null) {
      boundedText(tool.versionRequirement, 120, false);
      satisfiesToolVersion("22.0.0", tool.versionRequirement);
    }
  }
  directories(draft.executableDirectories, protectedRoots);
  directories(draft.readableDirectories, protectedRoots);
  if (
    !draft.environment ||
    typeof draft.environment !== "object" ||
    Array.isArray(draft.environment) ||
    Object.keys(draft.environment).length > 32
  )
    throw new Error("Invalid nonsecret template environment.");
  for (const [key, entry] of Object.entries(draft.environment)) {
    if (
      !/^[A-Z_][A-Z0-9_]{0,63}$/.test(key) ||
      /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|AUTH|PRIVATE_KEY|API_KEY)/.test(
        key,
      ) ||
      /^(?:PATH|HOME|SHELL|ENV|BASH_ENV|ZDOTDIR|TMPDIR|TMP|TEMP|CFFIXED_USER_HOME|NODE_OPTIONS|NODE_PATH|NPM_CONFIG_USERCONFIG|NPM_CONFIG_GLOBALCONFIG|GIT_CONFIG.*|SSH_.*|LD_.*|DYLD_.*|CODEX_.*|CREW_.*)$/.test(
        key,
      )
    )
      throw new Error(
        "Template environment cannot contain credentials or override host isolation.",
      );
    boundedText(entry, 4096);
  }
  if (draft.hostDocker !== undefined) {
    const docker = object(draft.hostDocker, [
      "socketPath",
      "hostAccessAcknowledged",
    ]);
    boundedText(docker.socketPath, 4096, false);
    if (
      docker.hostAccessAcknowledged !== true ||
      !isAbsolute(docker.socketPath) ||
      docker.socketPath === "/" ||
      docker.socketPath
        .split(/[\\/]/)
        .some((part) => part === "." || part === "..") ||
      /[\u0000-\u001f\u007f]/.test(docker.socketPath)
    )
      throw new Error(
        "Host Docker requires an explicit absolute socket path and acknowledgement of host-wide authority.",
      );
  }
  const capabilities = object(draft.capabilities, [
    "packageDownloads",
    "network",
    "localhostPorts",
    "inboundPorts",
  ]);
  if (
    typeof capabilities.packageDownloads !== "boolean" ||
    typeof capabilities.network !== "boolean" ||
    !Array.isArray(capabilities.localhostPorts) ||
    capabilities.localhostPorts.length > 16 ||
    new Set(capabilities.localhostPorts).size !==
      capabilities.localhostPorts.length ||
    capabilities.localhostPorts.some(
      (port) => !Number.isSafeInteger(port) || port < 1024 || port > 65535,
    ) ||
    (capabilities.inboundPorts !== undefined &&
      (!Array.isArray(capabilities.inboundPorts) ||
        capabilities.inboundPorts.length > 16 ||
        new Set(capabilities.inboundPorts).size !==
          capabilities.inboundPorts.length ||
        capabilities.inboundPorts.some(
          (port) => !Number.isSafeInteger(port) || port < 1024 || port > 65535,
        )))
  )
    throw new Error("Invalid optional environment capabilities.");
  const preparation = object(draft.preparation, ["instructions", "commands"]);
  boundedText(preparation.instructions, 16 * 1024);
  if (
    !Array.isArray(preparation.commands) ||
    preparation.commands.length > 16 ||
    Buffer.byteLength(JSON.stringify(preparation.commands)) > 48 * 1024
  )
    throw new Error(
      "Preparation commands must be bounded explicit argument arrays.",
    );
  for (const argv of preparation.commands) {
    if (!Array.isArray(argv) || argv.length === 0 || argv.length > 256)
      throw new Error("Invalid preparation command.");
    for (const argument of argv) boundedText(argument, 4096);
    if (!argv[0]) throw new Error("Preparation command needs an executable.");
  }
}

/** One project-owned catalogue. Immutable versions retain assignment/preparation
 * provenance; changing a definition never changes an assigned revision. */
export class ProjectEnvironmentTemplateCatalogue {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private failed = false;
  private readonly listeners = new Set<() => void>();
  private constructor(
    private readonly options: EnvironmentTemplateCatalogueOptions,
    private readonly lock: FileHandle,
    private state: CatalogueState,
  ) {}

  static async open(
    options: EnvironmentTemplateCatalogueOptions,
  ): Promise<ProjectEnvironmentTemplateCatalogue> {
    if (
      !isAbsolute(options.directory) ||
      !identifier(options.projectId) ||
      !identifier(options.ownerUserId) ||
      !Array.isArray(options.protectedDirectories) ||
      !options.protectedDirectories.length ||
      options.protectedDirectories.some((path) => !isAbsolute(path))
    )
      throw new Error("Invalid project template catalogue identity.");
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    const canonical = await realpath(options.directory),
      info = await lstat(options.directory);
    if (
      canonical !== options.directory ||
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.mode & 0o077 ||
      info.uid !== process.getuid?.()
    )
      throw new Error(
        "Template catalogue directory must be private, canonical and owner-controlled.",
      );
    if (!options.protectedDirectories.some((path) => inside(path, canonical)))
      throw new Error("Protected roots must include the template catalogue.");
    const lock = await open(
      join(canonical, "environment-templates.lock"),
      "wx",
      0o600,
    );
    const service: ProjectEnvironmentTemplateCatalogue =
      new ProjectEnvironmentTemplateCatalogue(options, lock, {
        schema: 1,
        projectId: options.projectId,
        ownerUserId: options.ownerUserId,
        versions: [],
        assignments: [],
      });
    try {
      await lock.writeFile(
        JSON.stringify({ pid: process.pid, token: randomUUID() }),
      );
      await lock.sync();
      let saved: FileHandle | null = null;
      try {
        saved = await open(
          join(canonical, "environment-templates.json"),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (saved) {
        try {
          const info = await saved.stat();
          if (
            !info.isFile() ||
            info.nlink !== 1 ||
            info.mode & 0o077 ||
            info.uid !== process.getuid?.() ||
            info.size > MAX_BYTES
          )
            throw new Error("Unsafe template catalogue.");
          const state: unknown = JSON.parse(await saved.readFile("utf8"));
          service.validateState(state);
          service.state = state;
        } finally {
          await saved.close();
        }
      }
      await service.persist(service.state);
      return service;
    } catch {
      await service.close().catch(() => {});
      throw new Error(
        "Template catalogue could not be opened safely; preserve it for recovery.",
      );
    }
  }

  private owner(actor: Actor) {
    if (actor.type !== "user" || actor.userId !== this.options.ownerUserId)
      throw new Error("Project owner required for environment templates.");
    if (this.closed || this.failed)
      throw new Error("Template catalogue requires recovery.");
  }
  private validateState(value: unknown): asserts value is CatalogueState {
    const state = object(value, [
      "schema",
      "projectId",
      "ownerUserId",
      "versions",
      "assignments",
    ]);
    if (
      state.schema !== 1 ||
      state.projectId !== this.options.projectId ||
      state.ownerUserId !== this.options.ownerUserId ||
      !Array.isArray(state.versions) ||
      state.versions.length > 2048 ||
      !Array.isArray(state.assignments) ||
      state.assignments.length > 4096
    )
      throw new Error("Invalid project template catalogue.");
    const versions = new Set<string>();
    for (const entry of state.versions) {
      const row = object(entry, [
        "id",
        "projectId",
        "revision",
        "updatedAt",
        "name",
        "description",
        "tools",
        "executableDirectories",
        "readableDirectories",
        "environment",
        "hostDocker",
        "capabilities",
        "preparation",
      ]);
      if (
        !identifier(row.id) ||
        row.projectId !== state.projectId ||
        !isRevision(row.revision) ||
        typeof row.updatedAt !== "string" ||
        !Number.isFinite(Date.parse(row.updatedAt))
      )
        throw new Error("Invalid template revision.");
      const { id, projectId, revision, updatedAt, ...draft } = row;
      validateEnvironmentTemplateDraft(
        draft,
        this.options.protectedDirectories,
      );
      const key = `${id}:${revision}`;
      if (versions.has(key)) throw new Error("Duplicate template revision.");
      versions.add(key);
    }
    const assignments = new Set<string>();
    for (const entry of state.assignments) {
      const row = object(entry, [
        "agentId",
        "revision",
        "templateId",
        "templateRevision",
        "updatedAt",
      ]);
      if (
        !identifier(row.agentId) ||
        !isRevision(row.revision) ||
        assignments.has(row.agentId) ||
        typeof row.updatedAt !== "string" ||
        !Number.isFinite(Date.parse(row.updatedAt)) ||
        (row.templateId === null
          ? row.templateRevision !== null
          : !identifier(row.templateId) ||
            !isRevision(row.templateRevision) ||
            !versions.has(`${row.templateId}:${row.templateRevision}`))
      )
        throw new Error("Invalid template assignment.");
      assignments.add(row.agentId);
    }
  }
  private async ownsLock() {
    try {
      const held = await this.lock.stat(),
        current = await lstat(
          join(this.options.directory, "environment-templates.lock"),
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
  private async persist(state: CatalogueState) {
    if (!(await this.ownsLock()))
      throw new Error("Template writer ownership lost.");
    this.validateState(state);
    const bytes = JSON.stringify(state);
    if (Buffer.byteLength(bytes) > MAX_BYTES)
      throw new Error("Template catalogue capacity reached.");
    const path = join(
      this.options.directory,
      `environment-templates-${randomUUID()}.tmp`,
    );
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
      await file.close();
      if (!(await this.ownsLock()))
        throw new Error("Template writer ownership lost.");
      await rename(
        path,
        join(this.options.directory, "environment-templates.json"),
      );
      const directory = await open(this.options.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await file.close().catch(() => {});
      await unlink(path).catch(() => {});
    }
  }
  private transaction<T>(
    change: (state: CatalogueState) => T | Promise<T>,
  ): Promise<T> {
    const operation = this.tail.then(async () => {
      if (this.closed || this.failed)
        throw new Error("Template catalogue requires recovery.");
      const state = structuredClone(this.state),
        result = await change(state);
      this.validateState(state);
      if (Buffer.byteLength(JSON.stringify(state)) > MAX_BYTES)
        throw new Error("Template catalogue capacity reached.");
      try {
        await this.persist(state);
      } catch {
        this.failed = true;
        throw new Error(
          "Template change could not be committed; inspect saved state before retrying.",
        );
      }
      this.state = state;
      for (const listener of this.listeners) {
        try {
          listener();
        } catch {}
      }
      return structuredClone(result);
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  ownerSnapshot(actor: Actor): EnvironmentTemplateSnapshot {
    this.owner(actor);
    const latest = new Map<string, EnvironmentTemplate>();
    for (const version of this.state.versions)
      if ((latest.get(version.id)?.revision ?? 0) < version.revision)
        latest.set(version.id, version);
    return structuredClone({
      templates: [...latest.values()],
      assignments: this.state.assignments,
    });
  }
  resolvePinned(templateId: string, revision: number): EnvironmentTemplate {
    if (this.closed || this.failed)
      throw new Error("Template catalogue requires recovery.");
    const result = this.state.versions.find(
      (row) => row.id === templateId && row.revision === revision,
    );
    if (!result) throw new Error("Exact template revision is unavailable.");
    return structuredClone(result);
  }
  /** Trusted runtime projection only; this does not grant template authority. */
  assignment(agentId: string): EnvironmentTemplateAssignment | null {
    if (this.closed || this.failed)
      throw new Error("Template catalogue requires recovery.");
    return structuredClone(
      this.state.assignments.find((row) => row.agentId === agentId) ?? null,
    );
  }
  async saveTemplate(
    actor: Actor,
    input: {
      id: string | null;
      expectedRevision: number | null;
      draft: EnvironmentTemplateDraft;
    },
  ): Promise<EnvironmentTemplate> {
    this.owner(actor);
    input = structuredClone(input);
    object(input, ["id", "expectedRevision", "draft"]);
    if (
      (input.id !== null && !identifier(input.id)) ||
      (input.expectedRevision !== null &&
        !isRevision(input.expectedRevision)) ||
      (input.id === null) !== (input.expectedRevision === null)
    )
      throw new Error("Exact template revision required.");
    validateEnvironmentTemplateDraft(
      input.draft,
      this.options.protectedDirectories,
    );
    return this.transaction((state) => {
      const id = input.id ?? randomUUID();
      const previous = state.versions
        .filter((row) => row.id === id)
        .reduce<EnvironmentTemplate | undefined>(
          (latest, row) =>
            !latest || row.revision > latest.revision ? row : latest,
          undefined,
        );
      if ((previous?.revision ?? null) !== input.expectedRevision)
        throw new Error(
          "Template changed; retain the draft and review the current revision.",
        );
      const saved: EnvironmentTemplate = {
        ...input.draft,
        name: input.draft.name.trim(),
        id,
        projectId: this.options.projectId,
        revision: (previous?.revision ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      };
      state.versions.push(saved);
      return saved;
    });
  }
  async assign(
    actor: Actor,
    input: {
      agentId: string;
      expectedRevision: number | null;
      templateId: string | null;
      templateRevision: number | null;
    },
  ): Promise<EnvironmentTemplateAssignment> {
    this.owner(actor);
    input = structuredClone(input);
    object(input, [
      "agentId",
      "expectedRevision",
      "templateId",
      "templateRevision",
    ]);
    if (
      !identifier(input.agentId) ||
      (input.expectedRevision !== null &&
        !isRevision(input.expectedRevision)) ||
      (input.templateId === null
        ? input.templateRevision !== null
        : !identifier(input.templateId) || !isRevision(input.templateRevision))
    )
      throw new Error("Invalid exact template assignment.");
    return this.transaction(async (state) => {
      await this.verifyAgent(input.agentId);
      const previous = state.assignments.find(
        (row) => row.agentId === input.agentId,
      );
      if ((previous?.revision ?? null) !== input.expectedRevision)
        throw new Error(
          "Template assignment changed; retain the draft and review the current revision.",
        );
      if (
        input.templateId !== null &&
        !state.versions.some(
          (row) =>
            row.id === input.templateId &&
            row.revision === input.templateRevision,
        )
      )
        throw new Error("Exact template revision is unavailable.");
      const assignment: EnvironmentTemplateAssignment = {
        agentId: input.agentId,
        revision: (previous?.revision ?? 0) + 1,
        templateId: input.templateId,
        templateRevision: input.templateRevision,
        updatedAt: new Date().toISOString(),
      };
      if (previous) Object.assign(previous, assignment);
      else state.assignments.push(assignment);
      return assignment;
    });
  }
  /** Trusted owner preset application only. A retry may observe its exact pin,
   * but cannot replace or undo a later explicit owner assignment. */
  async assignPreset(
    actor: Actor,
    input: { agentId: string; templateId: string; templateRevision: number },
  ): Promise<EnvironmentTemplateAssignment> {
    this.owner(actor);
    input = structuredClone(input);
    object(input, ["agentId", "templateId", "templateRevision"]);
    if (
      !identifier(input.agentId) ||
      !identifier(input.templateId) ||
      !isRevision(input.templateRevision)
    )
      throw new Error("Invalid exact preset template assignment.");
    return this.transaction(async (state) => {
      await this.verifyAgent(input.agentId);
      if (
        !state.versions.some(
          (row) =>
            row.id === input.templateId &&
            row.revision === input.templateRevision,
        )
      )
        throw new Error("Exact template revision is unavailable.");
      const current = state.assignments.find(
        (row) => row.agentId === input.agentId,
      );
      if (current) {
        if (
          current.templateId === input.templateId &&
          current.templateRevision === input.templateRevision
        )
          return current;
        throw new Error(
          "Owner template assignment changed; preserve the current choice.",
        );
      }
      const assignment: EnvironmentTemplateAssignment = {
        agentId: input.agentId,
        templateId: input.templateId,
        templateRevision: input.templateRevision,
        revision: 1,
        updatedAt: new Date().toISOString(),
      };
      state.assignments.push(assignment);
      return assignment;
    });
  }
  private async verifyAgent(agentId: string) {
    const agent = (await this.options.listAgents()).find(
      (row) => row.id === agentId,
    );
    if (
      !agent ||
      agent.projectId !== this.options.projectId ||
      agent.archivedAt !== null
    )
      throw new Error("Current project agent required.");
  }
  async inspect(
    actor: Actor,
    input: { templateId: string; templateRevision: number },
  ): Promise<EnvironmentTemplateInspection> {
    this.owner(actor);
    const template = this.resolvePinned(
      input.templateId,
      input.templateRevision,
    );
    if (!this.options.inspect)
      return {
        templateId: template.id,
        templateRevision: template.revision,
        checkedAt: new Date().toISOString(),
        tools: template.tools.map((tool) => ({
          name: tool.name,
          state: "unavailable",
          requestedVersion: tool.versionRequirement,
          observedVersion: null,
          executablePath: null,
          reason:
            "Tool inspection is unavailable; no installation or execution was attempted.",
        })),
        limitations: [
          "A trusted runtime inspection is required before preparation.",
        ],
      };
    try {
      for (const path of new Set([
        ...template.executableDirectories,
        ...template.readableDirectories,
      ]))
        await verifyInspectionDirectory(path);
    } catch {
      return {
        templateId: template.id,
        templateRevision: template.revision,
        checkedAt: new Date().toISOString(),
        tools: template.tools.map((tool) => ({
          name: tool.name,
          state: "unavailable",
          requestedVersion: tool.versionRequirement,
          observedVersion: null,
          executablePath: null,
          reason: "Template inspection requires canonical tool directories.",
        })),
        limitations: [
          "Tool directories could not be verified; no helper was launched.",
        ],
        processEvidenceRefs: [],
        processEvidenceComplete: true,
        processesSettled: true,
      };
    }
    const report = structuredClone(await this.options.inspect(template));
    if (
      report.templateId !== template.id ||
      report.templateRevision !== template.revision ||
      !Array.isArray(report.tools) ||
      report.tools.length !== template.tools.length ||
      !Array.isArray(report.limitations) ||
      report.limitations.length > 32 ||
      (report.processesSettled !== undefined &&
        typeof report.processesSettled !== "boolean") ||
      (report.processEvidenceComplete !== undefined &&
        typeof report.processEvidenceComplete !== "boolean") ||
      (report.processEvidenceRefs !== undefined &&
        (!Array.isArray(report.processEvidenceRefs) ||
          report.processEvidenceRefs.length > 32 ||
          new Set(report.processEvidenceRefs).size !==
            report.processEvidenceRefs.length ||
          report.processEvidenceRefs.some((ref) => !identifier(ref)))) ||
      !Number.isFinite(Date.parse(report.checkedAt))
    )
      throw new Error("Tool inspection did not match the exact template.");
    for (const tool of template.tools) {
      const result = report.tools.filter((row) => row.name === tool.name);
      if (
        result.length !== 1 ||
        ![
          "available",
          "missing",
          "inaccessible",
          "wrong_version",
          "unavailable",
        ].includes(result[0].state)
      )
        throw new Error("Invalid tool inspection evidence.");
      const row = result[0];
      row.requestedVersion = tool.versionRequirement;
      if (row.observedVersion !== null) boundedText(row.observedVersion, 120);
      if (row.executablePath !== null)
        directories([row.executablePath], this.options.protectedDirectories);
      if (row.reason !== null) boundedText(row.reason, 4096);
      if (
        row.state === "available" &&
        (!row.observedVersion || !row.executablePath)
      )
        throw new Error("Available tool needs version and path evidence.");
      if (
        row.state === "available" &&
        tool.versionRequirement &&
        !satisfiesToolVersion(row.observedVersion!, tool.versionRequirement)
      )
        row.state = "wrong_version";
    }
    for (const limitation of report.limitations) boundedText(limitation, 4096);
    return report;
  }
  /** Resolve only. The environment service must freshly authorize this request
   * and persist its operation before executing any preparation. No grants change. */
  async resolvePreparation(
    input: EnvironmentPreparationRequest,
  ): Promise<EnvironmentPreparationPlan> {
    input = structuredClone(input);
    if (
      !input.caller ||
      input.caller.projectId !== this.options.projectId ||
      !identifier(input.caller.agentId) ||
      !identifier(input.caller.sessionId) ||
      !identifier(input.agentId) ||
      !identifier(input.environmentId) ||
      !identifier(input.requestId) ||
      !isRevision(input.expectedAssignmentRevision)
    )
      throw new Error("Invalid preparation identity.");
    await this.verifyAgent(input.agentId);
    const assignment = this.state.assignments.find(
      (row) => row.agentId === input.agentId,
    );
    if (
      !assignment ||
      assignment.revision !== input.expectedAssignmentRevision ||
      !assignment.templateId ||
      !assignment.templateRevision
    )
      throw new Error("Agent template assignment changed or is unavailable.");
    return {
      request: input,
      assignment: structuredClone(assignment),
      template: this.resolvePinned(
        assignment.templateId,
        assignment.templateRevision,
      ),
    };
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.tail;
    this.listeners.clear();
    try {
      if (await this.ownsLock())
        await unlink(
          join(this.options.directory, "environment-templates.lock"),
        );
    } finally {
      await this.lock.close();
    }
  }
}
