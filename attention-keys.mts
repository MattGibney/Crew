import { isArchivedTask } from "./worker-archive.mjs";
import { record } from "./shared/errors.mjs";
// Shared by the browser and native owner. Labels, failures and prose do not
// establish that a human response is required.
const id = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 200;
const list = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(record) : [];
export function attentionKeys(
  workInput: unknown = {},
  orchestrationInput: unknown = {},
  workerApprovals: unknown = [],
) {
  const work = record(workInput) ? workInput : {};
  const orchestration = record(orchestrationInput) ? orchestrationInput : {};
  const keys = [];
  if (id(work?.threadId)) {
    for (const request of list(work.approvals))
      if (id(request?.id))
        keys.push(
          JSON.stringify([
            "approval",
            work.threadId,
            request.attentionId ||
              (record(request.params) ? request.params.turnId : "") ||
              "",
            (record(request.params) ? request.params.itemId : "") || "",
            request.id,
          ]),
        );
    for (const item of list(work.items))
      if (
        record(item.attention) &&
        id(item.attention.id) &&
        typeof item.attention.message === "string" &&
        item.attention.message.trim()
      )
        keys.push(
          JSON.stringify(["manager", work.threadId, item.attention.id]),
        );
  }
  for (const task of list(orchestration?.tasks)) {
    if (isArchivedTask(task)) continue;
    const question = record(task.question) ? task.question : {};
    const answer = record(task.answer) ? task.answer : {};
    if (
      id(task?.id) &&
      id(question?.id) &&
      id(question.runId) &&
      question.runId === task.runId &&
      answer.questionId !== question.id &&
      task.status === "awaiting_answer"
    ) {
      keys.push(JSON.stringify(["question", task.id, task.runId, question.id]));
    }
  }
  for (const request of list(workerApprovals)) {
    if (
      request?.status !== "pending" ||
      !id(request.taskId) ||
      !id(request.runId) ||
      !id(request.threadId) ||
      !(
        id(request.turnId) ||
        (request.turnId === null &&
          request.method === "mcpServer/elicitation/request")
      ) ||
      !(id(request.requestId) || Number.isSafeInteger(request.requestId))
    )
      continue;
    // Native approval snapshots and task snapshots arrive independently. Once
    // task state is known, an older run cannot request another attention cue.
    if (
      Array.isArray(orchestration?.tasks) &&
      !list(orchestration.tasks).some(
        (task) =>
          task.id === request.taskId &&
          !isArchivedTask(task) &&
          !(record(task.archiveRestoration) && task.archiveRestoration.requiresRecovery) &&
          task.runId === request.runId &&
          !["completed", "stopped", "paused", "disposed", "failed"].includes(
            String(task.status),
          ),
      )
    )
      continue;
    keys.push(
      JSON.stringify([
        "worker-approval",
        request.taskId,
        request.runId,
        request.threadId,
        request.turnId,
        request.requestId,
      ]),
    );
  }
  return keys;
}
