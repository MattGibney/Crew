import type { RuntimeHistoryItem } from "../../../src/agents/contracts.mjs";
import type { VoiceTranscriptArtifact } from "../../../src/agents/voice-artifacts.mjs";
import type { LiveTranscriptItem } from "./voice/live-transcript";

export type ConversationRow =
  | { id: string; type: "native"; item: RuntimeHistoryItem; timestamp?: string }
  | {
      id: string;
      type: "voice";
      item: LiveTranscriptItem;
      timestamp?: string;
      artifact?: VoiceTranscriptArtifact;
    };

const time = (value: string | undefined) =>
  value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : undefined;
const voiceId = (threadId: string, callId: string, itemId: string) =>
  `voice:${JSON.stringify([threadId, callId, itemId])}`;

/** A display join only. No text matching, context writes or inferred native turns. */
export function conversationTimeline(
  native: RuntimeHistoryItem[],
  artifacts: VoiceTranscriptArtifact[],
  live: LiveTranscriptItem[],
  threadId: string | null,
): ConversationRow[] {
  const rows = new Map<string, ConversationRow>();
  for (const item of native) {
    if (item.sender.type === "system" || item.kind === "other") continue;
    rows.set(`native:${item.runtimeRef}`, {
      id: `native:${item.runtimeRef}`,
      type: "native",
      item,
      timestamp: item.timestamp,
    });
  }
  for (const artifact of artifacts) {
    if (artifact.threadId !== threadId) continue;
    for (const item of artifact.items) {
      if (!item.text) continue;
      const id = voiceId(artifact.threadId, artifact.callId, item.itemId);
      rows.set(id, {
        id,
        type: "voice",
        item: { ...item, callId: artifact.callId, threadId: artifact.threadId },
        timestamp: item.observedAt,
        artifact,
      });
    }
  }
  for (const item of live) {
    if (!item.text || !item.callId || item.threadId !== threadId) continue;
    const id = voiceId(item.threadId, item.callId, item.itemId);
    const saved = rows.get(id);
    // A complete retained snapshot wins over a late partial or an older live snapshot.
    if (saved?.type === "voice" && saved.item.done) continue;
    rows.set(id, {
      id,
      type: "voice",
      item,
      timestamp: saved?.timestamp ?? item.observedAt,
      ...(saved?.type === "voice" ? { artifact: saved.artifact } : {}),
    });
  }
  const result = [...rows.values()];
  // Undated native items keep their authoritative sequence beside the nearest
  // dated native neighbor. With no native times, their relationship to voice
  // cannot be reconstructed; the UI explicitly discloses that limitation.
  let preceding: number | undefined;
  const ordering = new Map<string, number>();
  for (let index = 0; index < result.length; index++) {
    const row = result[index]!;
    const timestamp = time(row.timestamp);
    if (timestamp !== undefined) {
      ordering.set(row.id, timestamp);
      if (row.type === "native") preceding = timestamp;
    } else {
      const following = result
        .slice(index + 1)
        .find(
          (next) =>
            next.type === "native" && time(next.timestamp) !== undefined,
        );
      ordering.set(
        row.id,
        preceding ?? time(following?.timestamp) ?? -Infinity,
      );
    }
  }
  // Stable sort retains native order and recorded call/item order for equal times.
  return result.sort((a, b) => {
    const left = ordering.get(a.id)!,
      right = ordering.get(b.id)!;
    return left === right ? 0 : left < right ? -1 : 1;
  });
}

/** Keep the last live snapshot through a delayed artifact refresh after hangup. */
export function reconcilePendingVoice(
  previous: LiveTranscriptItem[],
  live: LiveTranscriptItem[],
  artifacts: VoiceTranscriptArtifact[],
  threadId: string | null,
): LiveTranscriptItem[] {
  const key = (item: LiveTranscriptItem) =>
    voiceId(item.threadId ?? "", item.callId ?? "", item.itemId);
  const active = new Set(live.map(key));
  const pending = new Map<string, LiveTranscriptItem>(
    previous
      .filter((item) => item.threadId === threadId)
      .map((item) => [key(item), { ...item, ended: !active.has(key(item)) }]),
  );
  for (const item of live)
    if (item.threadId === threadId) pending.set(key(item), item);
  for (const artifact of artifacts) {
    if (artifact.threadId !== threadId) continue;
    for (const item of artifact.items) {
      const id = voiceId(artifact.threadId, artifact.callId, item.itemId);
      const cached = pending.get(id);
      if (
        !active.has(id) &&
        (item.done || (cached?.text === item.text && cached.done === item.done))
      )
        pending.delete(id);
    }
  }
  return [...pending.values()];
}
