import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Agent } from "../agents/contracts.mjs";
import {
  createManagerSchedules,
  type ManagerSchedule,
} from "../manager/reviews/schedules.mjs";
import { createScheduleRunner } from "../manager/reviews/schedule-runner.mjs";

export interface PrivateScheduledDelivery {
  projectId: string;
  agentId: string;
  id: string;
  origin: { type: "schedule"; scheduleId: string; scheduledAt: string };
  instruction: string;
  visibility: "internal";
  /** Never steer internal input into a human turn or merge a later human steer
   * into this private turn. The foundation queues across the visibility boundary. */
  deliveryMode: "queue";
}
export interface AgentSchedulesOptions {
  /** Dedicated Crew-owned project directory, never a source or personal Codex directory. */
  directory: string;
  projectId: string;
  getAgent(agentId: string): Agent | null | Promise<Agent | null>;
  /** Rechecks shared admission, native approvals and active voice. Must not start an agent. */
  canRun(agentId: string): boolean | Promise<boolean>;
  /** #88 private delivery path; it binds system origin and hides the native turn's
   * routine input/output in human history. Ordinary owner sendMessage is not compatible.
   * Recheck isCurrent at atomic admission, including after asynchronous preparation.
   * Reserve one private turn. Human messages arriving during it remain attributed,
   * queued public intent; do not hide a mixed public/private turn or make it public.
   * Resolves after durable admission/intent, never by guessing native execution.
   */
  privateSend(
    input: PrivateScheduledDelivery,
    isCurrent: () => Promise<boolean>,
  ): Promise<{ accepted: boolean }>;
  now?: () => number;
  changed?(): void;
}
type Store = ReturnType<typeof createManagerSchedules>;
type Runner = ReturnType<typeof createScheduleRunner>;
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  !/[\u0000-\u001f]/.test(value);

/** Uses the existing cadence/checkpoint engine. Agent identity is part of the
 * immutable store address, so changing the primary agent never retargets schedules.
 * Empty fresh state has no schedule and no startup work. The host owns one instance.
 */
export function createAgentSchedules(options: AgentSchedulesOptions) {
  if (!identity(options.projectId))
    throw new Error("A project identity is required.");
  const entries = new Map<string, Promise<{ store: Store; runner: Runner }>>();
  const now = options.now ?? Date.now;
  let enabled = false;
  let disposed = false;
  const checkAgent = async (agentId: string) => {
    if (!identity(agentId)) throw new Error("An agent identity is required.");
    const agent = await options.getAgent(agentId);
    if (!agent || agent.projectId !== options.projectId || agent.archivedAt)
      throw new Error("This agent is unavailable in the current project.");
    return agent;
  };
  const open = async (agentId: string) => {
    if (disposed) throw new Error("Schedule host is closed.");
    await checkAgent(agentId);
    let entry = entries.get(agentId);
    if (!entry) {
      entry = (async () => {
        await mkdir(options.directory, { recursive: true, mode: 0o700 });
        const rootStat = await lstat(options.directory);
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
          throw new Error("Invalid project schedule directory.");
        const root = await realpath(options.directory);
        const directory = join(root, digest([options.projectId, agentId]));
        await mkdir(directory, { mode: 0o700, recursive: true });
        const stat = await lstat(directory);
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          (await realpath(directory)) !== directory
        )
          throw new Error("Invalid agent schedule directory.");
        const marker = join(directory, "identity.json");
        try {
          await writeFile(
            marker,
            JSON.stringify({ projectId: options.projectId, agentId }) + "\n",
            { mode: 0o600, flag: "wx" },
          );
        } catch (error) {
          if (!object(error) || error.code !== "EEXIST") throw error;
        }
        const markerStat = await lstat(marker);
        if (
          !markerStat.isFile() ||
          markerStat.isSymbolicLink() ||
          markerStat.size > 4_096
        )
          throw new Error("Invalid agent schedule identity.");
        const saved: unknown = JSON.parse(await readFile(marker, "utf8"));
        if (
          !object(saved) ||
          saved.projectId !== options.projectId ||
          saved.agentId !== agentId
        )
          throw new Error("Schedule identity does not match this agent.");
        // Reused storage writes only these names. Reject a redirected retained file.
        let hasSavedSchedules = false;
        for (const name of [
          "manager-schedules.json",
          "manager-schedule-runs.json",
        ]) {
          try {
            const file = await lstat(join(directory, name));
            if (!file.isFile() || file.isSymbolicLink())
              throw new Error("Invalid schedule file.");
            if (name === "manager-schedules.json") hasSavedSchedules = true;
          } catch (error) {
            if (!object(error) || error.code !== "ENOENT") throw error;
          }
        }
        const store = createManagerSchedules(directory, now);
        await store.ready;
        const initial = await store.view();
        // The legacy engine seeds a manager review; this replacement has no
        // implicit schedule. Only an explicit owner save enables new work.
        if (!hasSavedSchedules)
          await store.save({
            expectedRevision: initial.revision,
            schedules: [],
          });
        const eligible = async () => {
          if (!enabled || disposed) return false;
          const agent = await options.getAgent(agentId);
          return Boolean(
            agent &&
            agent.projectId === options.projectId &&
            !agent.archivedAt &&
            agent.runtime.session.desiredState === "started" &&
            agent.runtime.session.observedState === "started" &&
            agent.runtime.session.sessionId &&
            !agent.runtime.session.activeTurnId &&
            (await options.canRun(agentId)),
          );
        };
        const runner = createScheduleRunner({
          store,
          eligible,
          now,
          onError: () => options.changed?.(),
          run: async (schedule: ManagerSchedule) => {
            const snapshot = await store.view();
            const selected = snapshot.schedules.find(
              (item) => item.id === schedule.id,
            );
            if (
              selected?.run.lastAt === undefined ||
              !store.current(schedule) ||
              !(await eligible())
            )
              return { accepted: false };
            const stamp = selected.run.lastAt;
            const stillCurrent = async () =>
              !disposed &&
              enabled &&
              store.current(schedule) &&
              (await store.view()).revision === snapshot.revision &&
              (await eligible());
            try {
              return await options.privateSend(
                {
                  projectId: options.projectId,
                  agentId,
                  id: `schedule:${digest([options.projectId, agentId, schedule.id, snapshot.revision, stamp])}`,
                  origin: {
                    type: "schedule",
                    scheduleId: schedule.id,
                    scheduledAt: new Date(stamp).toISOString(),
                  },
                  instruction: schedule.instruction,
                  visibility: "internal",
                  deliveryMode: "queue",
                },
                stillCurrent,
              );
            } catch {
              // Native/provider errors may contain private data; do not persist them.
              throw new Error(
                "Scheduled delivery was not confirmed. Its reserved occurrence will not be replayed automatically.",
              );
            } finally {
              options.changed?.();
            }
          },
        });
        if (enabled && !disposed) runner.start();
        return { store, runner };
      })();
      entries.set(agentId, entry);
      entry.catch(() => {
        if (entries.get(agentId) === entry) entries.delete(agentId);
      });
    }
    return entry;
  };
  return {
    async view(agentId: string) {
      return (await open(agentId)).store.view();
    },
    async save(agentId: string, value: unknown) {
      const { store } = await open(agentId);
      await checkAgent(agentId);
      const result = await store.save(value);
      options.changed?.();
      return result;
    },
    /** Call for known saved agents on host startup; registration never starts them. */
    async register(agentIds: string[]) {
      for (const agentId of agentIds) await open(agentId);
    },
    async start() {
      if (disposed) throw new Error("Schedule host is closed.");
      enabled = true;
      for (const entry of entries.values()) (await entry).runner.start();
    },
    async stop() {
      enabled = false;
      for (const entry of entries.values()) (await entry).runner.stop();
    },
    async close() {
      enabled = false;
      disposed = true;
      for (const entry of entries.values()) (await entry).runner.stop();
    },
    /** Existing timer, exposed for one bounded acceptance tick. */
    async tick(agentId: string) {
      return (await open(agentId)).runner.tick();
    },
  };
}

/** Bind only on the owner-authenticated command router, never as an agent tool. */
export function createScheduleOwnerCommands(
  schedules: ReturnType<typeof createAgentSchedules>,
) {
  return async (command: string, args: unknown): Promise<unknown> => {
    if (!object(args) || !identity(args.agentId))
      throw new Error("An agent identity is required.");
    if (command === "schedules.read") return schedules.view(args.agentId);
    if (command === "schedules.save")
      return schedules.save(args.agentId, {
        expectedRevision: args.expectedRevision,
        schedules: args.schedules,
      });
    throw new Error("Unsupported schedule command.");
  };
}
