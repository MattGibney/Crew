import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { RuntimeHistoryItem } from "../../../src/agents/contracts.mjs";
import type { AgentsClient } from "./client";

interface HistoryState {
  items: RuntimeHistoryItem[];
  cursor: string | null;
  loading: boolean;
  loaded: boolean;
  error: string;
}

const PAGE_BATCH = 10;

/** Disposable view of authorized native history; never persisted as a transcript. */
export class ConversationHistory {
  private state: HistoryState = {
    items: [],
    cursor: null,
    loading: false,
    loaded: false,
    error: "",
  };
  private listeners = new Set<() => void>();
  private generation = 0;
  private depth = 0;
  private refreshQueued = false;

  constructor(
    private client: Pick<AgentsClient, "readHistory">,
    private agentId: string,
  ) {}

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(state: HistoryState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  cancel = () => {
    this.generation++;
    this.refreshQueued = false;
    if (this.state.loading) this.publish({ ...this.state, loading: false });
  };

  refresh = async () => {
    if (this.state.loading) {
      this.refreshQueued = true;
      return;
    }
    await this.read("refresh");
  };
  loadEarlier = async () => {
    if (!this.state.loading && this.state.cursor) await this.read("earlier");
  };
  showLatest = async () => {
    if (!this.state.loading) await this.read("latest");
  };

  private async read(mode: "refresh" | "earlier" | "latest") {
    const request = ++this.generation;
    const previous = this.state;
    // Re-read the displayed window rather than permanently merging stale rows.
    // A new native page can shift the old boundary, so page count alone is insufficient.
    const anchor =
      mode === "refresh" ? previous.items[0]?.runtimeRef : undefined;
    let cursor = mode === "earlier" ? previous.cursor : null;
    // Even an entirely filtered window has consumed pages. Refresh must not
    // send its older cursor back to the first batch before public items appear.
    const limit = mode === "refresh" ? this.depth + PAGE_BATCH : PAGE_BATCH;
    const seen = new Set<string>();
    let items: RuntimeHistoryItem[] = [];
    let pages = 0;
    this.publish({ ...previous, loading: true, error: "" });
    try {
      do {
        if (cursor) seen.add(cursor);
        const result = await this.client.readHistory(
          this.agentId,
          cursor ?? undefined,
        );
        if (request !== this.generation) return;
        if (result.state === "failed") throw new Error(result.error.message);
        cursor = result.value.nextCursor;
        if (cursor && seen.has(cursor))
          throw new Error(
            "Saved history returned a repeated page. Retry history.",
          );
        items = uniqueHistory([
          ...result.value.items.filter(
            (item) => item.kind !== "other" && item.sender.type !== "system",
          ),
          ...items,
        ]);
        pages++;
        if (
          !cursor ||
          (items.length &&
            (!anchor || items.some((item) => item.runtimeRef === anchor)))
        )
          break;
      } while (pages < limit);
      if (
        anchor &&
        cursor &&
        !items.some((item) => item.runtimeRef === anchor)
      ) {
        throw new Error(
          "The displayed history could not be fully refreshed. Retry, or show latest history to reload a smaller window.",
        );
      }
      this.depth = mode === "earlier" ? this.depth + pages : pages;
      this.publish({
        items:
          mode === "earlier"
            ? uniqueHistory([...items, ...previous.items])
            : items,
        cursor,
        loading: false,
        loaded: true,
        error: "",
      });
    } catch (cause) {
      if (request !== this.generation) return;
      this.publish({
        ...previous,
        loading: false,
        loaded: true,
        error:
          cause instanceof Error
            ? cause.message
            : "Saved history is currently unavailable.",
      });
    } finally {
      if (request === this.generation && this.refreshQueued) {
        this.refreshQueued = false;
        // Coalesce streaming events without repeatedly cancelling a slow page read.
        void this.refresh();
      }
    }
  }
}

export function useConversationHistory({
  client,
  agentId,
  threadId,
  sessionId,
  visible,
  version,
}: {
  client: AgentsClient;
  agentId: string;
  threadId: string | null;
  sessionId: string | null;
  visible: boolean;
  version: number;
}) {
  const history = useMemo(
    () => new ConversationHistory(client, agentId),
    [client, agentId, threadId],
  );
  const priorSession = useRef(sessionId);
  const state = useSyncExternalStore(history.subscribe, history.snapshot);
  useEffect(() => () => history.cancel(), [history]);
  useEffect(() => {
    if (priorSession.current !== sessionId) {
      history.cancel();
      priorSession.current = sessionId;
    }
    if (visible && threadId) void history.refresh();
    else history.cancel();
  }, [history, visible, threadId, sessionId, version]);
  return {
    ...state,
    refresh: history.refresh,
    loadEarlier: history.loadEarlier,
    showLatest: history.showLatest,
  };
}

function uniqueHistory(items: RuntimeHistoryItem[]) {
  return [...new Map(items.map((item) => [item.runtimeRef, item])).values()];
}
