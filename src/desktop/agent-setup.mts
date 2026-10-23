import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { UnifiedApplication } from "../agents/service-composition.mjs";
import type {
  Agent,
  AgentCreationPreset,
  CrewPermission,
  PermissionGroup,
} from "../agents/contracts.mjs";
import type { PreparedFolderAccess } from "../agents/environments.mjs";
import type { AccessOwnerView } from "../access/owner-contracts.mjs";
import type {
  AgentSetupDraft,
  AgentSetupRecord,
  AgentSetupReview,
} from "./agent-setup-contracts.mjs";

/** Only bounded local validation messages may cross the desktop bridge. */
export class AgentSetupError extends Error {
  readonly code = "setup_invalid";
}

type Application = Pick<
  UnifiedApplication,
  "ownerApi" | "accessOwnerApi" | "environmentOwnerApi" | "subscription"
>;
interface Options {
  directory: string;
  project: { id: string; name: string; directory: string };
  application: Application;
  changed?(): void;
  created?(): Promise<void>;
}
interface Checkpoint {
  groupId: string;
  presetId: string;
  prepared: PreparedFolderAccess | null;
  group: PermissionGroup | null;
  preset: AgentCreationPreset | null;
  creationAttempted: boolean;
  agentId: string | null;
  assignmentAttempted: boolean;
  assignmentRevision: number | null;
  profileAttempted: boolean;
  profileResult: { profile: Agent["profile"]; skills: Agent["skills"] } | null;
  primaryAttempted: boolean;
  primaryRevision: number | null;
}
interface RetainedSetup {
  record: AgentSetupRecord;
  runtime: AccessOwnerView["runtimeDefaults"];
  /** Captured before editing; old drafts cannot restore a later revocation. */
  assignmentBaseline: number | null;
  profileBaseline: number | null;
  checkpoint: Checkpoint;
}
interface Journal extends RetainedSetup {
  schema: 1;
  projectId: string;
  retained: RetainedSetup[];
}
const clone = <T,>(value: T): T => structuredClone(value);
const same = isDeepStrictEqual;
const unique = <T,>(values: T[]) => [...new Set(values)];
const idsEqual = (a: string[], b: string[]) =>
  same([...a].sort(), [...b].sort());
const stale = () =>
  new AgentSetupError(
    "Setup choices changed. Reload the current setup and review again before applying.",
  );
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new AgentSetupError("Invalid guided setup fields.");
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 512): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  )
    throw new AgentSetupError("Invalid guided setup text.");
}
function ids(value: unknown): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.length > 256 ||
    unique(value).length !== value.length
  )
    throw new AgentSetupError("Choose each setup item once.");
  for (const id of value) {
    string(id);
    if (!id || /\s/.test(id))
      throw new AgentSetupError("Invalid setup identity.");
  }
}
function draftInput(value: unknown): AgentSetupDraft {
  const row = object(value, [
    "step",
    "mode",
    "agentId",
    "name",
    "instructions",
    "personality",
    "pictureRef",
    "voice",
    "skills",
    "folderAccess",
    "groupMode",
    "groupName",
    "groupIds",
    "crewActions",
    "serviceConnectionIds",
    "serviceCapabilities",
    "makePrimary",
  ]);
  if (
    !Number.isInteger(row.step) ||
    Number(row.step) < 0 ||
    Number(row.step) > 20 ||
    !["create", "repair"].includes(String(row.mode)) ||
    !["none", "read_only", "read_write"].includes(String(row.folderAccess)) ||
    !["new", "existing"].includes(String(row.groupMode)) ||
    typeof row.makePrimary !== "boolean"
  )
    throw new AgentSetupError("Invalid setup choices.");
  string(row.name, 1000);
  string(row.instructions, 200_000);
  string(row.personality, 200_000);
  for (const value of [row.pictureRef, row.voice])
    if (value !== null) {
      string(value, 256);
      if (!value || /[\u0000-\u001f\u007f]/.test(value))
        throw new AgentSetupError("Invalid profile choice.");
    }
  if (!Array.isArray(row.skills) || row.skills.length > 256)
    throw new AgentSetupError("Invalid skill selections.");
  const skillIds: string[] = [];
  for (const selection of row.skills) {
    const skill = object(selection, ["skillId", "enabled"]);
    string(skill.skillId, 256);
    if (!skill.skillId || typeof skill.enabled !== "boolean")
      throw new AgentSetupError("Invalid skill selection.");
    skillIds.push(skill.skillId);
  }
  if (unique(skillIds).length !== skillIds.length)
    throw new AgentSetupError("Choose each skill once.");
  string(row.groupName, 1000);
  if (row.agentId !== null) {
    string(row.agentId);
    if (!row.agentId) throw new AgentSetupError("Choose an existing agent.");
  }
  if ((row.mode === "create") !== (row.agentId === null))
    throw new AgentSetupError("Setup mode does not match its agent.");
  ids(row.groupIds);
  ids(row.crewActions);
  ids(row.serviceConnectionIds);
  if (
    !Array.isArray(row.serviceCapabilities) ||
    row.serviceCapabilities.length > 256
  )
    throw new AgentSetupError("Invalid service choices.");
  const connections: string[] = [];
  for (const entry of row.serviceCapabilities) {
    const item = object(entry, ["connectionId", "capabilities"]);
    string(item.connectionId);
    ids(item.capabilities);
    if (!row.serviceConnectionIds.includes(item.connectionId))
      throw new AgentSetupError(
        "Select the service connection before its capabilities.",
      );
    connections.push(item.connectionId);
  }
  if (unique(connections).length !== connections.length)
    throw new AgentSetupError("Choose each service once.");
  return clone(row as unknown as AgentSetupDraft);
}
const checkpoint = (): Checkpoint => ({
  groupId: randomUUID(),
  presetId: randomUUID(),
  prepared: null,
  group: null,
  preset: null,
  creationAttempted: false,
  agentId: null,
  assignmentAttempted: false,
  assignmentRevision: null,
  profileAttempted: false,
  profileResult: null,
  primaryAttempted: false,
  primaryRevision: null,
});
const draftKey = (draft: AgentSetupDraft) =>
  draft.mode === "create" ? "create" : `repair:${draft.agentId}`;
const selectedProfile = (
  draft: AgentSetupDraft,
): Omit<Agent["profile"], "revision"> => ({
  name: draft.name,
  pictureRef: draft.pictureRef,
  personality: draft.personality,
  systemPrompt: draft.instructions,
  voice: draft.voice,
});
const profileMatches = (agent: Agent, draft: AgentSetupDraft) =>
  same(
    {
      name: agent.profile.name,
      pictureRef: agent.profile.pictureRef ?? null,
      personality: agent.profile.personality ?? "",
      systemPrompt: agent.profile.systemPrompt,
      voice: agent.profile.voice ?? null,
    },
    selectedProfile(draft),
  ) &&
  idsEqual(
    (agent.skills ?? [])
      .filter((skill) => skill.enabled)
      .map((skill) => skill.skillId),
    draft.skills.filter((skill) => skill.enabled).map((skill) => skill.skillId),
  );

/** A private intent journal coordinates existing authorities. It never grants
 * access, starts an agent, stores credentials, or replaces native history. */
export async function openAgentSetup(options: Options) {
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const root = await realpath(options.directory),
    rootStat = await lstat(options.directory);
  if (
    rootStat.isSymbolicLink() ||
    !rootStat.isDirectory() ||
    rootStat.uid !== process.getuid?.() ||
    rootStat.mode & 0o077
  )
    throw new AgentSetupError("Guided setup requires private project storage.");
  const path = join(root, "agent-setup.json");
  let journal: Journal | null = null;
  try {
    const entry = await lstat(path);
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      entry.size > 2_000_000 ||
      entry.uid !== process.getuid?.() ||
      entry.mode & 0o077
    )
      throw new AgentSetupError("Guided setup state cannot be read safely.");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      journal = JSON.parse(await file.readFile("utf8")) as Journal;
    } finally {
      await file.close();
    }
    if (
      journal.schema !== 1 ||
      journal.projectId !== options.project.id ||
      !Number.isSafeInteger(journal.record.revision) ||
      journal.record.revision < 1 ||
      !journal.checkpoint
    )
      throw new AgentSetupError("Guided setup state needs recovery.");
    journal.retained ??= [];
    if (!Array.isArray(journal.retained) || journal.retained.length > 100)
      throw new AgentSetupError("Retained setup drafts need recovery.");
    let legacyAgents: Agent[] | undefined;
    for (const saved of [journal, ...journal.retained]) {
      if (
        !saved?.record ||
        !saved.checkpoint ||
        !Number.isSafeInteger(saved.record.revision) ||
        saved.record.revision < 1 ||
        !["draft", "reviewed", "applying", "complete"].includes(
          saved.record.phase,
        )
      )
        throw new AgentSetupError("Retained setup state is invalid.");
      const draft = saved.record.draft;
      const legacy = ["personality", "pictureRef", "voice", "skills"].some(
        (field) => !Object.hasOwn(draft, field),
      );
      if (legacy) {
        if (draft.mode === "repair" && !legacyAgents)
          legacyAgents = (await options.application.ownerApi.snapshot()).agents;
        const agent = legacyAgents?.find(
          (row) => row.id === draft.agentId && !row.archivedAt,
        );
        saved.record.draft = Object.assign(
          {
            personality: agent?.profile.personality ?? "",
            pictureRef: agent?.profile.pictureRef ?? null,
            voice: agent?.profile.voice ?? null,
            skills: clone(agent?.skills ?? []),
          },
          draft,
        );
      }
      // Old unreviewed edit drafts have no trustworthy profile baseline. They
      // remain visible but require explicit reload before any profile write.
      if (!Object.hasOwn(saved, "profileBaseline"))
        saved.profileBaseline = saved.record.review?.revisions.profile ?? null;
      saved.checkpoint.profileAttempted ??= false;
      saved.checkpoint.profileResult ??= null;
      if (legacy && saved.record.phase === "reviewed") {
        saved.record.phase = "draft";
        saved.record.review = null;
        saved.record.revision++;
      }
      saved.record.draft = draftInput(saved.record.draft);
      for (const revision of [saved.assignmentBaseline, saved.profileBaseline])
        if (
          revision !== null &&
          (!Number.isSafeInteger(revision) || revision < 1)
        )
          throw new AgentSetupError("Setup baseline is invalid.");
      for (const id of [
        saved.record.id,
        saved.checkpoint.groupId,
        saved.checkpoint.presetId,
      ])
        string(id);
      for (const flag of [
        saved.checkpoint.creationAttempted,
        saved.checkpoint.assignmentAttempted,
        saved.checkpoint.profileAttempted,
        saved.checkpoint.primaryAttempted,
      ])
        if (typeof flag !== "boolean")
          throw new AgentSetupError("Setup recovery checkpoint is invalid.");
    }
    if (
      journal.retained.some((saved) => saved.record.phase === "applying") ||
      unique(
        [journal, ...journal.retained].map((saved) =>
          draftKey(saved.record.draft),
        ),
      ).length !==
        journal.retained.length + 1
    )
      throw new AgentSetupError("Retained setup targets need recovery.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let tail: Promise<unknown> = Promise.resolve();
  const view = () => (journal ? clone(journal.record) : null);
  const retainedFor = (draft: AgentSetupDraft) => {
    if (!journal) return [];
    const key = draftKey(draft),
      retained = journal.retained.filter(
        (saved) => draftKey(saved.record.draft) !== key,
      );
    if (
      draftKey(journal.record.draft) !== key &&
      journal.record.phase !== "complete"
    ) {
      const {
        schema: _schema,
        projectId: _projectId,
        retained: _retained,
        ...active
      } = journal;
      retained.push(clone(active));
    }
    if (retained.length > 100)
      throw new AgentSetupError(
        "Too many retained setup drafts. Complete an existing draft before opening another.",
      );
    return clone(retained);
  };
  const save = async (next: Journal) => {
    const bytes = `${JSON.stringify(next)}\n`;
    if (Buffer.byteLength(bytes) > 2_000_000)
      throw new AgentSetupError(
        "Saved setup drafts are too large. Complete or explicitly reload an existing draft before adding more content.",
      );
    const temp = join(root, `.agent-setup-${randomUUID()}.tmp`);
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temp, path);
      const directory = await open(root, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await rm(temp, { force: true });
    }
    journal = clone(next);
    options.changed?.();
  };
  const update = async (mutate: (next: Journal) => void) => {
    if (!journal) throw new AgentSetupError("Begin guided setup first.");
    const next = clone(journal);
    next.record.revision++;
    mutate(next);
    await save(next);
  };
  const check = (revision: unknown) => {
    if (revision !== (journal?.record.revision ?? null)) throw stale();
  };
  const snapshots = async () => {
    const [access, owner] = await Promise.all([
      options.application.accessOwnerApi.snapshot(),
      options.application.ownerApi.snapshot(),
    ]);
    if (
      access.projectId !== options.project.id ||
      owner.projectId !== options.project.id
    )
      throw new AgentSetupError("Setup project identity changed.");
    return {
      access,
      owner,
      environments: options.application.environmentOwnerApi.snapshot(),
    };
  };
  type Snapshots = Awaited<ReturnType<typeof snapshots>>;
  const target = (snapshot: Snapshots, draft: AgentSetupDraft) => {
    const agent = snapshot.owner.agents.find(
      (item) => item.id === draft.agentId && !item.archivedAt,
    );
    if (draft.mode === "repair" && !agent)
      throw new AgentSetupError("The selected agent is unavailable.");
    return agent;
  };
  const createDraft = async (mode: "create" | "repair", agentId?: string) => {
    const snapshot = await snapshots();
    const agent =
      mode === "repair"
        ? snapshot.owner.agents.find(
            (row) => row.id === agentId && !row.archivedAt,
          )
        : undefined;
    if (mode === "repair" && !agent)
      throw new AgentSetupError("Choose an available agent to repair.");
    const assignment = snapshot.access.assignments.find(
      (row) => row.agentId === agent?.id,
    );
    const groups = snapshot.access.groups.filter((group) =>
      assignment?.permissionGroupIds.includes(group.id),
    );
    const policies = unique(
      groups.flatMap((group) => group.grants.environmentPolicyIds),
    );
    const workspaces = snapshot.environments.workspaces.filter(
      (workspace) =>
        policies.includes(workspace.policy.id) &&
        workspace.workspace.path === options.project.directory,
    );
    const draft: AgentSetupDraft = {
      step: mode === "repair" ? 2 : 0,
      mode,
      agentId: agent?.id ?? null,
      name:
        agent?.profile.name ??
        (snapshot.owner.projectSettings.primaryAgentId ? "Agent" : "Manager"),
      instructions: agent?.profile.systemPrompt ?? "",
      personality: agent?.profile.personality ?? "",
      pictureRef: agent?.profile.pictureRef ?? null,
      voice: agent?.profile.voice ?? null,
      skills: clone(agent?.skills ?? []),
      folderAccess: workspaces.length
        ? workspaces.some((row) => row.writable)
          ? "read_write"
          : "read_only"
        : "none",
      groupMode: agent ? "existing" : "new",
      groupName: `${options.project.name} team`,
      groupIds: [...(assignment?.permissionGroupIds ?? [])],
      crewActions: [],
      serviceConnectionIds: [...(assignment?.serviceConnectionIds ?? [])],
      serviceCapabilities: [],
      makePrimary:
        !snapshot.owner.projectSettings.primaryAgentId ||
        snapshot.owner.projectSettings.primaryAgentId === agent?.id,
    };
    return draft;
  };
  const persistDraft = async (draft: AgentSetupDraft, fresh: boolean) => {
    if (journal?.record.phase === "applying")
      throw new AgentSetupError(
        "Finish or reconcile the retained setup before changing its choices.",
      );
    if (!fresh && journal?.record.phase === "complete")
      throw new AgentSetupError(
        "Start a new setup before changing completed choices.",
      );
    if (
      !fresh &&
      journal &&
      (draft.mode !== journal.record.draft.mode ||
        draft.agentId !== journal.record.draft.agentId)
    )
      throw new AgentSetupError("Start a new setup to change its target.");
    const snapshot = await snapshots();
    const groups = snapshot.access.groups.filter((group) =>
      draft.groupIds.includes(group.id),
    );
    const inheritedSkills = groups.flatMap(
      (group) => group.grants.skillIds ?? [],
    );
    const inheritedConnections = groups.flatMap((group) =>
      group.grants.services.map((grant) => grant.connectionId),
    );
    draft.skills = unique([
      ...inheritedSkills,
      ...(draft.groupMode === "new"
        ? draft.skills
            .filter((skill) => skill.enabled)
            .map((skill) => skill.skillId)
        : []),
    ]).map((skillId) => ({ skillId, enabled: true }));
    draft.serviceConnectionIds = unique([
      ...inheritedConnections,
      ...(draft.groupMode === "new" ? draft.serviceConnectionIds : []),
    ]);
    const agent = target(snapshot, draft);
    const assignmentRevision = agent
      ? (snapshot.access.assignments.find((row) => row.agentId === agent.id)
          ?.revision ?? null)
      : null;
    if (fresh && agent) {
      const assignment = snapshot.access.assignments.find(
        (row) => row.agentId === agent.id,
      );
      if (
        !profileMatches(agent, draft) ||
        !idsEqual(draft.groupIds, assignment?.permissionGroupIds ?? []) ||
        !idsEqual(
          draft.serviceConnectionIds,
          assignment?.serviceConnectionIds ?? [],
        )
      )
        throw stale();
    }
    if (
      !fresh &&
      journal &&
      agent &&
      assignmentRevision !== journal.assignmentBaseline
    )
      throw new AgentSetupError(
        "This agent's access changed while you were editing. Reload its current access before saving; previous choices have not been restored.",
      );
    if (
      !fresh &&
      journal &&
      agent &&
      agent.profile.revision !== journal.profileBaseline
    )
      throw new AgentSetupError(
        "This agent's profile changed while you were editing. Reload its current settings before saving; previous choices have not been restored.",
      );
    const next: Journal = {
      schema: 1,
      projectId: options.project.id,
      record: {
        id: fresh || !journal ? randomUUID() : journal.record.id,
        revision: (journal?.record.revision ?? 0) + 1,
        draft,
        phase: "draft",
        review: null,
        result: null,
        error: null,
      },
      runtime: null,
      assignmentBaseline:
        fresh || !journal ? assignmentRevision : journal.assignmentBaseline,
      profileBaseline:
        fresh || !journal
          ? (agent?.profile.revision ?? null)
          : journal.profileBaseline,
      checkpoint: fresh || !journal ? checkpoint() : journal.checkpoint,
      retained: fresh || !journal ? retainedFor(draft) : journal.retained,
    };
    await save(next);
  };
  const newGrants = (draft: AgentSetupDraft): PermissionGroup["grants"] => {
    const crew: CrewPermission[] = draft.crewActions.map((action) => ({
      action,
    }));
    // These group capabilities are shown in final review and come from
    // the explicit folder choice. Completion verifies the helper agrees.
    if (draft.folderAccess !== "none")
      for (const action of [
        "environments.read",
        "environments.attach",
        "environments.execute",
      ] as const)
        if (!crew.some((grant) => grant.action === action))
          crew.push({ action });
    return {
      crew,
      services: clone(draft.serviceCapabilities),
      skillIds: draft.skills
        .filter((skill) => skill.enabled)
        .map((skill) => skill.skillId),
      environmentPolicyIds: [],
    };
  };
  const buildReview = async (
    draft: AgentSetupDraft,
    snapshot: Snapshots,
  ): Promise<AgentSetupReview> => {
    if (
      !draft.name.trim() ||
      (draft.groupMode === "new" && !draft.groupName.trim())
    )
      throw new AgentSetupError("Give the agent and new shared group a name.");
    if (
      (await realpath(options.project.directory)) !== options.project.directory
    )
      throw new AgentSetupError("The registered project folder changed.");
    const agent = target(snapshot, draft),
      access = snapshot.access;
    if (
      agent &&
      (access.assignments.find((row) => row.agentId === agent.id)?.revision ??
        null) !== journal!.assignmentBaseline
    )
      throw new AgentSetupError(
        "This agent's access changed while you were editing. Reload its current access before reviewing; previous choices have not been restored.",
      );
    if (agent && agent.profile.revision !== journal!.profileBaseline)
      throw new AgentSetupError(
        "This agent's profile changed while you were editing. Reload its current settings before reviewing; previous choices have not been restored.",
      );
    const selectedSkills = draft.skills.map((selection) => {
      const skill = snapshot.owner.skills.find(
        (row) => row.id === selection.skillId,
      );
      if (!skill)
        throw new AgentSetupError(
          "A selected skill is unavailable. Review current project skills before saving.",
        );
      return { id: skill.id, revision: skill.revision };
    });
    if (
      draft.crewActions.some(
        (action) =>
          !access.crewCapabilities.some((choice) => choice.action === action),
      )
    )
      throw new AgentSetupError(
        "Choose current owner-approved Crew capabilities.",
      );
    if (
      draft.serviceCapabilities.some((grant) =>
        grant.capabilities.some(
          (id) =>
            !access.capabilities.some(
              (capability) =>
                capability.connectionId === grant.connectionId &&
                capability.id === id,
            ),
        ),
      )
    )
      throw new AgentSetupError(
        "A selected service capability is unavailable. Verify the connection and review its current capabilities.",
      );
    if (
      draft.groupMode === "existing" &&
      (draft.crewActions.length || draft.serviceCapabilities.length)
    )
      throw new AgentSetupError(
        "Select New shared group to add capabilities. Existing groups are preserved.",
      );
    const groups = draft.groupIds.map((id) => {
      const group = access.groups.find((row) => row.id === id);
      if (!group)
        throw new AgentSetupError("A selected shared group is unavailable.");
      return group;
    });
    const connections = draft.serviceConnectionIds.map((id) => {
      const connection = access.connections.find((row) => row.id === id);
      if (!connection)
        throw new AgentSetupError(
          "A selected service connection is unavailable.",
        );
      return { id, name: connection.name, revision: connection.revision };
    });
    const policyIds = unique(
      groups.flatMap((group) => group.grants.environmentPolicyIds),
    );
    const workspaces = policyIds.map((id) => {
      const saved = access.environmentPolicies.find((row) => row.id === id);
      const workspace = snapshot.environments.workspaces.find(
        (row) => row.policy.id === id,
      );
      if (!saved || !workspace || !same(saved, workspace.policy))
        throw new AgentSetupError(
          "A selected group's workspace policy requires owner reconciliation.",
        );
      if (
        workspace.workspace.path !== options.project.directory ||
        draft.folderAccess === "none" ||
        (draft.folderAccess === "read_only" && workspace.writable) ||
        workspace.managedWorktreeRoot ||
        workspace.executableDirectories.length
      )
        throw new AgentSetupError(
          "Selected groups grant broader folder access than this review. Deselect those groups or change the folder choice; shared groups will not be changed.",
        );
      return {
        policyId: id,
        revision: saved.revision,
        directory: workspace.workspace.path,
        access: workspace.writable
          ? ("read_write" as const)
          : ("read_only" as const),
      };
    });
    const planned =
      draft.groupMode === "new"
        ? {
            id: journal!.checkpoint.groupId,
            name: draft.groupName,
            grants: newGrants(draft),
          }
        : null;
    const crewGrants = [
      ...groups.flatMap((group) => group.grants.crew),
      ...(planned?.grants.crew ?? []),
    ];
    const services = [
      ...groups.flatMap((group) => group.grants.services),
      ...(planned?.grants.services ?? []),
    ];
    const effectiveServices = new Map<string, string[]>();
    for (const grant of services)
      effectiveServices.set(
        grant.connectionId,
        unique([
          ...(effectiveServices.get(grant.connectionId) ?? []),
          ...grant.capabilities,
        ]),
      );
    if (draft.groupMode === "existing" && draft.folderAccess !== "none") {
      if (
        !workspaces.some(
          (workspace) => workspace.access === draft.folderAccess,
        ) ||
        ![
          "environments.read",
          "environments.attach",
          "environments.execute",
        ].every((action) => crewGrants.some((grant) => grant.action === action))
      )
        throw new AgentSetupError(
          "Selected groups do not provide the requested folder access. Choose New shared group to add it, or change the folder choice.",
        );
    }
    const warnings: string[] = [];
    if (draft.folderAccess === "none")
      warnings.push("This agent will have no approved project folder access.");
    if (planned)
      warnings.push(
        "The new named group can be reused by other agents. Later edits to a shared group affect all its members.",
      );
    if (draft.mode === "create") {
      const manager =
        !draft.makePrimary &&
        snapshot.owner.agents.find(
          (row) =>
            row.id === snapshot.owner.projectSettings.primaryAgentId &&
            !row.archivedAt,
        );
      warnings.push(
        manager
          ? `This agent will report to ${manager.profile.name}, the current primary agent.`
          : "This agent will report directly to you.",
      );
    }
    return {
      draftRevision: journal!.record.revision + 1,
      directory: options.project.directory,
      folderAccess: draft.folderAccess,
      groups: clone(groups),
      newGroup: planned,
      connections,
      workspaces,
      crewGrants: clone(crewGrants),
      serviceCapabilities: [...effectiveServices].map(
        ([connectionId, capabilities]) => ({ connectionId, capabilities }),
      ),
      warnings,
      revisions: {
        groups: groups.map(({ id, revision }) => ({ id, revision })),
        connections: connections.map(({ id, revision }) => ({ id, revision })),
        policies: workspaces.map(({ policyId, revision }) => ({
          id: policyId,
          revision,
        })),
        assignment: agent
          ? (access.assignments.find((row) => row.agentId === agent.id)
              ?.revision ?? null)
          : null,
        projectSettings: snapshot.owner.projectSettings.revision,
        profile: agent?.profile.revision ?? null,
        skills: selectedSkills,
      },
    };
  };
  const assignmentMatches = (
    assignment: AccessOwnerView["assignments"][number] | undefined,
    groupIds: string[],
    connections: string[],
  ) =>
    Boolean(
      assignment &&
      idsEqual(assignment.permissionGroupIds, groupIds) &&
      idsEqual(assignment.serviceConnectionIds, connections),
    );
  const selectedIds = () =>
    unique([
      ...journal!.record.draft.groupIds,
      ...(journal!.record.draft.groupMode === "new"
        ? [journal!.checkpoint.groupId]
        : []),
    ]);
  const assertCurrent = async () => {
    const current = journal!,
      review = current.record.review!;
    const snapshot = await snapshots(),
      { access, owner } = snapshot;
    for (const [expected, rows] of [
      [review.revisions.groups, access.groups],
      [review.revisions.connections, access.connections],
      [review.revisions.policies, access.environmentPolicies],
    ] as const)
      for (const selected of expected)
        if (
          !rows.some(
            (row) =>
              row.id === selected.id && row.revision === selected.revision,
          )
        )
          throw stale();
    if (
      current.record.draft.mode === "create" &&
      !same(access.runtimeDefaults, current.runtime)
    )
      throw stale();
    for (const skill of review.revisions.skills ?? [])
      if (
        !owner.skills.some(
          (row) => row.id === skill.id && row.revision === skill.revision,
        )
      )
        throw stale();
    if (current.record.draft.mode === "repair") {
      const agent = target(snapshot, current.record.draft)!;
      if (
        agent.profile.revision !== review.revisions.profile &&
        !(
          current.checkpoint.profileAttempted &&
          agent.profile.revision === (review.revisions.profile ?? 0) + 1 &&
          profileMatches(agent, current.record.draft)
        )
      )
        throw stale();
      if (
        current.checkpoint.profileResult &&
        !same(current.checkpoint.profileResult, {
          profile: agent.profile,
          skills: agent.skills ?? [],
        })
      )
        throw stale();
      const assignment = access.assignments.find(
        (row) => row.agentId === agent.id,
      );
      if (
        (assignment?.revision ?? null) !== review.revisions.assignment &&
        !(
          current.checkpoint.assignmentAttempted &&
          assignment?.revision === (review.revisions.assignment ?? 0) + 1 &&
          assignmentMatches(
            assignment,
            selectedIds(),
            current.record.draft.serviceConnectionIds,
          )
        )
      )
        throw stale();
    }
    if (
      owner.projectSettings.revision !== review.revisions.projectSettings &&
      !(
        current.checkpoint.primaryAttempted &&
        owner.projectSettings.revision ===
          review.revisions.projectSettings + 1 &&
        owner.projectSettings.primaryAgentId === current.checkpoint.agentId
      )
    )
      throw stale();
    for (const workspace of review.workspaces) {
      const row = snapshot.environments.workspaces.find(
        (item) => item.policy.id === workspace.policyId,
      );
      if (
        !row ||
        row.policy.revision !== workspace.revision ||
        row.workspace.path !== workspace.directory ||
        row.writable !== (workspace.access === "read_write")
      )
        throw stale();
    }
    if (
      current.checkpoint.group &&
      !same(
        access.groups.find((row) => row.id === current.checkpoint.groupId),
        current.checkpoint.group,
      )
    )
      throw stale();
    if (
      current.checkpoint.preset &&
      !same(
        access.presets.find((row) => row.id === current.checkpoint.presetId),
        current.checkpoint.preset,
      )
    )
      throw stale();
    if (current.checkpoint.prepared?.policy) {
      const prepared = current.checkpoint.prepared;
      const policy = access.environmentPolicies.find(
        (row) => row.id === prepared.policy!.id,
      );
      const workspace = snapshot.environments.workspaces.find(
        (row) => row.policy.id === prepared.policy!.id,
      );
      if (
        !same(policy, prepared.policy) ||
        !workspace ||
        workspace.workspace.path !== prepared.canonicalPath ||
        workspace.writable !== (prepared.access === "read_write") ||
        workspace.managedWorktreeRoot ||
        workspace.executableDirectories.length
      )
        throw stale();
    }
    return snapshot;
  };
  const complete = async () => {
    if (
      !journal?.record.review ||
      !["reviewed", "applying", "complete"].includes(journal.record.phase)
    )
      throw new AgentSetupError("Review the current setup before applying it.");
    if (journal.record.phase === "complete") return;
    const draft = journal.record.draft;
    if (
      journal.record.phase === "reviewed" &&
      Buffer.byteLength(JSON.stringify(journal)) +
        3 * Buffer.byteLength(JSON.stringify(draft)) +
        65_536 >
        2_000_000
    )
      throw new AgentSetupError(
        "Retained drafts leave too little room for safe completion receipts. Complete or explicitly reload another saved draft before applying this one.",
      );
    await assertCurrent();
    if (
      draft.mode === "create" &&
      (await options.application.subscription.status()).state !== "signed_in"
    )
      throw new AgentSetupError(
        "Sign in to ChatGPT in Crew before creating this agent. Your draft is saved.",
      );
    // A resumed applying phase can contain an unacknowledged mutation. Only
    // this invocation's known pre-access failures may return to editable setup.
    let accessMayHaveChanged = journal.record.phase === "applying";
    await update((next) => {
      next.record.phase = "applying";
      next.record.error = null;
    });
    try {
      if (draft.groupMode === "new" && !journal!.checkpoint.prepared) {
        await assertCurrent();
        const prepared =
          await options.application.environmentOwnerApi.prepareFolderAccess({
            workspaceDirectory: options.project.directory,
            access: draft.folderAccess,
          });
        if (
          prepared.canonicalPath !== options.project.directory ||
          prepared.access !== draft.folderAccess
        )
          throw new AgentSetupError(
            "Approved folder differs from the reviewed folder.",
          );
        await update((next) => {
          next.checkpoint.prepared = prepared;
        });
      }
      if (draft.groupMode === "new" && !journal!.checkpoint.group) {
        const snapshot = await assertCurrent(),
          planned = journal!.record.review!.newGroup!;
        const prepared = journal!.checkpoint.prepared!;
        const grants = clone(planned.grants);
        grants.environmentPolicyIds = [
          ...prepared.requiredGrants.environmentPolicyIds,
        ];
        // Keep exact helper self scopes alongside separately reviewed grants.
        for (const grant of prepared.requiredGrants.crew)
          if (!grants.crew.some((item) => same(item, grant)))
            grants.crew.push(grant);
        if (
          !same(grants.crew, planned.grants.crew) ||
          prepared.requiredGrants.services.length
        )
          throw new AgentSetupError(
            "Folder prerequisites changed. Review setup again.",
          );
        const groupDraft = {
          name: draft.groupName,
          description: "Shared capabilities approved in guided agent setup.",
          grants,
        };
        const existing = snapshot.access.groups.find(
          (row) => row.id === journal!.checkpoint.groupId,
        );
        if (
          existing &&
          (existing.revision !== 1 ||
            !same(
              {
                name: existing.name,
                description: existing.description,
                grants: existing.grants,
              },
              groupDraft,
            ))
        )
          throw stale();
        accessMayHaveChanged = true;
        const group =
          existing ??
          ((await options.application.accessOwnerApi.command("saveGroup", {
            id: journal!.checkpoint.groupId,
            expectedRevision: null,
            draft: groupDraft,
          })) as PermissionGroup);
        await update((next) => {
          next.checkpoint.group = clone(group);
        });
      }
      if (draft.mode === "repair") {
        accessMayHaveChanged = true;
        await update((next) => {
          next.checkpoint.agentId = draft.agentId;
        });
        const snapshot = await assertCurrent(),
          assignment = snapshot.access.assignments.find(
            (row) => row.agentId === draft.agentId,
          );
        if (!journal!.checkpoint.assignmentAttempted)
          await update((next) => {
            next.checkpoint.assignmentAttempted = true;
          });
        if (
          (assignment?.revision ?? null) ===
          journal!.record.review!.revisions.assignment
        ) {
          const saved = (await options.application.accessOwnerApi.command(
            "saveAssignment",
            {
              agentId: draft.agentId,
              expectedRevision: journal!.record.review!.revisions.assignment,
              permissionGroupIds: selectedIds(),
              serviceConnectionIds: draft.serviceConnectionIds,
            },
          )) as { revision: number };
          await update((next) => {
            next.checkpoint.assignmentRevision = saved.revision;
          });
        } else if (
          !assignmentMatches(
            assignment,
            selectedIds(),
            draft.serviceConnectionIds,
          )
        )
          throw stale();
        const profileSnapshot = await assertCurrent();
        let agent = target(profileSnapshot, draft)!;
        if (!profileMatches(agent, draft)) {
          if (!journal!.checkpoint.profileAttempted)
            await update((next) => {
              next.checkpoint.profileAttempted = true;
            });
          try {
            await options.application.ownerApi.command("saveProfile", {
              agentId: draft.agentId,
              input: {
                expectedRevision: journal!.record.review!.revisions.profile,
                profile: selectedProfile(draft),
                skills: draft.skills,
              },
            });
          } catch {
            // A reply may fail after the revision-checked profile commit. Only
            // exact current fields and its next revision establish recovery.
          }
          agent = target(await assertCurrent(), draft)!;
          if (
            agent.profile.revision !==
              (journal!.record.review!.revisions.profile ?? 0) + 1 ||
            !profileMatches(agent, draft)
          )
            throw new AgentSetupError(
              "The profile save is incomplete. Its exact reviewed revision is retained for retry; external changes will not be overwritten.",
            );
        }
        await update((next) => {
          next.checkpoint.profileResult = {
            profile: clone(agent.profile),
            skills: clone(agent.skills ?? []),
          };
        });
      } else {
        if (!journal!.checkpoint.preset) {
          const snapshot = await assertCurrent();
          if (!journal!.runtime)
            throw new AgentSetupError(
              "The configured project model is unavailable.",
            );
          const presetDraft = {
            name: `${draft.name} setup`,
            enabled: true,
            profile: selectedProfile(draft),
            skills: clone(draft.skills),
            ...journal!.runtime,
            permissionGroupIds: selectedIds(),
            serviceConnectionIds: draft.serviceConnectionIds,
          };
          const existing = snapshot.access.presets.find(
            (row) => row.id === journal!.checkpoint.presetId,
          );
          if (existing) {
            const {
              id: _id,
              projectId: _projectId,
              revision,
              ...fields
            } = existing;
            if (
              revision !== 1 ||
              !same(
                {
                  ...fields,
                  profile: {
                    ...fields.profile,
                    voice: fields.profile.voice ?? null,
                  },
                },
                presetDraft,
              )
            )
              throw stale();
          }
          accessMayHaveChanged = true;
          const preset =
            existing ??
            ((await options.application.accessOwnerApi.command("savePreset", {
              id: journal!.checkpoint.presetId,
              expectedRevision: null,
              draft: presetDraft,
            })) as AgentCreationPreset);
          await update((next) => {
            next.checkpoint.preset = clone(preset);
          });
        }
        let snapshot = await assertCurrent();
        const matches = () =>
          snapshot.owner.provisioning.filter(
            (row) =>
              row.presetId === journal!.checkpoint.presetId &&
              row.presetRevision === journal!.checkpoint.preset!.revision &&
              row.creator.type === "user" &&
              row.creator.userId === snapshot.owner.ownerId,
          );
        let found = matches();
        if (found.length > 1)
          throw new AgentSetupError(
            "More than one agent matches this retained setup. Owner reconciliation is required.",
          );
        if (!found.length) {
          if (journal!.checkpoint.creationAttempted)
            throw new AgentSetupError(
              "The prior creation outcome is uncertain. Crew will not create another agent. Retain this setup for owner reconciliation.",
            );
          await update((next) => {
            next.checkpoint.creationAttempted = true;
          });
          try {
            const manager =
              !draft.makePrimary &&
              snapshot.owner.agents.find(
                (row) =>
                  row.id === snapshot.owner.projectSettings.primaryAgentId &&
                  !row.archivedAt,
              );
            await options.application.ownerApi.command("createAgent", {
              input: {
                presetId: journal!.checkpoint.presetId,
                expectedPresetRevision: journal!.checkpoint.preset!.revision,
                ...(manager
                  ? { reportsTo: { type: "agent", agentId: manager.id } }
                  : {}),
              },
            });
          } catch {
            // A failure can follow durable creation or committed provisioning.
            // Exact provenance below, never a second create, decides recovery.
          }
          snapshot = await snapshots();
          found = matches();
          if (found.length !== 1)
            throw new AgentSetupError(
              "Creation did not return a provable single agent. The attempted setup is retained; retry will not create a duplicate.",
            );
        }
        const provisioning = found[0];
        if (
          journal!.checkpoint.agentId &&
          journal!.checkpoint.agentId !== provisioning.agentId
        )
          throw stale();
        await update((next) => {
          next.checkpoint.agentId = provisioning.agentId;
        });
        await assertCurrent();
        if (provisioning.state !== "ready")
          await options.application.ownerApi.command("retryProvisioning", {
            agentId: provisioning.agentId,
          });
        snapshot = await snapshots();
        const agent = snapshot.owner.agents.find(
          (row) => row.id === provisioning.agentId && !row.archivedAt,
        );
        if (
          !agent ||
          !profileMatches(agent, draft) ||
          !snapshot.owner.provisioning.some(
            (row) => row.agentId === agent.id && row.state === "ready",
          ) ||
          !assignmentMatches(
            snapshot.access.assignments.find((row) => row.agentId === agent.id),
            selectedIds(),
            draft.serviceConnectionIds,
          )
        )
          throw new AgentSetupError(
            "Created agent access changed or provisioning is incomplete. Existing permissions are retained for owner review.",
          );
        await options.created?.();
      }
      let snapshot = await assertCurrent();
      const agentId = journal!.checkpoint.agentId!;
      if (
        draft.mode === "create" &&
        draft.makePrimary &&
        snapshot.owner.projectSettings.primaryAgentId !== agentId
      ) {
        if (!journal!.checkpoint.primaryAttempted)
          await update((next) => {
            next.checkpoint.primaryAttempted = true;
          });
        await options.application.ownerApi.command("setPrimaryAgent", {
          agentId,
          expectedRevision: journal!.record.review!.revisions.projectSettings,
        });
        snapshot = await snapshots();
        if (snapshot.owner.projectSettings.primaryAgentId !== agentId)
          throw stale();
        await update((next) => {
          next.checkpoint.primaryRevision =
            snapshot.owner.projectSettings.revision;
        });
      }
      await assertCurrent();
      await update((next) => {
        next.record.phase = "complete";
        next.record.error = null;
        next.record.result = {
          agentId,
          mode: draft.mode,
          primary: snapshot.owner.projectSettings.primaryAgentId === agentId,
        };
      });
    } catch (error) {
      await update((next) => {
        if (!accessMayHaveChanged) {
          // Folder preparation is idempotent and assigns no group or agent.
          // Retain any unassigned policy in its authority, but let the owner
          // correct/review their choices after a proven pre-access failure.
          next.record.phase = "draft";
          next.record.review = null;
          next.checkpoint = checkpoint();
        }
        next.record.error =
          error instanceof AgentSetupError
            ? error.message.slice(0, 800)
            : accessMayHaveChanged
              ? "Setup needs reconciliation. Its completed steps are retained."
              : "Setup preparation failed before access changes began. Your choices are retained; review or correct them before retrying.";
      });
    }
  };
  return {
    command(name: string, value: unknown): Promise<AgentSetupRecord | null> {
      const input = clone(value);
      const operation = tail.then(async () => {
        if (name === "setup.read") {
          object(input, []);
          return view();
        }
        if (name === "setup.new" || name === "setup.open") {
          const args = object(input, ["expectedRevision", "mode", "agentId"]);
          check(args.expectedRevision);
          if (!["create", "repair"].includes(String(args.mode)))
            throw new AgentSetupError("Choose a setup mode.");
          if (args.agentId !== undefined) string(args.agentId);
          if (journal?.record.phase === "applying")
            throw new AgentSetupError(
              "Reconcile the retained setup before replacing it.",
            );
          if (name === "setup.open" && journal) {
            const key =
              args.mode === "create" ? "create" : `repair:${args.agentId}`;
            if (
              draftKey(journal.record.draft) === key &&
              journal.record.phase !== "complete"
            )
              return view();
            const retained = journal.retained.find(
              (saved) =>
                draftKey(saved.record.draft) === key &&
                saved.record.phase !== "complete",
            );
            if (retained) {
              const next = {
                ...clone(journal),
                ...clone(retained),
                retained: retainedFor(retained.record.draft),
              };
              next.record.revision = journal.record.revision + 1;
              if (next.record.review)
                next.record.review.draftRevision = next.record.revision;
              await save(next);
              return view();
            }
          }
          await persistDraft(
            await createDraft(
              args.mode as "create" | "repair",
              args.agentId as string | undefined,
            ),
            true,
          );
        } else if (name === "setup.save") {
          const args = object(input, ["expectedRevision", "draft"]);
          check(args.expectedRevision);
          await persistDraft(draftInput(args.draft), false);
        } else if (name === "setup.review") {
          const args = object(input, ["expectedRevision"]);
          check(args.expectedRevision);
          if (!journal || !["draft", "reviewed"].includes(journal.record.phase))
            throw new AgentSetupError(
              "Finish the retained setup before reviewing another draft.",
            );
          const snapshot = await snapshots(),
            review = await buildReview(journal.record.draft, snapshot);
          if (
            journal.record.draft.mode === "create" &&
            !snapshot.access.runtimeDefaults
          )
            throw new AgentSetupError(
              "The configured project model is unavailable.",
            );
          await update((next) => {
            next.record.review = review;
            next.record.phase = "reviewed";
            next.record.error = null;
            next.runtime = snapshot.access.runtimeDefaults;
          });
        } else if (name === "setup.complete") {
          const args = object(input, ["expectedRevision"]);
          check(args.expectedRevision);
          await complete();
        } else throw new AgentSetupError("Unknown guided setup command.");
        return view();
      });
      tail = operation.catch(() => {});
      return operation;
    },
  };
}
