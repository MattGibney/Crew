export interface ActiveQuitTurn {
  projectId: string;
  projectName: string;
  agentId: string;
  agentName: string;
}
export interface SimpleQuitSnapshot {
  state: "idle" | "confirmation" | "quitting";
  activeTurns: ActiveQuitTurn[];
}

/** Ordinary owner Quit never requires agent readiness or model work. */
export function createSimpleQuit(options: {
  activeTurns(): ActiveQuitTurn[];
  seal(): void;
  shutdown(): Promise<void>;
  finish(): Promise<void>;
  changed(): void;
  timeoutMs?: number;
}) {
  let state: SimpleQuitSnapshot = { state: "idle", activeTurns: [] };
  let running: Promise<void> | null = null;
  async function request(confirmed = false): Promise<void> {
    if (running) return running;
    const activeTurns = options.activeTurns();
    if (activeTurns.length && !confirmed) {
      state = { state: "confirmation", activeTurns };
      options.changed();
      return;
    }
    state = { state: "quitting", activeTurns };
    options.seal();
    options.changed();
    running = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Cleanup is best effort and bounded. Unconfirmed execution stays in its
        // durable journals for recovery; owner Quit is never a readiness gate.
        await Promise.race([
          options.shutdown().catch(() => {}),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, options.timeoutMs ?? 2500);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      await options.finish();
    })();
    try {
      await running;
    } catch (error) {
      running = null;
      state = { state: "idle", activeTurns: [] };
      options.changed();
      throw error;
    }
  }
  return {
    snapshot: () => structuredClone(state),
    holding: () => state.state === "quitting",
    observe() {},
    request,
    cancel() {
      if (!running) {
        state = { state: "idle", activeTurns: [] };
        options.changed();
      }
    },
  };
}
