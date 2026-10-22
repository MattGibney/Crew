import { validateWorkLink } from "../shared/tracking.mjs";
import { ID } from "./task-fields.mjs";
import { parseTaskRecord } from "./task-validation.mjs";
import { validateAssignments } from "./assignments.mjs";
import { promptSnapshot } from "../manager/instructions/settings.mjs";
export const LIFECYCLE_ACTIONS = new Set([
  "stop",
  "pause",
  "resume",
  "start",
  "retry_setup",
  "dispose",
  "archive",
  "reconcile_plan",
  "retire_missing",
]);
export const LIFECYCLE_STATES = new Set([
  "pending",
  "processing",
  "completed",
  "failed",
]);
export const REPORT_KINDS = new Set([
  "progress",
  "question",
  "result",
  "blocked",
]);
export function validatePersistedTask(input: unknown, expectedId: string) {
  const task = parseTaskRecord(input, expectedId);
  validateWorkLink(task.workLink);
  if (
    !task ||
    typeof task !== "object" ||
    Array.isArray(task) ||
    task.id !== expectedId ||
    !ID.test(task.id) ||
    typeof task.ticket !== "string" ||
    task.ticket.length > 500 ||
    typeof task.brief !== "string" ||
    !task.brief.trim() ||
    task.brief.length > 12000 ||
    (["projectId", "repositoryId"] as const).some(
      (key) =>
        task[key] != null &&
        (typeof task[key] !== "string" ||
          !/^[a-zA-Z0-9_-]{1,80}$/.test(task[key])),
    ) ||
    typeof task.status !== "string" ||
    !task.status ||
    !Number.isSafeInteger(task.revision) ||
    task.revision < 1 ||
    !Number.isFinite(Date.parse(task.createdAt)) ||
    !Number.isFinite(Date.parse(task.updatedAt)) ||
    (task.lifecycleRequests !== undefined &&
      (!Array.isArray(task.lifecycleRequests) ||
        task.lifecycleRequests.some(
          (request) =>
            !request ||
            typeof request.id !== "string" ||
            !ID.test(request.id) ||
            !LIFECYCLE_ACTIONS.has(request.action) ||
            !LIFECYCLE_STATES.has(request.status) ||
            (request.settleNaturally === true &&
              (request.cooperative !== true || request.action !== "pause")) ||
            !Number.isFinite(Date.parse(request.at)) ||
            (request.expectedRunId != null &&
              (typeof request.expectedRunId !== "string" ||
                !request.expectedRunId.trim())),
        ))) ||
    (task.workerPromptSnapshot !== undefined &&
      (!task.workerPromptSnapshot ||
        typeof task.workerPromptSnapshot.text !== "string" ||
        task.workerPromptSnapshot.version !==
          promptSnapshot(task.workerPromptSnapshot.text).version)) ||
    (task.history !== undefined &&
      (!Array.isArray(task.history) ||
        task.history.some(
          (event) =>
            !event ||
            typeof event.id !== "string" ||
            !["manager", "worker", "controller"].includes(event.actor) ||
            typeof event.kind !== "string" ||
            typeof event.message !== "string",
        ))) ||
    !Array.isArray(task.reports) ||
    !Array.isArray(task.attention) ||
    task.reports.some(
      (r) =>
        !r ||
        typeof r.reportId !== "string" ||
        typeof r.runId !== "string" ||
        !REPORT_KINDS.has(r.kind) ||
        typeof r.message !== "string",
    ) ||
    task.attention.some((a) => !a || typeof a.id !== "string")
  )
    throw new Error(
      `Malformed state for ${expectedId}; refusing to replace it`,
    );
  validateAssignments(task);
  if (
    task.workflowHistory !== undefined &&
    (!Array.isArray(task.workflowHistory) ||
      task.workflowHistory.some(
        (event) =>
          !event ||
          typeof event.requestId !== "string" ||
          !["manager", "worker"].includes(event.actor) ||
          typeof event.value !== "string" ||
          !event.value.trim() ||
          !Number.isFinite(Date.parse(event.at)) ||
          [event.progressPercent, event.reportedProgressPercent].some(
            (value) =>
              value !== undefined &&
              value !== null &&
              (typeof value !== "number" ||
                !Number.isFinite(value) ||
                value < 0 ||
                value > 100),
          ),
      ))
  )
    throw new Error("Malformed workflow history");
  if (
    task.workflowState !== undefined &&
    (!task.workflowState ||
      typeof task.workflowState.value !== "string" ||
      !task.workflowState.value.trim() ||
      !task.workflowHistory?.some(
        (event) => JSON.stringify(event) === JSON.stringify(task.workflowState),
      ))
  )
    throw new Error("Malformed workflow state");
  return task;
}
