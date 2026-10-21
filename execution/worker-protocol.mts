import { Ajv } from "ajv";
import type {
  Project,
  EnvironmentEvidence,
  ModelSelection,
} from "./contracts.mjs";
import type { ApprovalParams } from "./approvals.mjs";
import { isRecord } from "./errors.mjs";
export interface WorkerConfiguration {
  taskId: string;
  runId: string;
  stateDir: string;
  worktree: string;
  executable: string;
  mcpScript: string;
  workerPrompt: string;
  workerPromptVersion?: string;
  sandbox: string;
  timeoutMs: number;
  ticket: string;
  brief: string;
  project: Project | null;
  environment?: EnvironmentEvidence;
  modelSelection?: ModelSelection | null;
  threadId?: string | null;
  answer?: { text: string } | null;
}
const ajv = new Ajv({ strict: false });
const configShape = ajv.compile<WorkerConfiguration>({
  type: "object",
  required: [
    "taskId",
    "runId",
    "stateDir",
    "worktree",
    "executable",
    "mcpScript",
    "workerPrompt",
    "sandbox",
    "timeoutMs",
    "ticket",
    "brief",
  ],
  properties: {
    taskId: { type: "string" },
    runId: { type: "string" },
    stateDir: { type: "string" },
    worktree: { type: "string" },
    executable: { type: "string" },
    mcpScript: { type: "string" },
    workerPrompt: { type: "string" },
    sandbox: { type: "string" },
    timeoutMs: { type: "number" },
    ticket: { type: "string" },
    brief: { type: "string" },
    project: { type: ["object", "null"] },
    environment: { type: "object" },
    modelSelection: { type: ["object", "null"] },
    threadId: { type: ["string", "null"] },
  },
});
export function parseWorkerConfiguration(value: unknown): WorkerConfiguration {
  if (!configShape(value))
    throw new Error("Malformed worker runner configuration.");
  return value;
}
export interface NativeThread {
  id: string;
}
export interface NativeTurn {
  id: string;
  status?: string;
  error?: { message?: string } | null;
}
export interface NativeItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  exitCode?: number | null;
  aggregatedOutput?: string;
  status?: string;
}
export interface WorkerNativeParams extends Partial<ApprovalParams> {
  thread?: NativeThread;
  turn?: NativeTurn;
  item?: NativeItem;
  error?: { message?: string };
  fromModel?: string;
  toModel?: string;
  reason?: string;
  requestId?: string | number;
}
export interface WorkerNativeMessage {
  id?: string | number;
  method?: string;
  params?: WorkerNativeParams;
  result?: unknown;
  error?: { message: string };
}
const messageShape = ajv.compile<WorkerNativeMessage>({
  type: "object",
  properties: {
    id: { type: ["string", "number"] },
    method: { type: "string" },
    error: {
      type: "object",
      required: ["message"],
      properties: { message: { type: "string" } },
    },
    params: {
      type: "object",
      properties: {
        threadId: { type: "string" },
        turnId: { type: ["string", "null"] },
        thread: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        turn: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string" },
            status: { type: "string" },
            error: {
              type: ["object", "null"],
              properties: { message: { type: "string" } },
            },
          },
        },
        item: {
          type: "object",
          properties: {
            id: { type: "string" },
            type: { type: "string" },
            text: { type: "string" },
            command: { type: "string" },
            exitCode: { type: ["number", "null"] },
            aggregatedOutput: { type: "string" },
            status: { type: "string" },
          },
        },
        error: { type: "object", properties: { message: { type: "string" } } },
      },
    },
  },
});
export function parseWorkerMessage(value: unknown): WorkerNativeMessage {
  if (!messageShape(value))
    throw new Error("Malformed worker native protocol envelope.");
  return value;
}
export interface NativeResult {
  account?: { type?: string } | null;
  thread?: NativeThread;
  turn?: NativeTurn;
  model?: string;
  sandbox?: { type?: string };
  approvalPolicy?: unknown;
  approvalsReviewer?: unknown;
  config?: Record<string, unknown>;
  data?: unknown[];
  nextCursor?: unknown;
}
export interface ThreadResult extends NativeResult {
  thread: NativeThread;
}
export interface TurnResult extends NativeResult {
  turn: NativeTurn;
}
/** RPC results are validated against the method before promises become observable. */
export function parseWorkerResult(
  method: string,
  value: unknown,
): NativeResult {
  if (!isRecord(value)) throw new Error(`Malformed ${method} result.`);
  const thread =
    isRecord(value.thread) && typeof value.thread.id === "string"
      ? { id: value.thread.id }
      : undefined;
  const turn =
    isRecord(value.turn) && typeof value.turn.id === "string"
      ? { id: value.turn.id }
      : undefined;
  if ((method === "thread/start" || method === "thread/resume") && !thread)
    throw new Error(`Malformed ${method} thread identity.`);
  if (method === "turn/start" && !turn)
    throw new Error(
      "Native model continuation did not acknowledge a turn identity; selection was not confirmed.",
    );
  return {
    account: isRecord(value.account)
      ? {
          type:
            typeof value.account.type === "string"
              ? value.account.type
              : undefined,
        }
      : null,
    thread,
    turn,
    model: typeof value.model === "string" ? value.model : undefined,
    sandbox: isRecord(value.sandbox)
      ? {
          type:
            typeof value.sandbox.type === "string"
              ? value.sandbox.type
              : undefined,
        }
      : undefined,
    approvalPolicy: value.approvalPolicy,
    approvalsReviewer: value.approvalsReviewer,
    config: isRecord(value.config) ? value.config : undefined,
    data: Array.isArray(value.data) ? value.data : undefined,
    nextCursor: value.nextCursor,
  };
}
export interface WorkerStopRequest {
  runId: string;
  requestId: string;
  action: string;
  cooperative?: boolean;
}
export function parseWorkerStopRequest(
  value: unknown,
): WorkerStopRequest | null {
  if (
    !isRecord(value) ||
    typeof value.runId !== "string" ||
    typeof value.requestId !== "string" ||
    typeof value.action !== "string"
  )
    return null;
  return {
    runId: value.runId,
    requestId: value.requestId,
    action: value.action,
    cooperative: value.cooperative === true,
  };
}
