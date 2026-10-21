// Realtime handoffs carry a current request plus historical context for the
// native agent. Only the request is user speech; history is not another message.
// Keep this a presentation projection, never rewrite/replay the native payload.
function userMessagePresentation(text) {
  if (!/^\s*<realtime_delegation>/.test(text)) return text;
  // A quoted example followed by ordinary prose is not a standalone handoff.
  if (text.includes('</realtime_delegation>') && !/<\/realtime_delegation>\s*$/.test(text)) return text;
  const input = text.match(/^\s*<realtime_delegation>\s*<input>([\s\S]*?)<\/input>\s*(?:<transcript_delta>[\s\S]*<\/transcript_delta>\s*)?<\/realtime_delegation>\s*$/);
  return input?.[1]?.trim() ? input[1] : 'Voice request (transcript unavailable).';
}

export function presentUserMessage(message) {
  if (message.role !== 'user' || message.source === 'voice' || message.presentation === 'realtime-input-v1') return message;
  const text = userMessagePresentation(message.text);
  // Persist provenance so a literal envelope in the user's current words is
  // never unwrapped a second time when restoring the presentation journal.
  return text === message.text ? message : { ...message, text, presentation: 'realtime-input-v1' };
}

// Native user messages are restored from the same saved manager chat. Controller
// review prompts are implementation context, so show their actual UI intent.
export function conversationMessage(item, turnId) {
  if (item.type === 'agentMessage') return { id: item.id, turnId, role: 'assistant', phase: item.phase, text: item.text };
  if (item.type !== 'userMessage') return null;
  const text = (item.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
  if (!text) return null;
  let presentation = text.startsWith('The user explicitly chose to review this queued controller attention item.')
    ? 'Review the selected worker update with me.'
    : text.startsWith('CREW_WORKER_RECOVERY_REVIEW\n') ? 'Review recovery options for this worker with me.'
    : text.startsWith('CREW_WORKER_ACTION\n') ? 'Apply the selected worker action.' : text;
  if (text.startsWith('CREW_WORKER_ACTION\n')) {
    try {
      const selected = JSON.parse(text.match(/selected worker only: (\{[^\n]+?\})\./)?.[1] || '{}');
      if (['pause', 'stop', 'resume', 'dispose', 'start'].includes(selected.action) && /^[\w-]{1,120}$/.test(selected.taskId)) presentation = `${selected.action === 'dispose' ? 'Remove the worktree for' : selected.action[0].toUpperCase() + selected.action.slice(1)} worker ${selected.taskId}.`;
    } catch { /* Keep bounded generic intent if native history has an older format. */ }
  }
  return presentUserMessage({ id: item.id, turnId, role: 'user', text: presentation });
}
