import { safeError } from "../bridge/redaction.mjs";
import { nextScheduleAt } from "./schedules.mjs";
import type { ManagerSchedule, createManagerSchedules } from "./schedules.mjs";
export function createScheduleRunner({
  store,
  eligible,
  run,
  now = Date.now,
  onError = () => {},
}: {
  store: ReturnType<typeof createManagerSchedules>;
  eligible: () => Promise<boolean>;
  run: (schedule: ManagerSchedule) => Promise<unknown>;
  now?: () => number;
  onError?: (error: unknown) => void;
}) {
  let busy = false,
    stopped = false,
    timer: ReturnType<typeof setInterval> | undefined;
  async function tick() {
    if (stopped || busy) return;
    busy = true;
    try {
      const snapshot = await store.view();
      for (const schedule of [...snapshot.schedules].sort(
        (a, b) =>
          a.run.nextAt - b.run.nextAt ||
          (a.run.lastAt ?? 0) - (b.run.lastAt ?? 0),
      )) {
        if (stopped) return;
        if (!schedule.enabled || schedule.run.nextAt > now()) continue;
        const at = now(),
          nextAt = nextScheduleAt(schedule.timing, at);
        // Reserve before dispatch. Unknown delivery is not replayed on restart.
        if (
          !(await store.checkpoint(
            schedule.id,
            { ...schedule.run, nextAt, status: "waiting" },
            snapshot.revision,
          ))
        )
          continue;
        if (stopped || !(await eligible())) {
          await store.checkpoint(
            schedule.id,
            { ...schedule.run, nextAt, status: "deferred" },
            snapshot.revision,
          );
          continue;
        }
        try {
          await store.checkpoint(
            schedule.id,
            { nextAt, lastAt: at, status: "running" },
            snapshot.revision,
          );
          if (stopped || !(await eligible())) {
            await store.checkpoint(
              schedule.id,
              { nextAt, status: "deferred" },
              snapshot.revision,
            );
            continue;
          }
          if ((await store.view()).revision !== snapshot.revision) continue;
          const result = await run(schedule);
          const rejected =
            result === false ||
            (typeof result === "object" &&
              result !== null &&
              "accepted" in result &&
              result.accepted === false);
          await store.checkpoint(
            schedule.id,
            {
              nextAt,
              lastAt: at,
              status: rejected
                ? "deferred"
                : typeof result === "object" &&
                    result !== null &&
                    "reviewed" in result &&
                    result.reviewed === false
                  ? "no changes"
                  : "submitted",
            },
            snapshot.revision,
          );
        } catch (error) {
          await store.checkpoint(
            schedule.id,
            { nextAt, lastAt: at, status: "error", error: safeError(error) },
            snapshot.revision,
          );
        }
        // One scheduled task per tick; normal native admission prevents overlap.
        break;
      }
    } finally {
      busy = false;
    }
  }
  return {
    tick,
    start() {
      stopped = false;
      timer ??= setInterval(() => void tick().catch(onError), 1000);
      timer.unref?.();
      return this;
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
