import { validateWorkLink } from "../shared/tracking.mjs";
import type { TaskRecord, WorkerAssignment } from "../workers/contracts.mjs";
import { ID, text, identifier } from "./task-fields.mjs";
const now = () => new Date().toISOString();
const ASSIGNMENT_STATES = new Set([
  "queued",
  "active",
  "completed",
  "stopped",
  "failed",
]);
function assignmentStatus(status: string) {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (["stopped", "paused", "disposed"].includes(status)) return "stopped";
  if (status === "queued") return "queued";
  return "active";
}
// Legacy tasks remain readable without rewriting their retained state.
export function currentAssignment(task: TaskRecord): WorkerAssignment {
  return (
    task.assignments?.find((item) => item.id === task.currentAssignmentId) || {
      id: "initial",
      ticket: task.ticket,
      ...(task.workLink !== undefined ? { workLink: task.workLink } : {}),
      brief: task.brief,
      userDecision: null,
      status: assignmentStatus(task.status),
      createdAt: task.createdAt,
      runIds: [
        ...new Set(
          [
            ...(task.history || []).map((item) => item.runId),
            ...(task.reports || []).map((item) => item.runId),
            task.runId,
          ].filter(
            (id): id is string => typeof id === "string" && Boolean(id.trim()),
          ),
        ),
      ],
      ...(task.result ? { result: structuredClone(task.result) } : {}),
      ...(task.status === "completed"
        ? { endedAt: task.completedAt || task.endedAt || task.updatedAt }
        : {}),
    }
  );
}
export function ensureAssignments(task: TaskRecord): WorkerAssignment[] {
  if (!task.assignments) {
    task.assignments = [currentAssignment(task)];
    task.currentAssignmentId = "initial";
  }
  return task.assignments;
}
export function synchronizeAssignment(task: TaskRecord, previous: TaskRecord) {
  if (!task.assignments) return;
  const assignment = task.assignments.find(
    (item) => item.id === task.currentAssignmentId,
  );
  if (!assignment || assignment.status === "completed") return;
  assignment.status = assignmentStatus(task.status);
  if (["active", "queued"].includes(assignment.status))
    delete assignment.endedAt;
  const runId = task.runId;
  if (
    runId &&
    (runId !== previous.runId ||
      task.currentAssignmentId === previous.currentAssignmentId) &&
    !task.assignments.some(
      (other) => other.id !== assignment.id && other.runIds.includes(runId),
    ) &&
    !assignment.runIds.includes(runId)
  )
    assignment.runIds.push(runId);
  if (assignment.status === "completed") {
    if (task.result) assignment.result = structuredClone(task.result);
    assignment.endedAt = task.completedAt || task.endedAt || now();
  }
}
export function validateAssignments(task: TaskRecord) {
  if (task.assignments === undefined && task.currentAssignmentId === undefined)
    return;
  if (
    !Array.isArray(task.assignments) ||
    !task.assignments.length ||
    !task.assignments.some((item) => item.id === task.currentAssignmentId)
  )
    throw new Error("Malformed assignment history");
  const ids = new Set();
  for (const item of task.assignments) {
    if (
      !item ||
      (item.id !== "initial" && !ID.test(item.id)) ||
      ids.has(item.id) ||
      !ASSIGNMENT_STATES.has(item.status) ||
      !Number.isFinite(Date.parse(item.createdAt)) ||
      !Array.isArray(item.runIds) ||
      new Set(item.runIds).size !== item.runIds.length ||
      item.runIds.some((id) => typeof id !== "string" || !id.trim()) ||
      (item.endedAt !== undefined &&
        !Number.isFinite(Date.parse(item.endedAt || "")))
    )
      throw new Error("Malformed assignment history");
    if (
      item.reviewedWorktreeFingerprint !== undefined &&
      !/^[a-f0-9]{64}$/.test(item.reviewedWorktreeFingerprint)
    )
      throw new Error("Malformed reviewed worktree fingerprint");
    if (
      item.adoptions !== undefined &&
      (!Array.isArray(item.adoptions) ||
        new Set(item.adoptions.map((entry) => entry?.id)).size !==
          item.adoptions.length ||
        item.adoptions.some(
          (entry) =>
            !entry ||
            !ID.test(entry.id) ||
            !/^[a-f0-9]{64}$/.test(entry.fingerprint || "") ||
            !Number.isFinite(Date.parse(entry.at)) ||
            (entry.expectedRunId !== null &&
              (typeof entry.expectedRunId !== "string" ||
                !entry.expectedRunId.trim())),
        ))
    )
      throw new Error("Malformed assignment adoption history");
    for (const adoption of item.adoptions || [])
      text(adoption.userDecision, "assignment adoption decision", 4000);
    if (item.ticket !== "") text(item.ticket, "assignment ticket", 500);
    validateWorkLink(item.workLink);
    validateWorkLink(item.requestWorkLink);
    text(item.brief, "assignment brief");
    if (item.id !== "initial") {
      identifier(item.id, "assignment ID");
      if (item.userDecision != null)
        text(item.userDecision, "assignment user decision", 4000);
    }
    ids.add(item.id);
  }
}
export function preserveAssignments(next: TaskRecord, previous: TaskRecord) {
  if (!previous.assignments) return;
  if (
    !Array.isArray(next.assignments) ||
    next.assignments.length < previous.assignments.length
  )
    throw new Error("Assignment history is immutable");
  for (const [index, before] of previous.assignments.entries()) {
    const after = next.assignments[index];
    if (
      !after ||
      (
        [
          "id",
          "ticket",
          "workLink",
          "requestWorkLink",
          "brief",
          "userDecision",
          "createdAt",
          "expectedRunId",
          "expectedAssignmentId",
          "reviewedWorktreeFingerprint",
          "requestTicket",
          "enqueuedRunId",
          "enqueuedAssignmentId",
          "requestMetadata",
        ] as const
      ).some(
        (key) => JSON.stringify(after[key]) !== JSON.stringify(before[key]),
      )
    )
      throw new Error("Assignment identity is immutable");
    if (
      before.status === "completed" &&
      JSON.stringify(after) !== JSON.stringify(before)
    )
      throw new Error("Completed assignment is immutable");
    if (
      JSON.stringify(
        after.adoptions?.slice(0, (before.adoptions || []).length) || [],
      ) !== JSON.stringify(before.adoptions || [])
    )
      throw new Error("Assignment adoption history is immutable");
    if (
      JSON.stringify(after.runIds?.slice(0, before.runIds.length)) !==
      JSON.stringify(before.runIds)
    )
      throw new Error("Assignment run history is immutable");
  }
}
