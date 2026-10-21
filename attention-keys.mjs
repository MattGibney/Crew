// Shared by the browser and native owner. Labels, failures and prose do not
// establish that a human response is required.
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const list = value => Array.isArray(value) ? value : [];
export function attentionKeys(work = {}, orchestration = {}) {
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
  return keys;
}
