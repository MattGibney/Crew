import { record } from "../shared/errors.mjs";
// Explicit manager intent only; conversational text and task failures are not signals.
export function validAttentionRequest(
  value: unknown,
): value is { requestId: string; message: string } {
  return (
    record(value) &&
    Object.keys(value).every((key) => ["requestId", "message"].includes(key)) &&
    typeof value.requestId === "string" &&
    /^[a-zA-Z0-9_-]{8,80}$/.test(value.requestId) &&
    typeof value.message === "string" &&
    Boolean(value.message.trim()) &&
    value.message.length <= 2000
  );
}

export function managerAttention(input: unknown) {
  if (!record(input)) return null;
  const item = input;
  const itemResult = record(item.result) ? item.result : {};
  if (
    item?.type !== "mcpToolCall" ||
    item.server !== "local_orchestration" ||
    item.tool !== "request_attention" ||
    item.status !== "completed" ||
    item.error ||
    itemResult.isError ||
    !validAttentionRequest(item.arguments)
  )
    return null;
  let result = itemResult.structuredContent;
  if (!result) {
    try {
      const content = itemResult.content;
      if (
        !Array.isArray(content) ||
        content.length !== 1 ||
        !record(content[0]) ||
        content[0].type !== "text" ||
        typeof content[0].text !== "string"
      )
        return null;
      result = JSON.parse(content[0].text);
    } catch {
      return null;
    }
  }
  if (!record(result)) return null;
  const attention = result.attention;
  if (
    result.ok !== true ||
    !validAttentionRequest(attention) ||
    attention.requestId !== item.arguments.requestId ||
    attention.message !== item.arguments.message
  )
    return null;
  return { id: attention.requestId, message: attention.message };
}
