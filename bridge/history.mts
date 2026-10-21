import { readFile } from "node:fs/promises";
import {
  errorCode,
  errorMessage,
  record as isRecord,
} from "../shared/errors.mjs";
import {
  createConversationTimeline,
  parseSavedMessages,
} from "../conversation-timeline.mjs";
import type {
  NativeItem,
  TimelineOptions,
  ConversationMessage,
} from "../shared/conversation.mjs";
import { rpcErrorCode } from "./protocol.mjs";
import type { Rpc, TimelineEntry } from "./protocol.mjs";
export interface HistoryProjection {
  activeTurnId: string | null;
  status: string;
  canonicalTimeline: boolean;
}
type HistoryOptions = {
  rpc: Rpc;
  statePath: string;
  threadId: string;
  recoveredFromThreadId: string | null;
  timeline: ReturnType<typeof createConversationTimeline>;
  record: (
    item: NativeItem,
    turnId: string | null,
    options?: TimelineOptions,
  ) => void;
  markCompleted: (id: string) => void;
  emit: (type: string, data: Record<string, unknown>) => void;
  projection: HistoryProjection;
};
/** Hydrate canonical history with the bounded legacy overlay; never starts native work. */
export async function hydrateHistory({
  rpc,
  statePath,
  threadId,
  recoveredFromThreadId,
  timeline,
  record,
  markCompleted,
  emit,
  projection,
}: HistoryOptions) {
  let savedMessages: ConversationMessage[] = [],
    historyTruncated = false;
  try {
    const saved: unknown = JSON.parse(
      await readFile(`${statePath}.conversation.json`, "utf8"),
    );
    if (
      isRecord(saved) &&
      (saved.threadId === threadId ||
        (recoveredFromThreadId && saved.threadId === recoveredFromThreadId)) &&
      Array.isArray(saved.messages)
    )
      savedMessages = parseSavedMessages(saved.messages);
  } catch (error) {
    if (errorCode(error) !== "ENOENT")
      emit("notice", {
        message:
          "Saved conversation overlay could not be restored; its file has been retained.",
      });
  }
  try {
    let cursor: string | null | undefined,
      pages = 0;
    const entries: TimelineEntry[] = [];
    do {
      const page = await rpc("thread/timeline/list", {
        threadId,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      if (!Array.isArray(page.data))
        throw new Error("Invalid canonical conversation history response.");
      projection.canonicalTimeline = true;
      entries.push(...page.data);
      if (page.nextCursor && page.nextCursor === cursor)
        throw new Error(
          "Canonical conversation history cursor did not advance.",
        );
      cursor = page.nextCursor;
      if (++pages >= 20 && cursor) {
        historyTruncated = true;
        emit("notice", {
          message:
            "Only a bounded window of this long conversation could be loaded.",
        });
        break;
      }
    } while (cursor);
    for (const entry of entries.sort((a, b) => a.position - b.position)) {
      if (entry.type === "item")
        record(entry.item, entry.turnId, { position: entry.position });
      else if (entry.type === "realtime")
        timeline.realtime(entry.item, { position: entry.position });
      else if (entry.type === "turnStarted") {
        projection.activeTurnId = entry.turnId;
        projection.status = "working";
      } else if (entry.type === "turnCompleted") {
        markCompleted(entry.turnId);
        if (projection.activeTurnId === entry.turnId) {
          projection.activeTurnId = null;
          projection.status = entry.status;
        }
      }
    }
    if (projection.activeTurnId)
      timeline.resumeTurn(projection.activeTurnId, savedMessages);
    const canonicalIds = new Set(
      timeline.snapshot().map((message) => message.id),
    );
    const missingPartials = savedMessages.filter(
      (message) =>
        (historyTruncated ||
          ["streaming", "partial"].includes(message.status || "")) &&
        !canonicalIds.has(message.id),
    );
    const current = new Map(
      timeline.snapshot().map((message) => [message.id, message]),
    );
    const lastPosition = Math.max(
      -1,
      ...[...current.values()].map((message) => message.position),
    );
    timeline.restore(
      missingPartials.map((message, index) => {
        const savedIndex = savedMessages.indexOf(message);
        const before = savedMessages
          .slice(0, savedIndex)
          .reverse()
          .find((entry) => current.has(entry.id));
        const after = savedMessages
          .slice(savedIndex + 1)
          .find((entry) => current.has(entry.id));
        const left = before ? current.get(before.id)!.position : null;
        const right = after ? current.get(after.id)!.position : null;
        const fraction = (index + 1) / (missingPartials.length + 1);
        const position =
          right !== null
            ? left !== null
              ? left + (right - left) * fraction
              : right - 1 + fraction
            : left !== null
              ? left + fraction
              : lastPosition + index + 1;
        return {
          ...message,
          status: message.status === "streaming" ? "partial" : message.status,
          position,
        };
      }),
    );
  } catch (error) {
    if (
      rpcErrorCode(error) !== -32601 &&
      errorMessage(error).trim() !== "thread/timeline/list is not supported yet"
    )
      throw error;
    projection.canonicalTimeline = false;
    timeline.restore(savedMessages);
  }
  // The bounded timeline is presentation history, never an activity oracle.
  // Recent native turns remain authoritative for current work and tool evidence.
  let history;
  try {
    history = await rpc("thread/turns/list", {
      threadId,
      limit: 10,
      itemsView: "full",
      sortDirection: "desc",
    });
  } catch (error) {
    const emptyNativeThread =
      rpcErrorCode(error) === -32600 &&
      errorMessage(error) ===
        `thread ${threadId} is not materialized yet; thread/turns/list is unavailable before first user message`;
    if (!emptyNativeThread) throw error;
    history = { data: [] };
  }
  if (history.data.length) {
    projection.activeTurnId = null;
    projection.status = history.data[0].status;
  }
  for (const turn of [...history.data].reverse()) {
    for (const item of turn.items || []) record(item, turn.id);
    if (turn.status === "inProgress") {
      projection.activeTurnId = turn.id;
      projection.status = "working";
      timeline.resumeTurn(turn.id, savedMessages);
    } else markCompleted(turn.id);
  }
  timeline.restoreProvenance(savedMessages);
}
