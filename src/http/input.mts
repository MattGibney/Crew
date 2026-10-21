import { record } from "../shared/errors.mjs";
import { parseApprovalResponse } from "./approval-input.mjs";
import type { ApprovalResponse } from "../workers/approvals.mjs";
export interface ApiInput {
  action: string;
  targetVersion: string;
  planId: string;
  token: string;
  taskId: string;
  attentionId: string;
  sessionToken: string;
  text: string;
  requestId: string;
  sdp: string;
  voice?: string;
  id: string | number;
  response: ApprovalResponse;
  status: unknown;
}
/** Do not trust JSON's `any` return type. Preserve the raw object for settings,
 * whose independent stores enforce replacement and optimistic-save contracts. */
export function parseApiInput(value: unknown): ApiInput {
  if (!record(value)) throw new Error("Request body must be a JSON object.");
  const input = value;
  function field(key: string): string {
    const item = input[key];
    if (item === undefined) return "";
    if (typeof item !== "string") throw new Error(`Invalid ${key}.`);
    return item;
  }
  const id = value.id;
  if (id !== undefined && typeof id !== "string" && typeof id !== "number")
    throw new Error("Invalid native request identity.");
  if (value.voice !== undefined && typeof value.voice !== "string")
    throw new Error("Invalid voice.");
  return {
    action: field("action"),
    targetVersion: field("targetVersion"),
    planId: field("planId"),
    token: field("token"),
    taskId: field("taskId"),
    attentionId: field("attentionId"),
    sessionToken: field("sessionToken"),
    text: field("text"),
    requestId: typeof value.requestId === "number" ? "" : field("requestId"),
    sdp: field("sdp"),
    voice: value.voice,
    id: id ?? "",
    response:
      value.response === undefined
        ? {}
        : parseApprovalResponse(JSON.stringify(value.response)),
    status: value.status,
  };
}

export function parseArchiveAction(value: unknown) {
  if (
    !record(value) ||
    typeof value.taskId !== "string" ||
    typeof value.action !== "string" ||
    typeof value.operationId !== "string" ||
    typeof value.expectedRevision !== "number"
  )
    throw new Error("Invalid archived worker action.");
  return {
    taskId: value.taskId,
    action: value.action,
    operationId: value.operationId,
    expectedRevision: value.expectedRevision,
  };
}
