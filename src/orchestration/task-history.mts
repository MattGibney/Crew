import type { TaskRecord, TaskHistory } from "../workers/contracts.mjs";
const now = () => new Date().toISOString();
export function recordHistory(
  task: TaskRecord,
  previous: TaskRecord | null = null,
) {
  const history = (task.history ||= []);
  const add = (
    id: string,
    actor: string,
    kind: string,
    message: string,
    extra: Partial<TaskHistory> = {},
  ) => {
    if (!history.some((event) => event.id === id))
      history.push({
        id,
        actor,
        kind,
        message,
        at: now(),
        runId: task.runId || null,
        ...extra,
      });
  };
  if (
    previous &&
    task.workerPromptSnapshot?.version !==
      previous.workerPromptSnapshot?.version &&
    task.workerPromptSnapshot
  )
    add(
      `worker-prompt:${previous.revision + 1}`,
      "controller",
      "configuration",
      "Worker instructions refreshed for the current continuation.",
      { instructionVersion: task.workerPromptSnapshot.version },
    );
  if (!previous)
    add("assignment", "manager", "instruction", task.brief, {
      at: task.createdAt,
      runId: null,
    });
  for (const assignment of task.assignments || [])
    if (assignment.id !== "initial")
      add(
        `assignment:${assignment.id}`,
        "manager",
        "instruction",
        assignment.brief,
        {
          at: assignment.createdAt,
          runId: null,
          assignmentId: assignment.id,
          ticket: assignment.ticket,
          userDecision: assignment.userDecision,
        },
      );
  for (const assignment of task.assignments || [])
    for (const adoption of assignment.adoptions || [])
      add(
        `adoption:${assignment.id}:${adoption.id}`,
        "manager",
        "instruction",
        `Authorized preservation and adoption of reviewed worktree changes: ${adoption.userDecision}`,
        {
          at: adoption.at,
          runId: adoption.expectedRunId,
          assignmentId: assignment.id,
          worktreeFingerprint: adoption.fingerprint,
        },
      );
  for (const report of task.reports)
    add(
      `report:${report.runId}:${report.reportId}`,
      "worker",
      report.kind,
      report.message,
      { at: report.at, runId: report.runId, evidence: report.evidence || [] },
    );
  if (
    task.answer &&
    JSON.stringify(task.answer) !== JSON.stringify(previous?.answer)
  )
    add(
      `answer:${task.answer.questionId}`,
      "manager",
      "answer",
      task.answer.text,
      { at: task.answer.at, questionId: task.answer.questionId },
    );
  for (const request of task.lifecycleRequests || []) {
    const before = previous?.lifecycleRequests?.find(
      (item) => item.id === request.id,
    );
    if (!before)
      add(
        `action:${request.id}`,
        request.cooperative ? "controller" : "manager",
        "lifecycle_request",
        `Requested ${request.action}${request.decision ? `: ${request.decision}` : ""}`,
        { at: request.at, runId: request.expectedRunId },
      );
    if (before && before.status !== request.status)
      add(
        `action:${request.id}:${request.status}`,
        "controller",
        "lifecycle",
        `${request.action}: ${request.status}${request.error ? ` — ${request.error}` : ""}`,
        { at: request.handledAt || now(), runId: request.expectedRunId },
      );
  }
  if (
    previous &&
    (task.status !== previous.status || task.runId !== previous.runId)
  )
    add(
      `state:${previous.revision + 1}`,
      "controller",
      "status",
      `Worker status: ${task.status}${task.failure ? ` — ${task.failure}` : ""}`,
      { status: task.status },
    );
}
