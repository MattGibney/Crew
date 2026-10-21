import { errorMessage } from "../../shared/errors.mjs";
import { journalSource, writeThreadReference } from "./thread-reference.mjs";
import type { Rpc, NativeThread } from "./protocol.mjs";
export type OpenNativeThread = (
  method: "thread/start" | "thread/resume" | "thread/fork",
  params: Record<string, unknown>,
) => Promise<{ thread: NativeThread }>;
/** Resume/fork recovery retains native history; it never launches a turn. */
export async function openManagerThread({
  threadId,
  recoveredJournalSource,
  statePath,
  options,
  rpc,
  open,
  flushJournal,
  notice,
}: {
  threadId?: string;
  recoveredJournalSource: string | null;
  statePath: string;
  options: Record<string, unknown>;
  rpc: Rpc;
  open: OpenNativeThread;
  flushJournal: () => Promise<void>;
  notice: (message: string) => void;
}) {
  let result,
    recoveredFromThreadId = recoveredJournalSource;
  if (threadId) {
    try {
      result = await open("thread/resume", {
        threadId,
        excludeTurns: true,
        ...options,
      });
    } catch (error) {
      if (!/already has an active writer/.test(errorMessage(error)))
        throw error;
      const previousThreadId = threadId;
      const source = await rpc("thread/read", {
        threadId,
        includeTurns: false,
      });
      const recent = await rpc("thread/turns/list", {
        threadId,
        limit: 1,
        itemsView: "notLoaded",
        sortDirection: "desc",
      });
      if (
        source.thread.status?.type === "active" ||
        recent.data.some((turn) => turn.status === "inProgress")
      )
        throw new Error(
          "ChatGPT is signed in, but the saved manager chat is active in another Codex client. Finish that work before reconnecting.",
        );
      result = await open("thread/fork", {
        threadId,
        ...options,
        excludeTurns: true,
        ephemeral: false,
        deferGoalContinuation: true,
      });
      await flushJournal();
      const journalSourceThreadId = await journalSource(
        statePath,
        previousThreadId,
        recoveredJournalSource,
      );
      await writeThreadReference(statePath, {
        threadId: result.thread.id,
        previousThreadId,
        journalSourceThreadId,
        recoveredAt: new Date().toISOString(),
        reason: "saved_chat_writer_conflict",
      });
      recoveredJournalSource = recoveredFromThreadId = journalSourceThreadId;
      await rpc("thread/name/set", {
        threadId: result.thread.id,
        name: "Crew work chat",
      });
      notice(
        "The saved manager chat was held by another Codex client. Continued from its preserved history; the original chat and worker state are retained.",
      );
    }
  } else {
    result = await open("thread/start", { ...options, ephemeral: false });
    await writeThreadReference(statePath, { threadId: result.thread.id });
    await rpc("thread/name/set", {
      threadId: result.thread.id,
      name: "Crew work chat",
    });
  }
  return {
    threadId: result.thread.id,
    recoveredFromThreadId,
    recoveredJournalSource,
  };
}
