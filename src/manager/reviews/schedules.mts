import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { errorCode, record } from "../../shared/errors.mjs";
export type ScheduleTiming =
  | { kind: "interval"; minutes: number }
  | { kind: "daily"; time: string; timeZone: string };
export interface ManagerSchedule {
  id: string;
  name: string;
  instruction: string;
  enabled: boolean;
  timing: ScheduleTiming;
  builtin?: boolean;
}
export interface ScheduleRun {
  nextAt: number;
  lastAt?: number;
  status?: string;
  error?: string;
}
export const defaultReviewInstruction =
  "Review saved explicit commitments and correlated worker updates. Follow up on work already authorized, maintain the manager scratchpad, and raise meaningful questions or findings through Crew attention. Do not invent tasks from brainstorming or old conversations. Do not narrate this background review in the conversation.";
const defaultSchedules = (): ManagerSchedule[] => [
  {
    id: "commitment-review",
    name: "Review commitments",
    instruction: defaultReviewInstruction,
    enabled: true,
    builtin: true,
    timing: { kind: "interval", minutes: 10 },
  },
];
export function validateSchedules(input: unknown): ManagerSchedule[] {
  if (!Array.isArray(input) || input.length > 30)
    throw new Error("Use at most 30 manager schedules.");
  const ids = new Set<string>();
  return input.map((value) => {
    if (
      !record(value) ||
      typeof value.id !== "string" ||
      !/^[\w-]{1,100}$/.test(value.id) ||
      ids.has(value.id)
    )
      throw new Error("Each schedule needs a unique identifier.");
    ids.add(value.id);
    if (
      typeof value.name !== "string" ||
      !value.name.trim() ||
      value.name.length > 80
    )
      throw new Error("Schedule names must contain 1–80 characters.");
    if (
      typeof value.instruction !== "string" ||
      !value.instruction.trim() ||
      value.instruction.length > 16000
    )
      throw new Error("Schedule instructions must contain 1–16000 characters.");
    if (typeof value.enabled !== "boolean" || !record(value.timing))
      throw new Error("Invalid schedule settings.");
    let timing: ScheduleTiming;
    if (
      value.timing.kind === "interval" &&
      Number.isInteger(value.timing.minutes) &&
      Number(value.timing.minutes) >= 1 &&
      Number(value.timing.minutes) <= 10080
    )
      timing = { kind: "interval", minutes: Number(value.timing.minutes) };
    else if (
      value.timing.kind === "daily" &&
      typeof value.timing.time === "string" &&
      /^([01]\d|2[0-3]):[0-5]\d$/.test(value.timing.time) &&
      typeof value.timing.timeZone === "string"
    ) {
      try {
        new Intl.DateTimeFormat("en", {
          timeZone: value.timing.timeZone,
        }).format();
      } catch {
        throw new Error("Choose a valid daily schedule time zone.");
      }
      timing = {
        kind: "daily",
        time: value.timing.time,
        timeZone: value.timing.timeZone,
      };
    } else
      throw new Error(
        "Choose an interval of 1–10080 minutes or a daily time and time zone.",
      );
    return {
      id: value.id,
      name: value.name.trim(),
      instruction: value.instruction.trim(),
      enabled: value.enabled,
      timing,
      ...(value.id === "commitment-review" ? { builtin: true } : {}),
    };
  });
}
/** Daily wall-clock time is explicit, including across DST. Missed slots never
 * generate a backlog. The next slot is computed from the current clock. */
export function nextScheduleAt(timing: ScheduleTiming, after: number): number {
  if (timing.kind === "interval") return after + timing.minutes * 60000;
  const format = new Intl.DateTimeFormat("en-GB", {
    timeZone: timing.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: timing.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const currentDay = date.format(after);
  // Require a later local date if today's scheduled minute already occurred;
  // this prevents a repeated fall-back clock minute from running twice.
  const todayPassed = format.format(after) >= timing.time;
  for (
    let at = Math.floor(after / 60000) * 60000 + 60000;
    at <= after + 49 * 3600000;
    at += 60000
  )
    if (
      format.format(at) === timing.time &&
      (!todayPassed || date.format(at) !== currentDay)
    )
      return at;
  throw new Error("The next daily schedule time could not be resolved.");
}
export function createManagerSchedules(stateDir: string, now = Date.now) {
  const file = join(stateDir, "manager-schedules.json"),
    receiptFile = join(stateDir, "manager-schedule-runs.json");
  let revision = "initial",
    schedules = defaultSchedules(),
    runs: Record<string, ScheduleRun> = {},
    pending: Promise<unknown> = Promise.resolve();
  const ready = (async () => {
    try {
      const saved: unknown = JSON.parse(await readFile(file, "utf8"));
      if (!record(saved) || typeof saved.revision !== "string")
        throw new Error("Invalid manager schedules; file retained.");
      schedules = validateSchedules(saved.schedules);
      revision = saved.revision;
    } catch (e) {
      if (errorCode(e) !== "ENOENT") throw e;
    }
    try {
      const saved: unknown = JSON.parse(await readFile(receiptFile, "utf8"));
      if (!record(saved))
        throw new Error("Invalid manager schedule receipts; file retained.");
      for (const [id, run] of Object.entries(saved)) {
        if (
          !record(run) ||
          typeof run.nextAt !== "number" ||
          !Number.isFinite(run.nextAt)
        )
          throw new Error("Invalid schedule receipt; file retained.");
        runs[id] = run as unknown as ScheduleRun;
      }
    } catch (e) {
      if (errorCode(e) !== "ENOENT") throw e;
    }
    for (const schedule of schedules)
      runs[schedule.id] ??= { nextAt: nextScheduleAt(schedule.timing, now()) };
  })();
  void ready.catch(() => {});
  async function write(target: string, value: unknown) {
    await mkdir(stateDir, { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(value) + "\n", { mode: 0o600 });
    await rename(temp, target);
  }
  function serialize<T>(fn: () => Promise<T>) {
    const result = pending.then(fn);
    pending = result.catch(() => {});
    return result;
  }
  const view = async () => {
    await ready;
    return {
      revision,
      schedules: schedules.map((schedule) => ({
        ...structuredClone(schedule),
        run: structuredClone(runs[schedule.id]),
      })),
    };
  };
  return {
    ready,
    view,
    current: (schedule: ManagerSchedule) => {
      const current = schedules.find((item) => item.id === schedule.id);
      return Boolean(
        current?.enabled &&
        current.instruction === schedule.instruction &&
        JSON.stringify(current.timing) === JSON.stringify(schedule.timing),
      );
    },
    save: (input: unknown) =>
      serialize(async () => {
        await ready;
        if (!record(input) || input.expectedRevision !== revision)
          throw new Error("Schedules changed. Reload Settings before saving.");
        const selected = validateSchedules(input.schedules),
          nextRevision = randomUUID();
        await write(file, { revision: nextRevision, schedules: selected });
        for (const schedule of selected) {
          const previous = schedules.find((s) => s.id === schedule.id);
          if (
            !previous ||
            JSON.stringify(previous.timing) !==
              JSON.stringify(schedule.timing) ||
            previous.enabled !== schedule.enabled
          )
            runs[schedule.id] = {
              ...runs[schedule.id],
              nextAt: nextScheduleAt(schedule.timing, now()),
            };
        }
        schedules = selected;
        revision = nextRevision;
        await write(receiptFile, runs);
        return view();
      }),
    checkpoint: (id: string, run: ScheduleRun, expectedRevision?: string) =>
      serialize(async () => {
        await ready;
        if (expectedRevision && expectedRevision !== revision) return false;
        if (!schedules.some((schedule) => schedule.id === id)) return false;
        runs[id] = run;
        await write(receiptFile, runs);
        return true;
      }),
  };
}
