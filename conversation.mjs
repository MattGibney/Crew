// Native user messages are restored from the same saved manager chat. Controller
// review prompts are implementation context, so show their actual UI intent.
export function conversationMessage(item, turnId) {
  if (item.type === 'agentMessage') return { id: item.id, turnId, role: 'assistant', phase: item.phase, text: item.text };
  if (item.type !== 'userMessage') return null;
  const text = (item.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
  if (!text) return null;
  let presentation = text.startsWith('The user explicitly chose to review this queued controller attention item.')
    ? 'Review the selected worker update with me.'
    : text.startsWith('CREW_WORKER_ACTION\n') ? 'Apply the selected worker action.' : text;
  if (text.startsWith('CREW_WORKER_ACTION\n')) {
    try {
      const selected = JSON.parse(text.match(/selected worker only: (\{[^\n]+?\})\./)?.[1] || '{}');
      if (['pause', 'stop', 'resume', 'dispose', 'start'].includes(selected.action) && /^[\w-]{1,120}$/.test(selected.taskId)) presentation = `${selected.action === 'dispose' ? 'Remove the worktree for' : selected.action[0].toUpperCase() + selected.action.slice(1)} worker ${selected.taskId}.`;
    } catch { /* Keep bounded generic intent if native history has an older format. */ }
  }
  if(text.startsWith('CREW_WORKER_RECOVERY_REVIEW\n'))presentation='Review recovery options for this worker with me.';
  return { id: item.id, turnId, role: 'user', text: presentation };
}
