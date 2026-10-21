import type { MessageRecord } from "../contracts/manager.js";
export function orderedMessages(messages: MessageRecord[] = []) {
  // Canonical snapshots are already in native rollout order. Grouping by turn
  // would pull spoken interruptions away from their actual place in the chat.
  if (
    messages.some(
      (message) =>
        message.source === "voice" || Number.isFinite(message.position),
    )
  )
    return messages;
  const groups = new Map<string | undefined, MessageRecord[]>();
  for (const message of messages) {
    const key = message.turnId || message.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(message);
  }
  return [...groups.values()].flatMap((group) => [
    ...group.filter((item) => item.role === "user"),
    ...group.filter((item) => item.role !== "user"),
  ]);
}
