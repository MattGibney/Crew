import { randomUUID } from "node:crypto";
import { writeFile, rename } from "node:fs/promises";
import type { TimelineMessage } from "../shared/conversation.mjs";
export function createTimelineJournal({
  statePath,
  snapshot,
  onFailure,
}: {
  statePath: string;
  snapshot: () => {
    threadId?: string;
    loadingHistory: boolean;
    journalThreadId: string | null;
    messages: TimelineMessage[];
  };
  onFailure: (error: unknown) => void;
}) {
  let journalWrites = Promise.resolve(),
    queuedJournal: string | null = null,
    writingJournal = false;
  function persistTimeline() {
    const { threadId, loadingHistory, journalThreadId, messages } = snapshot();
    if (!threadId || loadingHistory || journalThreadId !== threadId) return;
    queuedJournal = JSON.stringify({ threadId, messages: messages }) + "\n";
    if (writingJournal) return;
    writingJournal = true;
    journalWrites = (async () => {
      try {
        while (queuedJournal !== null) {
          const data = queuedJournal;
          queuedJournal = null;
          const temporary = `${statePath}.conversation-${randomUUID()}.tmp`;
          await writeFile(temporary, data, { mode: 0o600 });
          await rename(temporary, `${statePath}.conversation.json`);
        }
      } catch (error) {
        onFailure(error);
      } finally {
        writingJournal = false;
      }
    })();
  }
  return { persist: persistTimeline, flush: () => journalWrites };
}
