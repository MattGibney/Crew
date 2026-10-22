import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { errorCode, record } from "../../shared/errors.mjs";
import type { ConversationMessage } from "../conversation/contracts.mjs";

export interface ApplicationOrigin {
  source: "scheduled-review" | "preparation";
  operationId: string;
}
interface InternalTurn {
  origin: ApplicationOrigin;
  visibleItems: string[];
}
interface OriginJournal {
  version: 1;
  turns: Record<string, InternalTurn>;
  hiddenItems: string[];
  inputs?: Record<string, ApplicationOrigin>;
  promotedTurns?: string[];
  pending?: {
    origin: ApplicationOrigin;
    requestId: string;
    baseline: string[];
  };
}
/** Application provenance is private audit metadata, never inferred from text.
 * Retain it independently of the bounded conversation overlay so canonical
 * native history cannot bring internal messages back after reconnect/reload. */
export function createApplicationOrigins(statePath: string) {
  const file = `${statePath}.origins.json`;
  let data: OriginJournal = { version: 1, turns: {}, hiddenItems: [] };
  let writes: Promise<void> = Promise.resolve();
  let dispatching = false;
  const ready = (async () => {
    try {
      const saved: unknown = JSON.parse(await readFile(file, "utf8"));
      if (
        !record(saved) ||
        saved.version !== 1 ||
        !record(saved.turns) ||
        !Array.isArray(saved.hiddenItems)
      )
        throw new Error(
          "Invalid manager activity provenance; retained for recovery.",
        );
      if (
        saved.hiddenItems.some((id) => typeof id !== "string") ||
        Object.values(saved.turns).some(
          (turn) =>
            !record(turn) ||
            !record(turn.origin) ||
            !["scheduled-review", "preparation"].includes(
              String(turn.origin.source),
            ) ||
            typeof turn.origin.operationId !== "string" ||
            !Array.isArray(turn.visibleItems) ||
            turn.visibleItems.some((id) => typeof id !== "string"),
        )
      )
        throw new Error(
          "Invalid manager activity provenance; retained for recovery.",
        );
      data = saved as unknown as OriginJournal;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  })();
  void ready.catch(() => {});
  function save() {
    const snapshot = JSON.stringify(data) + "\n";
    const next = writes.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const temp = `${file}.${randomUUID()}.tmp`;
      await writeFile(temp, snapshot, { mode: 0o600 });
      await rename(temp, file);
    });
    writes = next;
    // Dispatch awaits this chain; event-driven callers leave the rejection for
    // the next admission instead of creating an unhandled rejection.
    void next.catch(() => {});
    return next;
  }
  function observeTurn(turnId: string) {
    if (
      dispatching &&
      data.pending &&
      !data.pending.baseline.includes(turnId) &&
      !data.turns[turnId]
    ) {
      data.turns[turnId] = { origin: data.pending.origin, visibleItems: [] };
      void save();
    }
  }
  function hidden(message: ConversationMessage) {
    if (message.source === "voice") return false;
    const inputOrigin = data.inputs?.[message.id];
    if (
      message.role === "user" &&
      inputOrigin &&
      message.turnId &&
      !data.turns[message.turnId] &&
      !data.promotedTurns?.includes(message.turnId)
    ) {
      data.turns[message.turnId] = { origin: inputOrigin, visibleItems: [] };
      void save();
    }
    if (inputOrigin) return true;
    if (data.hiddenItems.includes(message.id)) return true;
    if (!message.turnId) return false;
    observeTurn(message.turnId);
    const turn = data.turns[message.turnId];
    return Boolean(turn && !turn.visibleItems.includes(message.id));
  }
  function observed(message: ConversationMessage) {
    if (hidden(message) && !data.hiddenItems.includes(message.id)) {
      data.hiddenItems.push(message.id);
      void save();
    }
  }
  async function begin(
    requestId: string,
    origin: ApplicationOrigin | undefined,
    activeTurnId: string | null,
    messages: ConversationMessage[],
  ) {
    await ready;
    if (!origin) {
      dispatching = false;
      delete data.pending;
    }
    if (origin) {
      if (
        !origin.operationId ||
        !["scheduled-review", "preparation"].includes(origin.source)
      )
        throw new Error("Invalid application activity origin.");
      (data.inputs ??= {})[requestId] = origin;
      dispatching = true;
      data.pending = {
        requestId,
        origin,
        baseline: [
          ...new Set(messages.flatMap((m) => (m.turnId ? [m.turnId] : []))),
        ],
      };
      if (activeTurnId)
        data.turns[activeTurnId] = {
          origin,
          visibleItems: messages
            .filter((m) => m.turnId === activeTurnId && !hidden(m))
            .map((m) => m.id),
        };
    } else if (activeTurnId && data.turns[activeTurnId]) {
      // Explicit human steering keeps the prior background items private and
      // restores normal conversation presentation for subsequent responses.
      messages.forEach(observed);
      (data.promotedTurns ??= []).push(activeTurnId);
      delete data.turns[activeTurnId];
    }
    await save();
  }
  async function acknowledged(turnId?: string) {
    if (turnId && data.pending && !data.turns[turnId])
      data.turns[turnId] = { origin: data.pending.origin, visibleItems: [] };
    dispatching = false;
    delete data.pending;
    await save();
  }
  async function failed() {
    dispatching = false;
    await save();
  }
  return {
    ready,
    hidden,
    observed,
    observeTurn,
    begin,
    acknowledged,
    failed,
    flush: () => writes,
  };
}
