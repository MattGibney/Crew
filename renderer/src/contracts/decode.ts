import { compile, errorsText, type Schema } from "./schema.js";
import type {
  ApiPath,
  ApiResult,
  ApiResults,
  ManagerLifecycle,
  OrchestrationState,
  WorkState,
  WorkerApproval,
  UpdatePlan,
  UpdateStatus,
} from "./manager.js";
const object = (
  properties: Record<string, Schema>,
  required: string[] = [],
): Schema => ({
  type: "object",
  properties,
  required,
  additionalProperties: true,
});
const string: Schema = { type: "string" };
const array = (items: Schema): Schema => ({ type: "array", items });
const nullable = (schema: Schema): Schema => ({
  anyOf: [schema, { type: "null" }],
});
const message = object(
  {
    id: string,
    role: string,
    text: string,
    source: string,
    position: { type: "number" },
  },
  ["id", "role"],
);
const approval = object(
  {
    id: { type: ["string", "number"] },
    method: string,
    params: { type: "object" },
  },
  ["id", "method"],
);
const lifecycleSchema = object({ state: string, error: nullable(string) }, [
  "state",
]);
const workSchema = object(
  {
    approvals: array(approval),
    connectors: array({}),
    items: array({ type: "object" }),
    messages: array(message),
    status: string,
    managerLifecycle: lifecycleSchema,
  },
  ["approvals", "items", "messages", "status"],
);
const taskSchema = object(
  {
    id: string,
    status: string,
    runId: { type: ["string", "null"] },
    attention: array(
      object({ id: string, kind: string, message: string }, [
        "id",
        "kind",
        "message",
      ]),
    ),
    lifecycleRequests: array(object({ status: string }, ["status"])),
  },
  ["id", "status"],
);
const orchestrationSchema = object({ tasks: array(taskSchema) }, ["tasks"]);
const profileSchema = object(
  {
    voice: { type: ["string", "null"] },
    version: string,
    configured: { type: "boolean" },
  },
  ["voice", "version"],
);
const prompt = object({ text: string, version: string }, ["text", "version"]);
const settingsSchema = object(
  {
    managerProfile: profileSchema,
    managerLifecycle: lifecycleSchema,
    manager: object({ saved: prompt }, ["saved"]),
    worker: object({ saved: prompt }, ["saved"]),
  },
  ["managerProfile", "managerLifecycle", "manager", "worker"],
);
const updateSchema = object({
  phase: string,
  plan: nullable(object({ phase: string }, ["phase"])),
  workspacePlan: nullable(object({ phase: string }, ["phase"])),
});
const prepare = object({ state: workSchema, plan: string });
const schemas: Record<keyof ApiResults, Schema> = {
  voices: object(
    {
      voices: array(object({ id: string, name: string }, ["id", "name"])),
      defaultVoice: string,
    },
    ["voices", "defaultVoice"],
  ),
  settings: settingsSchema,
  "settings/manager-profile": settingsSchema,
  "settings/prompts": settingsSchema,
  config: object(
    {
      project: object(
        {
          name: string,
          mode: string,
          readiness: object(
            { ready: { type: "boolean" }, issues: array(string) },
            ["ready", "issues"],
          ),
        },
        ["name", "mode", "readiness"],
      ),
    },
    ["project"],
  ),
  state: workSchema,
  prepare,
  orchestration: orchestrationSchema,
  updates: updateSchema,
  "manager/lifecycle": object({
    state: workSchema,
    managerLifecycle: lifecycleSchema,
  }),
  connect: object({ sessionToken: string, sdp: string }, [
    "sessionToken",
    "sdp",
  ]),
  disconnect: object({}),
  "voice-status": object({}),
  "voice-ready": object({}),
  work: object({}),
  "stop-work": object({}),
  approval: object({}),
  "worker-approval": object({}),
  "discuss-attention": object({}),
};
const responseSchemas: Record<string, Schema | undefined> = schemas;
const workerDetailSchema = object({
  conversation: array(
    object({ id: string, actor: string, kind: string, message: string }),
  ),
  notes: object({ markdown: nullable(string) }),
  links: array(object({})),
});
export function decodeApi<P extends ApiPath>(
  path: P,
  value: unknown,
): ApiResult<P> {
  const schema = path.startsWith("workers/")
    ? workerDetailSchema
    : responseSchemas[path];
  if (!schema) throw new Error(`Unsupported API response: ${path}`);
  const validate = compile<ApiResult<P>>(schema);
  if (!validate(value))
    throw new Error(`Invalid ${path} response: ${errorsText(validate.errors)}`);
  return value;
}
export type ManagerEvent =
  | { type: "update-state"; status: UpdateStatus }
  | { type: "work-state"; state: WorkState }
  | { type: "manager-lifecycle"; state: ManagerLifecycle }
  | { type: "update-plan-state"; plan: UpdatePlan | null }
  | { type: "orchestration-state"; state: OrchestrationState }
  | { type: "worker-approval-state"; requests: WorkerApproval[] }
  | { type: "notice" | "error"; message: string }
  | { type: "closed" };
const eventValidator = compile<ManagerEvent>({
  oneOf: [
    object({ type: { const: "update-state" }, status: updateSchema }, [
      "type",
      "status",
    ]),
    object({ type: { const: "work-state" }, state: workSchema }, [
      "type",
      "state",
    ]),
    object({ type: { const: "manager-lifecycle" }, state: lifecycleSchema }, [
      "type",
      "state",
    ]),
    object(
      {
        type: { const: "update-plan-state" },
        plan: nullable(object({ phase: string }, ["phase"])),
      },
      ["type", "plan"],
    ),
    object(
      { type: { const: "orchestration-state" }, state: orchestrationSchema },
      ["type", "state"],
    ),
    object(
      {
        type: { const: "worker-approval-state" },
        requests: array(
          object(
            {
              taskId: string,
              runId: string,
              approvalId: string,
              threadId: string,
              method: string,
              requestId: { type: ["number", "string"] },
            },
            [
              "taskId",
              "runId",
              "approvalId",
              "threadId",
              "method",
              "requestId",
            ],
          ),
        ),
      },
      ["type", "requests"],
    ),
    object({ type: { enum: ["notice", "error"] }, message: string }, [
      "type",
      "message",
    ]),
    object({ type: { const: "closed" } }, ["type"]),
  ],
});
/** Ignore protocol events the UI does not consume; reject malformed consumed events. */
export function decodeManagerEvent(value: unknown): ManagerEvent | null {
  if (!value || typeof value !== "object" || !("type" in value))
    throw new Error("Live event has no type.");
  if (
    ![
      "update-state",
      "work-state",
      "manager-lifecycle",
      "update-plan-state",
      "orchestration-state",
      "worker-approval-state",
      "notice",
      "error",
      "closed",
    ].includes(String(value.type))
  )
    return null;
  if (!eventValidator(value))
    throw new Error(`Invalid live event: ${errorsText(eventValidator.errors)}`);
  return value;
}
