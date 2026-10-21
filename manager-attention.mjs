// Explicit manager intent only; conversational text and task failures are not signals.
export function validAttentionRequest(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => ['requestId', 'message'].includes(key))
    && typeof value.requestId === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(value.requestId)
    && typeof value.message === 'string' && Boolean(value.message.trim()) && value.message.length <= 2000;
}

export function managerAttention(item) {
  if (item?.type !== 'mcpToolCall' || item.server !== 'local_orchestration' || item.tool !== 'request_attention'
    || item.status !== 'completed' || item.error || item.result?.isError || !validAttentionRequest(item.arguments)) return null;
  let result = item.result?.structuredContent;
  if (!result) {
    try {
      const content = item.result?.content;
      if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text') return null;
      result = JSON.parse(content[0].text);
    } catch { return null; }
  }
  const attention = result?.attention;
  if (result?.ok !== true || !validAttentionRequest(attention)
    || attention.requestId !== item.arguments.requestId || attention.message !== item.arguments.message) return null;
  return { id: attention.requestId, message: attention.message };
}
