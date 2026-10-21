import { parseRecord, record } from "../shared/errors.mjs";
import type { ApprovalResponse } from "../execution/approvals.mjs";
export function parseRequestId(text: string): string | number {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "string" && typeof value !== "number")
    throw new Error("Invalid native request identity");
  return value;
}
export function parseApprovalResponse(text: string): ApprovalResponse {
  // Individual response fields and permission subsets are validated against the
  // exact persisted native request by workerApprovalResponse before delivery.
  const value = parseRecord(text);
  for (const field of ["action", "scope"])
    if (value[field] !== undefined && typeof value[field] !== "string")
      throw new Error("Invalid native approval response");
  if (
    value.strictAutoReview !== undefined &&
    typeof value.strictAutoReview !== "boolean"
  )
    throw new Error("Invalid native approval response");
  const result: ApprovalResponse = { ...value };
  if (typeof value.action === "string") result.action = value.action;
  if (typeof value.scope === "string") result.scope = value.scope;
  if (typeof value.strictAutoReview === "boolean")
    result.strictAutoReview = value.strictAutoReview;
  return result;
}
export function parseWorkerApproval(input: unknown) {
  if (!record(input)) throw new Error("Invalid worker request identity");
  const { taskId, runId, approvalId, threadId, turnId, requestId } = input;
  if (
    typeof taskId !== "string" ||
    typeof runId !== "string" ||
    typeof approvalId !== "string" ||
    typeof threadId !== "string" ||
    (turnId !== null && typeof turnId !== "string") ||
    (typeof requestId !== "string" && typeof requestId !== "number")
  )
    throw new Error("Invalid worker request identity");
  return {
    taskId,
    runId,
    approvalId,
    threadId,
    turnId,
    requestId,
    response: parseApprovalResponse(JSON.stringify(input.response)),
  };
}
