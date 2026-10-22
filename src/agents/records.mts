import { randomUUID } from "node:crypto";
import type {
  Actor,
  Agent,
  AgentContent,
  AgentMessage,
  AuthorizationService,
  CallerContext,
  CrewAction,
  CrewTarget,
  HelpRequest,
  Job,
  JobProgress,
  LocalWork,
  LocalWorkUpdate,
  TicketBackedWork,
  WorkLink,
} from "./contracts.mjs";
import {
  FoundationStore,
  messageIntentFingerprint,
  type FoundationState,
} from "./store.mjs";

/** Construct only from the authenticated owner/gateway transport, never model arguments. */
export type FoundationPrincipal =
  { type: "owner"; userId: string } | { type: "agent"; caller: CallerContext };
export interface FoundationReferences {
  validate(
    kind: "modelAccess" | "runtimeConfig" | "skill" | "connection",
    id: string,
    projectId: string,
  ): Promise<boolean>;
}
export interface CreateAgentInput {
  profile: Omit<Agent["profile"], "revision">;
  modelAccessId: string;
  configRef: string;
  reportsTo?: Actor;
  skills?: Agent["skills"];
}
export type UpdateProfileInput = Partial<Omit<Agent["profile"], "revision">> & {
  reportsTo?: Actor;
  skills?: Agent["skills"];
};
export interface CreateJobInput {
  work: TicketBackedWork | Pick<LocalWork, "type" | "title" | "objective">;
  assignedToAgentId?: string | null;
  instruction?: string | null;
}
export type ReportJobProgressInput = Pick<
  JobProgress,
  "status" | "label" | "detail" | "percent"
>;
export interface HelpInput {
  content: AgentContent[];
  jobId?: string | null;
  replyToHelpRequestId?: string | null;
}

function record(
  value: unknown,
  allowed: string[],
  required: string[] = allowed,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a record.");
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(result, key))
  )
    throw new Error("Unexpected or missing record fields.");
  return result;
}
function string(
  value: unknown,
  max = 200_000,
  empty = true,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!empty && !value.trim()) ||
    value.includes("\0")
  )
    throw new Error("Invalid text value.");
}
function identifier(value: unknown): asserts value is string {
  string(value, 512, false);
  if (/[\u0000-\u001f\u007f]/.test(value))
    throw new Error("Invalid record reference.");
}
function optionalText(value: unknown): asserts value is string | null {
  if (value !== null) string(value);
}
function checkRevision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new Error("Invalid expected revision.");
}
function getAgent(state: FoundationState, agentId: string): Agent {
  identifier(agentId);
  const value = state.agents.find(
    (entry) => entry.id === agentId && entry.projectId === state.projectId,
  );
  if (!value) throw new Error("Agent is not in this project.");
  return value;
}
function getJob(state: FoundationState, jobId: string): Job {
  identifier(jobId);
  const value = state.jobs.find(
    (entry) => entry.id === jobId && entry.projectId === state.projectId,
  );
  if (!value) throw new Error("Job is not in this project.");
  return value;
}
function validateActor(state: FoundationState, value: Actor): void {
  if (value?.type === "user") {
    record(value, ["type", "userId"]);
    if (value.userId !== state.ownerUserId)
      throw new Error("Reporting must end at this project's owner.");
  } else if (value?.type === "agent") {
    record(value, ["type", "agentId"]);
    getAgent(state, value.agentId);
  } else throw new Error("Invalid reporting identity.");
}
function validateProfile(value: Omit<Agent["profile"], "revision">): void {
  record(value, ["name", "pictureRef", "personality", "systemPrompt"]);
  string(value.name, 1000, false);
  if (value.pictureRef !== null) identifier(value.pictureRef);
  string(value.personality);
  string(value.systemPrompt);
}
function webUrl(value: unknown): asserts value is string {
  string(value, 4096, false);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid work URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Work URLs must be HTTP(S) without embedded credentials.");
}
function validateLinks(value: WorkLink[]): void {
  if (!Array.isArray(value) || value.length > 100)
    throw new Error("Invalid work links.");
  for (const link of value) {
    record(link, ["label", "url"]);
    string(link.label, 1000);
    webUrl(link.url);
  }
}
function validateContent(value: AgentContent[]): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100)
    throw new Error("A bounded non-empty message is required.");
  for (const block of value) {
    if (block?.type === "text") {
      record(block, ["type", "text"]);
      string(block.text);
    } else if (block?.type === "image") {
      record(block, ["type", "fileRef", "caption"]);
      identifier(block.fileRef);
      if (block.caption !== null) string(block.caption, 10_000);
    } else if (block?.type === "file") {
      record(block, ["type", "fileRef", "name", "mediaType"]);
      identifier(block.fileRef);
      string(block.name, 1000);
      string(block.mediaType, 200);
    } else if (block?.type === "data") record(block, ["type", "value"]);
    else throw new Error("Invalid message content.");
  }
  // JSON/data shape and finite numbers are also checked by the store before commit.
}
function sameActor(left: Actor, right: Actor): boolean {
  return left.type === "user" && right.type === "user"
    ? left.userId === right.userId
    : left.type === "agent" &&
        right.type === "agent" &&
        left.agentId === right.agentId;
}

export class FoundationRecords {
  constructor(
    readonly store: FoundationStore,
    private readonly authorization: AuthorizationService,
    private readonly references?: FoundationReferences,
  ) {}

  private actor(state: FoundationState, principal: FoundationPrincipal): Actor {
    if (principal?.type === "owner") {
      record(principal, ["type", "userId"]);
      if (principal.userId !== state.ownerUserId)
        throw new Error("Owner identity does not match this project.");
      return { type: "user", userId: principal.userId };
    }
    if (principal?.type !== "agent")
      throw new Error("Authenticated foundation identity is required.");
    record(principal, ["type", "caller"]);
    record(principal.caller, ["projectId", "agentId", "sessionId"]);
    const caller = principal.caller;
    identifier(caller.sessionId);
    if (caller.projectId !== state.projectId)
      throw new Error("Caller project does not match.");
    const agent = getAgent(state, caller.agentId);
    const session = agent.runtime.session;
    if (
      session.sessionId !== caller.sessionId ||
      session.desiredState !== "started" ||
      session.observedState !== "started"
    )
      throw new Error("Caller session is not current and started.");
    return { type: "agent", agentId: caller.agentId };
  }

  async authorize(
    principal: FoundationPrincipal,
    action: CrewAction,
    target: CrewTarget,
  ): Promise<Actor> {
    const state = this.store.snapshot();
    const actor = this.actor(state, principal);
    if (target?.type === "agent") {
      record(target, ["type", "agentId"]);
      getAgent(state, target.agentId);
    } else if (target?.type === "project") record(target, ["type"]);
    else throw new Error("Invalid Crew authorization target.");
    if (principal.type === "agent") {
      let decision;
      try {
        decision = await this.authorization.checkCrew(
          structuredClone(principal.caller),
          action,
          structuredClone(target),
        );
      } catch {
        throw new Error("Crew authorization is unavailable.");
      }
      if (decision.state !== "allowed")
        throw new Error("Crew permission denied.");
    }
    this.actor(this.store.snapshot(), principal);
    return actor;
  }

  private async reference(
    kind: Parameters<FoundationReferences["validate"]>[0],
    id: string,
  ): Promise<void> {
    identifier(id);
    let valid = false;
    try {
      valid = Boolean(
        this.references &&
        (await this.references.validate(
          kind,
          id,
          this.store.snapshot().projectId,
        )),
      );
    } catch {
      /* A failed external read cannot validate a reference. */
    }
    if (!valid)
      throw new Error(`Unknown or unavailable project ${kind} reference.`);
  }

  private async selections(value: Agent["skills"]): Promise<void> {
    if (
      !Array.isArray(value) ||
      value.length > 1000 ||
      new Set(value.map((entry) => entry?.skillId)).size !== value.length
    )
      throw new Error("Invalid skill selections.");
    for (const selection of value) {
      record(selection, ["skillId", "enabled"]);
      if (typeof selection.enabled !== "boolean")
        throw new Error("Invalid skill selection.");
      await this.reference("skill", selection.skillId);
    }
  }

  async createAgent(
    principal: FoundationPrincipal,
    input: CreateAgentInput,
    provisioning?: { presetId: string; presetRevision: number },
  ): Promise<Agent> {
    record(
      input,
      ["profile", "modelAccessId", "configRef", "reportsTo", "skills"],
      ["profile", "modelAccessId", "configRef"],
    );
    validateProfile(input.profile);
    await this.authorize(principal, "agents.create", { type: "project" });
    await this.reference("modelAccess", input.modelAccessId);
    await this.reference("runtimeConfig", input.configRef);
    await this.selections(input.skills ?? []);
    return this.store.update((state) => {
      this.actor(state, principal);
      const now = new Date().toISOString();
      const creator = this.actor(state, principal);
      if (
        principal.type === "agent" &&
        input.reportsTo !== undefined &&
        !sameActor(input.reportsTo, creator)
      )
        throw new Error(
          "Only the owner can choose another reporting relationship.",
        );
      const reportsTo = input.reportsTo ?? creator;
      validateActor(state, reportsTo);
      const agent: Agent = {
        id: randomUUID(),
        projectId: state.projectId,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        profile: { ...input.profile, revision: 1 },
        skills: structuredClone(input.skills ?? []),
        access: {
          permissionGroupIds: [],
          serviceConnectionIds: [],
          inheritPersonalServiceCredentials: false,
        },
        runtime: {
          provider: "codex",
          modelAccessId: input.modelAccessId,
          configRef: input.configRef,
          threadId: null,
          session: {
            sessionId: null,
            desiredState: "stopped",
            observedState: "stopped",
            activeTurnId: null,
            startedAt: null,
            lastObservedAt: null,
            lastError: null,
            appliedConfiguration: null,
          },
        },
        scratchpad: { markdown: "", revision: 1, updatedAt: now },
        reportsTo: structuredClone(reportsTo),
        resources: [],
      };
      state.agents.push(agent);
      if (provisioning)
        state.provisioning.push({
          agentId: agent.id,
          ...provisioning,
          creator,
          state: "pending",
          error: null,
        });
      return agent;
    });
  }

  async updateProfile(
    principal: FoundationPrincipal,
    agentId: string,
    expectedRevision: number,
    patch: UpdateProfileInput,
  ): Promise<Agent> {
    record(
      patch,
      [
        "name",
        "pictureRef",
        "personality",
        "systemPrompt",
        "reportsTo",
        "skills",
      ],
      [],
    );
    checkRevision(expectedRevision);
    await this.authorize(principal, "agents.update", {
      type: "agent",
      agentId,
    });
    if (patch.skills !== undefined) {
      await this.authorize(principal, "skills.assign", {
        type: "agent",
        agentId,
      });
      await this.selections(patch.skills);
    }
    return this.store.update((state) => {
      this.actor(state, principal);
      const agent = getAgent(state, agentId);
      if (agent.profile.revision !== expectedRevision)
        throw new Error("Profile changed; reload before saving.");
      const { reportsTo, skills, ...profile } = patch;
      const next = { ...agent.profile, ...profile };
      validateProfile({
        name: next.name,
        pictureRef: next.pictureRef,
        personality: next.personality,
        systemPrompt: next.systemPrompt,
      });
      if (reportsTo !== undefined) {
        if (principal.type !== "owner")
          throw new Error("Only the owner can change reporting relationships.");
        validateActor(state, reportsTo);
        agent.reportsTo = structuredClone(reportsTo);
      }
      if (skills !== undefined) agent.skills = structuredClone(skills);
      agent.profile = { ...next, revision: expectedRevision + 1 };
      agent.updatedAt = new Date().toISOString();
      return agent;
    });
  }

  async setSkills(
    principal: FoundationPrincipal,
    agentId: string,
    selections: Agent["skills"],
    expectedRevision?: number,
  ): Promise<Agent> {
    if (expectedRevision !== undefined) checkRevision(expectedRevision);
    await this.authorize(principal, "skills.assign", {
      type: "agent",
      agentId,
    });
    await this.selections(selections);
    return this.store.update((state) => {
      this.actor(state, principal);
      const agent = getAgent(state, agentId);
      if (
        expectedRevision !== undefined &&
        agent.profile.revision !== expectedRevision
      )
        throw new Error("Profile changed; reload before saving skills.");
      agent.skills = structuredClone(selections);
      agent.profile.revision += 1;
      agent.updatedAt = new Date().toISOString();
      return agent;
    });
  }

  async updateScratchpad(
    principal: FoundationPrincipal,
    agentId: string,
    expectedRevision: number,
    markdown: string,
  ): Promise<Agent["scratchpad"]> {
    checkRevision(expectedRevision);
    string(markdown);
    await this.authorize(principal, "scratchpad.write", {
      type: "agent",
      agentId,
    });
    return this.store.update((state) => {
      this.actor(state, principal);
      const agent = getAgent(state, agentId);
      if (agent.scratchpad.revision !== expectedRevision)
        throw new Error("Scratchpad changed; reload before saving.");
      const now = new Date().toISOString();
      agent.scratchpad = {
        markdown,
        revision: expectedRevision + 1,
        updatedAt: now,
      };
      agent.updatedAt = now;
      return agent.scratchpad;
    });
  }

  async archive(
    principal: FoundationPrincipal,
    agentId: string,
    archived = true,
  ): Promise<Agent> {
    if (typeof archived !== "boolean")
      throw new Error("Invalid archive visibility.");
    await this.authorize(principal, "agents.archive", {
      type: "agent",
      agentId,
    });
    return this.store.update((state) => {
      this.actor(state, principal);
      const agent = getAgent(state, agentId);
      const now = new Date().toISOString();
      agent.archivedAt = archived ? (agent.archivedAt ?? now) : null;
      agent.updatedAt = now;
      return agent;
    });
  }

  async createJob(
    principal: FoundationPrincipal,
    input: CreateJobInput,
  ): Promise<Job> {
    record(input, ["work", "assignedToAgentId", "instruction"], ["work"]);
    if (input.instruction !== undefined) optionalText(input.instruction);
    await this.authorize(principal, "jobs.create", { type: "project" });
    if (input.assignedToAgentId)
      await this.authorize(principal, "jobs.assign", {
        type: "agent",
        agentId: input.assignedToAgentId,
      });
    if (input.work?.type === "ticket") {
      record(input.work, ["type", "ticket"]);
      record(input.work.ticket, [
        "provider",
        "connectionId",
        "externalId",
        "url",
      ]);
      const ticket = input.work.ticket;
      identifier(ticket.externalId);
      webUrl(ticket.url);
      if (ticket.provider === "github") {
        const match = /^([^/#\s]+)\/([^/#\s]+)#([1-9]\d*)$/.exec(
          ticket.externalId,
        );
        const url = new URL(ticket.url);
        if (
          !match ||
          url.hostname !== "github.com" ||
          ![
            `/${match[1]}/${match[2]}/issues/${match[3]}`,
            `/${match[1]}/${match[2]}/pull/${match[3]}`,
          ].includes(url.pathname) ||
          url.search ||
          url.hash
        )
          throw new Error(
            "GitHub work requires a repository-qualified issue identity and canonical URL.",
          );
      } else if (ticket.provider === "linear") {
        if (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            ticket.externalId,
          ) ||
          new URL(ticket.url).hostname !== "linear.app"
        )
          throw new Error(
            "Linear work requires an immutable issue ID and canonical URL.",
          );
      } else throw new Error("Unsupported ticket provider.");
      await this.reference("connection", ticket.connectionId);
    } else if (input.work?.type === "local") {
      record(input.work, ["type", "title", "objective"]);
      string(input.work.title, 1000, false);
      string(input.work.objective, 200_000, false);
    } else throw new Error("Invalid work source.");
    return this.store.update((state) => {
      const actor = this.actor(state, principal);
      const now = new Date().toISOString();
      const assignedToAgentId = input.assignedToAgentId ?? null;
      if (assignedToAgentId !== null) getAgent(state, assignedToAgentId);
      const instruction = input.instruction ?? null;
      const job: Job = {
        id: randomUUID(),
        projectId: state.projectId,
        createdAt: now,
        updatedAt: now,
        assignment: { assignedBy: actor, assignedToAgentId, instruction },
        work:
          input.work.type === "ticket"
            ? structuredClone(input.work)
            : { ...input.work, updates: [], outcome: null },
        progress: {
          status: "not_started",
          label: null,
          detail: null,
          percent: null,
          reportedByAgentId: null,
          reportedAt: null,
        },
        assignmentHistory: [
          {
            id: randomUUID(),
            recordedAt: now,
            changedBy: actor,
            previousAgentId: null,
            assignedAgentId: assignedToAgentId,
            instruction,
          },
        ],
      };
      state.jobs.push(job);
      return job;
    });
  }

  private jobTarget(job: Job): CrewTarget {
    return job.assignment.assignedToAgentId === null
      ? { type: "project" }
      : { type: "agent", agentId: job.assignment.assignedToAgentId };
  }

  private async authorizeJob(
    principal: FoundationPrincipal,
    jobId: string,
    action: CrewAction,
  ): Promise<Job> {
    const job = getJob(this.store.snapshot(), jobId);
    await this.authorize(principal, action, this.jobTarget(job));
    return job;
  }

  private currentJob(state: FoundationState, previous: Job): Job {
    const job = getJob(state, previous.id);
    if (
      job.assignmentHistory.at(-1)?.id !== previous.assignmentHistory.at(-1)?.id
    )
      throw new Error(
        "Job assignment changed; retry against the current assignment.",
      );
    return job;
  }

  async assignJob(
    principal: FoundationPrincipal,
    jobId: string,
    assignedToAgentId: string | null,
    instruction: string | null,
  ): Promise<Job> {
    optionalText(instruction);
    const previous = await this.authorizeJob(principal, jobId, "jobs.assign");
    if (assignedToAgentId !== null)
      await this.authorize(principal, "jobs.assign", {
        type: "agent",
        agentId: assignedToAgentId,
      });
    return this.store.update((state) => {
      const actor = this.actor(state, principal);
      const job = this.currentJob(state, previous);
      const now = new Date().toISOString();
      if (assignedToAgentId !== null) getAgent(state, assignedToAgentId);
      job.assignmentHistory.push({
        id: randomUUID(),
        recordedAt: now,
        changedBy: actor,
        previousAgentId: job.assignment.assignedToAgentId,
        assignedAgentId: assignedToAgentId,
        instruction,
      });
      job.assignment = { assignedBy: actor, assignedToAgentId, instruction };
      job.updatedAt = now;
      return job;
    });
  }

  async reportJobProgress(
    principal: FoundationPrincipal,
    jobId: string,
    progress: ReportJobProgressInput,
  ): Promise<Job> {
    record(progress, ["status", "label", "detail", "percent"]);
    const previous = await this.authorizeJob(principal, jobId, "jobs.update");
    return this.store.update((state) => {
      const actor = this.actor(state, principal);
      const job = this.currentJob(state, previous);
      const now = new Date().toISOString();
      job.progress = {
        ...progress,
        reportedByAgentId: actor.type === "agent" ? actor.agentId : null,
        reportedAt: now,
      };
      job.updatedAt = now;
      return job;
    });
  }

  async addLocalUpdate(
    principal: FoundationPrincipal,
    jobId: string,
    update: Pick<LocalWorkUpdate, "kind" | "text" | "links">,
  ): Promise<Job> {
    record(update, ["kind", "text", "links"]);
    string(update.kind, 200, false);
    string(update.text);
    validateLinks(update.links);
    const previous = await this.authorizeJob(principal, jobId, "jobs.update");
    return this.store.update((state) => {
      const actor = this.actor(state, principal);
      const job = this.currentJob(state, previous);
      if (actor.type !== "agent" || job.work.type !== "local")
        throw new Error(
          "Local work updates require an authenticated agent and a local job.",
        );
      const now = new Date().toISOString();
      job.work.updates.push({
        ...structuredClone(update),
        id: randomUUID(),
        recordedByAgentId: actor.agentId,
        recordedAt: now,
      });
      job.updatedAt = now;
      return job;
    });
  }

  async setLocalOutcome(
    principal: FoundationPrincipal,
    jobId: string,
    outcome: Pick<NonNullable<LocalWork["outcome"]>, "summary" | "links">,
  ): Promise<Job> {
    record(outcome, ["summary", "links"]);
    string(outcome.summary);
    validateLinks(outcome.links);
    const previous = await this.authorizeJob(principal, jobId, "jobs.update");
    return this.store.update((state) => {
      const actor = this.actor(state, principal);
      const job = this.currentJob(state, previous);
      if (actor.type !== "agent" || job.work.type !== "local")
        throw new Error(
          "Local outcomes require an authenticated agent and a local job.",
        );
      const now = new Date().toISOString();
      job.work.outcome = {
        ...structuredClone(outcome),
        recordedByAgentId: actor.agentId,
        recordedAt: now,
      };
      job.updatedAt = now;
      return job;
    });
  }

  async requestHelp(
    principal: FoundationPrincipal,
    agentId: string,
    input: HelpInput,
  ): Promise<HelpRequest> {
    record(input, ["content", "jobId", "replyToHelpRequestId"], ["content"]);
    validateContent(input.content);
    await this.authorize(principal, "help.request", { type: "agent", agentId });
    return this.store.update((state) => {
      const actor = this.actor(state, principal);
      if (actor.type !== "agent" || actor.agentId !== agentId)
        throw new Error(
          "Help requests must identify their actual requesting agent.",
        );
      const agent = getAgent(state, agentId);
      const jobId = input.jobId ?? null;
      if (jobId !== null) getJob(state, jobId);
      const previous = input.replyToHelpRequestId
        ? state.helpRequests.find(
            (entry) => entry.id === input.replyToHelpRequestId,
          )
        : undefined;
      if (
        input.replyToHelpRequestId &&
        (!previous ||
          previous.state !== "open" ||
          !sameActor(previous.target, actor) ||
          previous.jobId !== jobId)
      )
        throw new Error(
          "Help escalation does not match an open request addressed to this agent.",
        );
      const now = new Date().toISOString();
      const messageId = randomUUID();
      const help: HelpRequest = {
        id: randomUUID(),
        projectId: state.projectId,
        requesterAgentId: agentId,
        target: structuredClone(agent.reportsTo),
        jobId,
        messageId,
        replyToHelpRequestId: previous?.id ?? null,
        state: "open",
        responseMessageId: null,
        createdAt: now,
      };
      state.helpRequests.push(help);
      if (previous) previous.state = "escalated";
      if (help.target.type === "user")
        state.ownerInbox.push({
          helpRequestId: help.id,
          content: structuredClone(input.content),
        });
      else
        state.messages.push(
          this.message(
            state,
            messageId,
            actor,
            help.target.agentId,
            jobId,
            previous?.messageId ?? null,
            "help_request",
            input.content,
            now,
          ),
        );
      return help;
    });
  }

  async answerHelp(
    principal: FoundationPrincipal,
    helpId: string,
    content: AgentContent[],
  ): Promise<HelpRequest> {
    identifier(helpId);
    validateContent(content);
    const previous = this.store
      .snapshot()
      .helpRequests.find((entry) => entry.id === helpId);
    if (!previous) throw new Error("Help request is not in this project.");
    await this.authorize(principal, "help.respond", {
      type: "agent",
      agentId: previous.requesterAgentId,
    });
    return this.store.update((state) => {
      const actor = this.actor(state, principal);
      const help = state.helpRequests.find((entry) => entry.id === helpId);
      if (
        !help ||
        !sameActor(actor, help.target) ||
        !["open", "escalated"].includes(help.state)
      )
        throw new Error("Help request is not awaiting this responder.");
      const messageId = randomUUID();
      const now = new Date().toISOString();
      state.messages.push(
        this.message(
          state,
          messageId,
          actor,
          help.requesterAgentId,
          help.jobId,
          help.messageId,
          "message",
          content,
          now,
        ),
      );
      help.state = "answered";
      help.responseMessageId = messageId;
      state.ownerInbox = state.ownerInbox.filter(
        (entry) => entry.helpRequestId !== help.id,
      );
      return help;
    });
  }

  private message(
    state: FoundationState,
    id: string,
    sender: Actor,
    recipientAgentId: string,
    jobId: string | null,
    replyToMessageId: string | null,
    kind: AgentMessage["kind"],
    content: AgentContent[],
    createdAt: string,
  ): AgentMessage {
    const message: AgentMessage = {
      id,
      projectId: state.projectId,
      sender,
      visibility: "public",
      recipientAgentId,
      jobId,
      replyToMessageId,
      kind,
      content: structuredClone(content),
      deliveryMode: "queue",
      createdAt,
      delivery: {
        state: "queued",
        attempts: [],
        runtimeMessageRef: null,
        deliveredAt: null,
        error: null,
      },
    };
    state.intentFingerprints[id] = messageIntentFingerprint(message);
    return message;
  }
}
