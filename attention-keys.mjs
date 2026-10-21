// Shared by the browser and native owner. Labels, failures and prose do not
// establish that a human response is required.
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const list = value => Array.isArray(value) ? value : [];
export function attentionKeys(work = {}, orchestration = {}, workerApprovals = []) {
  const keys = [];
  if (id(work?.threadId)) {
    for (const request of list(work.approvals)) if (id(request?.id)) keys.push(JSON.stringify(['approval', work.threadId, request.attentionId || request.params?.turnId || '', request.params?.itemId || '', request.id]));
    for (const item of list(work.items)) if (id(item?.attention?.id) && typeof item.attention.message === 'string' && item.attention.message.trim()) keys.push(JSON.stringify(['manager', work.threadId, item.attention.id]));
  }
  for (const task of list(orchestration?.tasks)) {
    const question = task?.question;
    if (id(task?.id) && id(question?.id) && id(question.runId) && question.runId === task.runId && task.answer?.questionId !== question.id && task.status === 'awaiting_answer') {
      keys.push(JSON.stringify(['question', task.id, task.runId, question.id]));
    }
  }
  for (const request of list(workerApprovals)) {
    if (request?.status !== 'pending' || !id(request.taskId) || !id(request.runId) || !id(request.threadId)
      || !(id(request.turnId) || request.turnId === null && request.method === 'mcpServer/elicitation/request')
      || !(id(request.requestId) || Number.isSafeInteger(request.requestId))) continue;
    // Native approval snapshots and task snapshots arrive independently. Once
    // task state is known, an older run cannot request another attention cue.
    if (Array.isArray(orchestration?.tasks) && !orchestration.tasks.some(task => task?.id === request.taskId && task.runId === request.runId && !['completed', 'stopped', 'paused', 'disposed', 'failed'].includes(task.status))) continue;
    keys.push(JSON.stringify(['worker-approval', request.taskId, request.runId, request.threadId, request.turnId, request.requestId]));
  }
  return keys;
}
