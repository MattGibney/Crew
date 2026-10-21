import type { ActivityResult } from "./shared/update.mjs";
interface Reservation {
  reserved: boolean;
  reasons?: string[];
}
// Atomic admission prevents async requests crossing an install/drain barrier.
export function createUpdateAdmission() {
  let reserved = false,
    held = false,
    inFlight = 0,
    checking: Promise<Reservation> | null = null,
    generation = 0;
  return {
    get reserved() {
      return reserved;
    },
    hold() {
      held = true;
      reserved = true;
    },
    async run<T>(work: () => Promise<T>) {
      if (reserved)
        throw new Error(
          "Crew is preparing an update. Wait before starting work.",
        );
      inFlight++;
      try {
        return await work();
      } finally {
        inFlight--;
      }
    },
    async reserve(activity: () => Promise<ActivityResult>) {
      if (checking) return checking;
      if (inFlight)
        return {
          reserved: false,
          reasons: [
            "Wait for pending conversation or connection requests to finish.",
          ],
        };
      reserved = true;
      const attempt = ++generation;
      checking = (async () => {
        try {
          const result = await activity();
          if (attempt !== generation)
            return {
              reserved: false,
              reasons: ["Update preparation was canceled."],
            };
          if (result?.safe !== true) {
            reserved = held;
            return {
              reserved: false,
              reasons: result?.reasons || ["Activity could not be verified."],
            };
          }
          return { reserved: true };
        } catch (error) {
          if (attempt === generation) reserved = held;
          throw error;
        } finally {
          checking = null;
        }
      })();
      return checking;
    },
    cancel() {
      generation++;
      reserved = held;
    },
    releaseHold() {
      generation++;
      held = false;
      reserved = false;
    },
  };
}
