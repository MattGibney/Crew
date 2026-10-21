import { isRecord } from "./errors.mjs";
import { updateTask } from "../orchestration-store.mjs";
import { ensureAssignments, currentAssignment } from "./assignments.mjs";
import { identifier, text } from "./task-fields.mjs";
const now = () => new Date().toISOString();
function cleanMetadata(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const value: unknown = JSON.parse(JSON.stringify(input));
  if (!isRecord(value)) throw new Error("Direction metadata is invalid");
  return value;
}
// Direction is communication to this worker. Native Codex owns execution policy.
export async function requestWorkerFollowup(
  dir: string,
  {
    taskId,
    requestId,
    expectedRunId,
    expectedAssignmentId,
    ticket,
    brief,
    userDecision,
    reviewedWorktreeFingerprint,
  }: {
    taskId: string;
    requestId: string;
    expectedRunId?: string | null;
    expectedAssignmentId?: string | null;
    ticket?: string;
    brief: string;
    userDecision?: unknown;
    reviewedWorktreeFingerprint?: unknown;
  },
) {
  identifier(taskId);
  identifier(requestId, "follow-up request ID");
  text(brief, "direction");
  if (ticket !== undefined) text(ticket, "ticket", 120);
  if (expectedRunId !== undefined && expectedRunId !== null)
    text(expectedRunId, "observed run ID", 160);
  if (expectedAssignmentId !== undefined && expectedAssignmentId !== null)
    text(expectedAssignmentId, "observed assignment ID", 80);
  return updateTask(dir, taskId, (task) => {
    const assignments = ensureAssignments(task),
      existing = assignments.find((item) => item.id === requestId),
      requestMetadata = cleanMetadata({
        userDecision,
        reviewedWorktreeFingerprint,
      });
    if (existing) {
      if (
        existing.brief !== brief ||
        JSON.stringify(
          Object.hasOwn(existing, "requestTicket")
            ? existing.requestTicket
            : existing.ticket,
        ) !== JSON.stringify(ticket ?? null) ||
        existing.expectedRunId !== expectedRunId ||
        existing.expectedAssignmentId !== expectedAssignmentId ||
        JSON.stringify(
          existing.requestMetadata ||
            cleanMetadata({
              userDecision: existing.userDecision,
              reviewedWorktreeFingerprint: existing.reviewedWorktreeFingerprint,
            }),
        ) !== JSON.stringify(requestMetadata)
      )
        throw new Error("Follow-up request ID reused with changed content");
      return;
    }
    if (
      ["disposed", "removed", "archived"].includes(task.status) ||
      task.archiveRestoration?.requiresRecovery ||
      task.lifecycleRequests?.some(
        (item) =>
          ["dispose", "archive"].includes(item.action) &&
          ["pending", "processing"].includes(item.status),
      )
    )
      throw new Error(
        "Worker is archived, history only, or archive/disposal is pending",
      );
    assignments.push({
      id: requestId,
      ticket: ticket || currentAssignment(task).ticket || task.ticket,
      requestTicket: ticket ?? null,
      requestMetadata,
      brief,
      expectedRunId,
      expectedAssignmentId,
      enqueuedRunId: task.runId || null,
      enqueuedAssignmentId: task.currentAssignmentId,
      status: "queued",
      createdAt: now(),
      runIds: [],
    });
  });
}

// Project workflow is explicit agent communication, separate from execution.
export async function setWorkflowState(
  dir: string,
  {
    taskId,
    requestId,
    state,
    actor = "manager",
    runId = null,
  }: {
    taskId: string;
    requestId: string;
    state: string;
    actor?: string;
    runId?: string | null;
  },
) {
  identifier(taskId);
  identifier(requestId, "workflow request ID");
  text(state, "workflow state", 400);
  if (!["manager", "worker"].includes(actor))
    throw new Error("Invalid workflow actor");
  if (actor === "worker") text(runId, "bound worker run ID", 160);
  return updateTask(dir, taskId, (task) => {
    const history = (task.workflowHistory ||= []);
    const existing = history.find(
      (event) =>
        event.requestId === requestId &&
        event.actor === actor &&
        (actor === "manager" || event.runId === runId),
    );
    if (existing) {
      if (existing.value !== state)
        throw new Error("Workflow request ID reused with changed content");
      return;
    }
    if (actor === "worker" && task.runId !== runId)
      throw new Error("Stale worker run");
    const event = {
      value: state,
      requestId,
      actor,
      runId: actor === "worker" ? runId : task.runId || null,
      assignmentId: currentAssignment(task).id,
      at: now(),
    };
    history.push(event);
    task.workflowState = { ...event };
    (task.history ||= []).push({
      id: `workflow:${actor}:${runId || "manager"}:${requestId}`,
      actor,
      kind: "workflow",
      message: `Project workflow: ${state}`,
      at: event.at,
      runId: event.runId,
      assignmentId: event.assignmentId,
    });
  });
}
