import { ManagerScratchpad } from "./scratchpad.mjs";
import { safeError } from "./bridge/redaction.mjs";
/** Cache is presentation only; failed refreshes retain the last good data. */
export async function createScratchpadFeed(
  stateDir: string,
  changed: () => void,
) {
  const scratchpad = new ManagerScratchpad({ stateDir });
  let snapshot = await scratchpad.snapshot(),
    error: string | null = null,
    polling = false;
  async function refresh() {
    if (polling) return;
    polling = true;
    try {
      const saved = await scratchpad.snapshot();
      const recovered = error !== null;
      error = null;
      if (saved.revision > snapshot.revision || recovered) {
        snapshot = saved;
        changed();
      }
    } catch (failure) {
      const message = safeError(failure);
      if (message !== error) {
        error = message;
        changed();
      }
    } finally {
      polling = false;
    }
  }
  const enrich = <T extends object>(state: T) => ({
    ...state,
    managerScratchpad: snapshot,
    managerScratchpadError: error,
  });
  return { scratchpad, refresh, enrich };
}
