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

// A delegated native exchange is backing work, not another utterance. Keep all
// its content inspectable, without guessing which spoken response summarizes it.
// Only adjacent records are grouped so interruptions retain their native order.
export function conversationRows(messages: MessageRecord[] = []) {
  const rows: ConversationRow[] = [];
  for (const message of orderedMessages(messages)) {
    if (
      message.origin !== "realtime-delegation" ||
      !message.turnId ||
      message.source === "voice"
    ) {
      rows.push(message);
      continue;
    }
    const previous = rows.at(-1);
    if (previous?.kind === "work-details" && previous.turnId === message.turnId)
      previous.messages.push(message);
    else
      rows.push({
        id: message.id,
        turnId: message.turnId,
        kind: "work-details",
        messages: [message],
      });
  }
  return rows;
}

export interface WorkDetailsRow {
  id?: string;
  turnId: string;
  kind: "work-details";
  messages: MessageRecord[];
}
export type ConversationRow = MessageRecord | WorkDetailsRow;
