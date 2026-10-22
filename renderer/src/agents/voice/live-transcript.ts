import type { PrimaryVoiceEvent } from "./client";

export interface LiveTranscriptItem {
  itemId: string;
  role: "user" | "assistant";
  text: string;
  done: boolean;
}
const MAX_ITEMS = 32;
const MAX_ITEM_CHARS = 16_000;
const MAX_TOTAL_CHARS = 64_000;

/** Ephemeral presentation only. Native IDs never become coding-turn references. */
export function updateLiveTranscript(
  items: LiveTranscriptItem[],
  event: Extract<PrimaryVoiceEvent, { kind: "transcript" }>,
): LiveTranscriptItem[] {
  const prior = items.find((item) => item.itemId === event.itemId);
  if (
    prior &&
    (prior.role !== event.role ||
      (prior.done && !event.done) ||
      (!event.delta && !event.done))
  )
    return items;
  const text = (
    event.delta ? (prior?.text ?? "") + event.text : event.text
  ).slice(0, MAX_ITEM_CHARS);
  const next = {
    itemId: event.itemId,
    role: event.role,
    text,
    done: event.done,
  };
  const result = (
    prior
      ? items.map((item) => (item === prior ? next : item))
      : [...items, next]
  ).slice(-MAX_ITEMS);
  let total = result.reduce((count, item) => count + item.text.length, 0);
  while (result.length > 1 && total > MAX_TOTAL_CHARS)
    total -= result.shift()!.text.length;
  return result;
}
