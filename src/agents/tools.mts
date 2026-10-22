import type { AgentContent, CallerContext, JsonObject } from "./contracts.mjs";
import { AgentFoundation, type SendInput } from "./foundation.mjs";
import type {
  CreateAgentInput,
  CreateJobInput,
  HelpInput,
  ReportJobProgressInput,
  UpdateProfileInput,
} from "./records.mjs";

const string = { type: "string" };
const id = { type: "string", minLength: 1, maxLength: 512 };
const object = (
  properties: JsonObject,
  required = Object.keys(properties),
): JsonObject => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const nullableString = { anyOf: [string, { type: "null" }] };
const content = {
  type: "array",
  minItems: 1,
  maxItems: 100,
  items: {
    anyOf: [
      object({ type: { const: "text" }, text: string }),
      object({
        type: { const: "image" },
        fileRef: id,
        caption: nullableString,
      }),
      object({
        type: { const: "file" },
        fileRef: id,
        name: string,
        mediaType: string,
      }),
      object({ type: { const: "data" }, value: {} }),
    ],
  },
};
const profileInput = object(
  {
    name: { type: "string", minLength: 1, maxLength: 1000 },
    pictureRef: { anyOf: [id, { type: "null" }] },
    personality: string,
    systemPrompt: string,
    skills: {
      type: "array",
      items: object({ skillId: id, enabled: { type: "boolean" } }),
    },
  },
  [],
);
const jobInput = object(
  {
    work: {
      anyOf: [
        object({
          type: { const: "local" },
          title: { type: "string", minLength: 1, maxLength: 1000 },
          objective: { type: "string", minLength: 1, maxLength: 200_000 },
        }),
        object({
          type: { const: "ticket" },
          ticket: object({
            provider: { enum: ["linear", "github"] },
            connectionId: id,
            externalId: {
              ...id,
              description:
                "GitHub: owner/repository#number. Linear: immutable issue UUID. Use the actual provider identity.",
            },
            url: {
              ...string,
              description: "Canonical HTTP(S) ticket URL without credentials.",
            },
          }),
        }),
      ],
    },
    assignedToAgentId: { anyOf: [id, { type: "null" }] },
    instruction: nullableString,
  },
  ["work"],
);
const environmentInput = object({
  agentId: id,
  action: { enum: ["create", "attach", "execute", "dispose"] },
  requestId: {
    ...id,
    description:
      "Unique operation ID; reuse only to reconcile the exact same action and arguments.",
  },
  arguments: {
    description:
      "create: policyId and optional ref; attach: policyId; execute: environmentId and command, with optional relativeCwd/timeoutMs; dispose: environmentId. Read environments_read for existing IDs and approved policy IDs.",
    anyOf: [
      object({ policyId: id, ref: id }, ["policyId"]),
      object(
        {
          environmentId: id,
          command: {
            type: "array",
            minItems: 1,
            maxItems: 256,
            items: string,
            description:
              'Argument vector, for example ["/usr/bin/git", "status", "--short"].',
          },
          relativeCwd: {
            ...string,
            description:
              "Directory relative to the environment, default '.'; no parent traversal.",
          },
          timeoutMs: { type: "integer", minimum: 100, maximum: 120_000 },
        },
        ["environmentId", "command"],
      ),
      object({ environmentId: id }),
    ],
  },
});
const tools: { name: string; description: string; inputSchema: JsonObject }[] =
  [
    {
      name: "agents_list",
      description:
        "Read stored agent identity and session facts without starting a turn.",
      inputSchema: object({}),
    },
    {
      name: "agent_read",
      description:
        "Read an agent profile and session identity. Notes and environments require their own permissions.",
      inputSchema: object({ agentId: id }),
    },
    {
      name: "agent_creation_presets",
      description:
        "List owner-approved creation choices. These choices do not grant administration rights.",
      inputSchema: object({}),
    },
    {
      name: "agent_create",
      description:
        "Create a provisioned persistent agent from an exact owner-approved preset revision; reports to the creating agent. Does not Start.",
      inputSchema: object({
        input: object(
          {
            presetId: id,
            expectedPresetRevision: { type: "integer", minimum: 1 },
            name: string,
          },
          ["presetId", "expectedPresetRevision"],
        ),
      }),
    },
    {
      name: "agent_profile_save",
      description:
        "Save a profile using its current revision; active instructions change only on explicit Restart.",
      inputSchema: object({
        agentId: id,
        expectedRevision: { type: "integer", minimum: 1 },
        input: profileInput,
      }),
    },
    {
      name: "agent_session",
      description:
        "Explicit Start, Stop or Restart. Start is idle; Stop preserves resources and history.",
      inputSchema: object({
        agentId: id,
        action: { enum: ["start", "stop", "restart"] },
      }),
    },
    {
      name: "agent_archive",
      description:
        "Archive visibility only, without stopping a session or disposing resources.",
      inputSchema: object({ agentId: id }),
    },
    {
      name: "agent_history",
      description:
        "Read paginated native visible messages and tool activity. Never starts a model turn.",
      inputSchema: object({ agentId: id, cursor: string }, ["agentId"]),
    },
    {
      name: "agent_message",
      description:
        "Send actual agent-attributed content with explicit queue or steer mode. Stopped recipients stay stopped.",
      inputSchema: object(
        {
          recipientAgentId: id,
          jobId: nullableString,
          replyToMessageId: nullableString,
          content,
          deliveryMode: { enum: ["queue", "steer"] },
          id,
        },
        [
          "recipientAgentId",
          "jobId",
          "replyToMessageId",
          "content",
          "deliveryMode",
        ],
      ),
    },
    {
      name: "message_reconcile",
      description:
        "Reconcile an uncertain native send without replaying its content.",
      inputSchema: object({ messageId: id }),
    },
    {
      name: "scratchpad_write",
      description:
        "Replace visible working notes using the current revision. Empty markdown explicitly clears notes.",
      inputSchema: object({
        agentId: id,
        expectedRevision: { type: "integer", minimum: 1 },
        markdown: string,
      }),
    },
    {
      name: "scratchpad_read",
      description:
        "Read visible working notes without starting or interrupting an agent.",
      inputSchema: object({ agentId: id }),
    },
    {
      name: "environment_action",
      description:
        "Explicit environment action using the configured project integration. Does not change agent or chat identity.",
      inputSchema: environmentInput,
    },
    {
      name: "environments_read",
      description:
        "Read currently permitted workspace policies and attached environments. Use the returned policy ID for attach/create; this runs no project commands.",
      inputSchema: object({ agentId: id }),
    },
    {
      name: "jobs_list",
      description:
        "Read durable job assignments and agent-reported progress without interrupting agents.",
      inputSchema: object({}),
    },
    {
      name: "job_create",
      description:
        "Create a thin ticket reference or local objective; no automatic assignment message, setup or workflow.",
      inputSchema: object({ input: jobInput }),
    },
    {
      name: "job_assign",
      description:
        "Append an assignment record and specific direction without inferring progress or starting work.",
      inputSchema: object({
        jobId: id,
        agentId: nullableString,
        instruction: nullableString,
      }),
    },
    {
      name: "job_progress",
      description:
        "Explicitly report status, short label, detail and nullable percent. Every transition is allowed.",
      inputSchema: object({
        jobId: id,
        progress: object({
          status: {
            enum: [
              "not_started",
              "in_progress",
              "blocked",
              "ready",
              "completed",
              "cancelled",
            ],
          },
          label: nullableString,
          detail: nullableString,
          percent: {
            anyOf: [
              { type: "number", minimum: 0, maximum: 100 },
              { type: "null" },
            ],
          },
        }),
      }),
    },
    {
      name: "job_local_update",
      description:
        "Append a local job update. Ticket requirements and outcomes remain at their provider via the broker.",
      inputSchema: object({
        jobId: id,
        update: object({
          kind: string,
          text: string,
          links: {
            type: "array",
            items: object({ label: string, url: string }),
          },
        }),
      }),
    },
    {
      name: "job_local_outcome",
      description:
        "Record a local job outcome, without changing its progress status.",
      inputSchema: object({
        jobId: id,
        outcome: object({
          summary: string,
          links: {
            type: "array",
            items: object({ label: string, url: string }),
          },
        }),
      }),
    },
    {
      name: "help_request",
      description:
        "Raise a help request to this agent's explicit next reporting relationship; human targets go to the owner inbox.",
      inputSchema: object(
        {
          content,
          jobId: nullableString,
          replyToHelpRequestId: nullableString,
        },
        ["content"],
      ),
    },
    {
      name: "help_respond",
      description:
        "Respond to a help request addressed to this agent. A response does not grant service access.",
      inputSchema: object({ helpId: id, content }),
    },
    {
      name: "preparation_read",
      description:
        "Read the current preparation request identity and required continuation freshness for this session.",
      inputSchema: object({}),
    },
    {
      name: "preparation_readiness",
      description:
        "Report this exact session's readiness after an explicit preparation request. Ready requires continuationSavedAt.",
      inputSchema: object({
        preparationId: id,
        state: { enum: ["pending", "ready", "blocked"] },
        continuationSavedAt: nullableString,
        detail: nullableString,
      }),
    },
  ];

function fields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected tool arguments.");
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 512)
    throw new Error("Invalid record identity.");
  return value;
}

/** Bind caller from #89's authenticated runtime transport, never from arguments.
 * #90/native composition may register this catalogue alongside broker tools.
 * This object has no credential or upstream-executor access. */
export function createFoundationAgentTools(
  foundation: AgentFoundation,
  caller: CallerContext,
) {
  const principal = { type: "agent" as const, caller: structuredClone(caller) };
  return {
    list: () => structuredClone(tools),
    async call(name: string, input: JsonObject): Promise<unknown> {
      if (!foundation.executionAllowed(caller))
        throw new Error("Calling session is closed or execution is reserved.");
      const args = fields(input);
      const records = foundation.records;
      switch (name) {
        case "agents_list":
          await records.authorize(principal, "agents.read", {
            type: "project",
          });
          return (await foundation.agentViews()).map(
            ({ scratchpad, resources, ...identity }) => identity,
          );
        case "agent_read": {
          const agentId = identifier(args.agentId);
          await records.authorize(principal, "agents.read", {
            type: "agent",
            agentId,
          });
          // Scratchpad has an independent capability; do not leak notes via identity reads.
          const agent = (await foundation.agentViews()).find(
            (entry) => entry.id === agentId,
          )!;
          const { scratchpad, resources, ...identity } = agent;
          return identity;
        }
        case "agent_creation_presets":
          await records.authorize(principal, "agents.create", {
            type: "project",
          });
          return foundation.creationPresets();
        case "agent_create":
          return foundation.createFromPreset(
            principal,
            args.input as unknown as Parameters<
              typeof foundation.createFromPreset
            >[1],
          );
        case "agent_profile_save":
          return records.updateProfile(
            principal,
            identifier(args.agentId),
            args.expectedRevision as number,
            args.input as UpdateProfileInput,
          );
        case "agent_session": {
          const agentId = identifier(args.agentId);
          const action = args.action;
          if (action !== "start" && action !== "stop" && action !== "restart")
            throw new Error("Unsupported session action.");
          return foundation.lifecycle(principal, agentId, action);
        }
        case "agent_archive":
          return records.archive(principal, identifier(args.agentId));
        case "agent_history":
          return foundation.history(
            principal,
            identifier(args.agentId),
            args.cursor === undefined ? undefined : identifier(args.cursor),
          );
        case "agent_message":
          return foundation.send(principal, args as unknown as SendInput);
        case "message_reconcile":
          return foundation.reconcileMessage(
            principal,
            identifier(args.messageId),
          );
        case "scratchpad_write":
          return records.updateScratchpad(
            principal,
            identifier(args.agentId),
            args.expectedRevision as number,
            args.markdown as string,
          );
        case "environment_action":
          return foundation.environment(
            principal,
            args as unknown as Parameters<typeof foundation.environment>[1],
          );
        case "scratchpad_read":
        case "environments_read": {
          const agentId = identifier(args.agentId);
          await records.authorize(
            principal,
            name === "scratchpad_read"
              ? "scratchpad.read"
              : "environments.read",
            { type: "agent", agentId },
          );
          const agent = foundation.store
            .snapshot()
            .agents.find((entry) => entry.id === agentId)!;
          return name === "scratchpad_read"
            ? agent.scratchpad
            : foundation.environmentList(principal, agentId);
        }
        case "jobs_list":
          await records.authorize(principal, "jobs.read", { type: "project" });
          return foundation.store.snapshot().jobs;
        case "job_create":
          return records.createJob(
            principal,
            args.input as unknown as CreateJobInput,
          );
        case "job_assign":
          return records.assignJob(
            principal,
            identifier(args.jobId),
            args.agentId === null ? null : identifier(args.agentId),
            args.instruction as string | null,
          );
        case "job_progress":
          return records.reportJobProgress(
            principal,
            identifier(args.jobId),
            args.progress as unknown as ReportJobProgressInput,
          );
        case "job_local_update":
          return records.addLocalUpdate(
            principal,
            identifier(args.jobId),
            args.update as unknown as Parameters<
              typeof records.addLocalUpdate
            >[2],
          );
        case "job_local_outcome":
          return records.setLocalOutcome(
            principal,
            identifier(args.jobId),
            args.outcome as unknown as Parameters<
              typeof records.setLocalOutcome
            >[2],
          );
        case "help_request": {
          const result = await records.requestHelp(
            principal,
            caller.agentId,
            args as unknown as HelpInput,
          );
          void foundation.flush().catch(() => {});
          return result;
        }
        case "help_respond": {
          const result = await records.answerHelp(
            principal,
            identifier(args.helpId),
            args.content as AgentContent[],
          );
          void foundation.flush().catch(() => {});
          return result;
        }
        case "preparation_read":
          return (
            foundation.store
              .snapshot()
              .preparation?.readiness.find(
                (row) =>
                  row.agentId === caller.agentId &&
                  row.sessionId === caller.sessionId,
              ) ?? null
          );
        case "preparation_readiness":
          return foundation.reportReadiness(
            principal,
            args as unknown as Parameters<typeof foundation.reportReadiness>[1],
          );
        default:
          throw new Error("Unknown foundation tool.");
      }
    },
  };
}
