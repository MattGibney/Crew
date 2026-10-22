import { errorCode, record } from "../../shared/errors.mjs";
import type { Commitment } from "../scratchpad.mjs";
import type { TaskRecord } from "../../workers/contracts.mjs";
export interface ReviewSnapshot {
  enabled?: boolean;
  idle?: boolean;
  voiceConnected?: boolean;
  held?: boolean;
  scratchpad?: { commitments: (Commitment & { dueAt?: string })[] };
  tasks?: TaskRecord[];
}
interface ReviewCheckpoint {
  schemaVersion: number;
  at: number;
  fingerprint: string | null;
}
export type ReviewContext = NonNullable<
  ReturnType<typeof managerReviewContext>
>;
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const MANAGER_REVIEW_INTERVAL_MS = 10 * 60 * 1000;
const terminal = new Set(["completed", "cancelled", "canceled", "dismissed"]);
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const stamp = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? Date.parse(value)
    : null;

// Only saved explicit commitments can authorize a scheduled review. Notes and
// unrelated historical workers never become a backlog by being present on disk.
export function managerReviewContext(snapshot: ReviewSnapshot, time: number) {
  const outstanding = (snapshot.scratchpad?.commitments || []).filter(
    (item) => !terminal.has(item.status),
  );
  if (!outstanding.length) return null;
  const references = outstanding
    .map((item) => item.references)
    .filter((reference) => reference?.taskId && reference?.runId);
  const evidence = (snapshot.tasks || [])
    .filter((task) =>
      references.some(
        (reference) =>
          reference?.taskId === task.id && reference?.runId === task.runId,
      ),
    )
    .map((task) => ({
      id: task.id,
      runId: task.runId || null,
      status: task.status,
      reports: (task.reports || []).filter(
        (report) => report.runId === task.runId,
      ),
      attention: (task.attention || []).filter(
        (item) =>
          ("runId" in item && item.runId === task.runId) ||
          item.id?.startsWith(`${task.runId}:`),
      ),
      question: task.question?.runId === task.runId ? task.question : null,
      answer: task.answer || null,
      result: task.result || null,
      failure: task.failure || null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const commitments = outstanding.filter((item) => {
    const nextAt = stamp(item.nextReviewAt || item.dueAt);
    if (nextAt === null || nextAt <= time) return true;
    // A scheduled check stays deferred while its worker is merely queued or
    // running. Actual correlated evidence can warrant an earlier review.
    const worker = evidence.find(
      (task) =>
        task.id === item.references?.taskId &&
        task.runId === item.references?.runId,
    );
    return Boolean(
      worker &&
      (worker.reports.length ||
        worker.attention.length ||
        worker.question ||
        worker.result ||
        worker.failure),
    );
  });
  if (!commitments.length) return null;
  const tasks = evidence.filter((task) =>
    commitments.some(
      (item) =>
        item.references?.taskId === task.id &&
        item.references?.runId === task.runId,
    ),
  );
  const due = commitments
    .map((item) => ({
      ...item,
      reviewDue:
        stamp(item.nextReviewAt || item.dueAt) !== null &&
        (stamp(item.nextReviewAt || item.dueAt) ?? Infinity) <= time,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    fingerprint: hash({ commitments: due, tasks }),
    commitments: due,
    tasks,
  };
}

function eligible(snapshot: ReviewSnapshot) {
  return (
    snapshot?.enabled === true &&
    snapshot.idle === true &&
    snapshot.voiceConnected !== true &&
    !snapshot.held
  );
}

/** Local scheduling only. The injected callback owns native admission and must
 * recheck eligibility when it admits the turn, including after native awaits.
 * A reserved fingerprint is durable before invoking it: unknown delivery is
 * never automatically replayed. A definite admission rejection may retry later.
 */
export class ManagerReview {
  readonly file: string;
  readonly getSnapshot: () => Promise<ReviewSnapshot>;
  readonly runReview: (
    context: ReviewContext & { reviewedAt: string },
  ) => Promise<unknown>;
  readonly now: () => number;
  readonly intervalMs: number;
  readonly onError: (error: unknown) => void;
  nextAt: number;
  busy: boolean;
  timer: ReturnType<typeof setInterval> | null;
  checkpoint: ReviewCheckpoint | null;
  stopped: boolean;
  generation: number;
  constructor({
    stateDir,
    getSnapshot,
    runReview,
    now = Date.now,
    intervalMs = MANAGER_REVIEW_INTERVAL_MS,
    onError = () => {},
  }: {
    stateDir: string;
    getSnapshot: () => Promise<ReviewSnapshot>;
    runReview: (
      context: ReviewContext & { reviewedAt: string },
    ) => Promise<unknown>;
    now?: () => number;
    intervalMs?: number;
    onError?: (error: unknown) => void;
  }) {
    if (
      !stateDir ||
      typeof getSnapshot !== "function" ||
      typeof runReview !== "function" ||
      !Number.isFinite(intervalMs) ||
      intervalMs <= 0
    )
      throw new Error("Invalid manager review configuration");
    this.file = path.join(stateDir, "manager-review.json");
    this.getSnapshot = getSnapshot;
    this.runReview = runReview;
    this.now = now;
    this.intervalMs = intervalMs;
    this.onError = onError;
    this.nextAt = now() + intervalMs;
    this.busy = false;
    this.timer = null;
    this.checkpoint = null;
    this.stopped = false;
    this.generation = 0;
  }

  start() {
    this.stopped = false;
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.tick().catch((error) => this.onError(error));
      }, this.intervalMs);
      this.timer.unref?.();
    }
    return this;
  }

  stop() {
    this.stopped = true;
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async readCheckpoint() {
    if (this.checkpoint) return this.checkpoint;
    try {
      const saved: unknown = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (
        !record(saved) ||
        saved.schemaVersion !== 1 ||
        typeof saved.at !== "number" ||
        !Number.isFinite(saved.at) ||
        (saved.fingerprint !== null &&
          (typeof saved.fingerprint !== "string" ||
            !/^[a-f0-9]{64}$/.test(saved.fingerprint)))
      )
        throw new Error(
          "Invalid manager review checkpoint; review remains held",
        );
      this.checkpoint = {
        schemaVersion: 1,
        at: saved.at,
        fingerprint: saved.fingerprint,
      };
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      this.checkpoint = { schemaVersion: 1, at: 0, fingerprint: null };
    }
    return this.checkpoint;
  }

  async saveCheckpoint(checkpoint: ReviewCheckpoint) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(checkpoint)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      await fs.rename(temporary, this.file);
      this.checkpoint = checkpoint;
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  async tick() {
    if (this.stopped) return { reviewed: false, reason: "stopped" };
    if (this.busy) return { reviewed: false, reason: "busy" };
    const generation = this.generation;
    const cancelled = () => this.stopped || this.generation !== generation;
    const at = this.now();
    if (at < this.nextAt) return { reviewed: false, reason: "interval" };
    this.busy = true;
    this.nextAt = at + this.intervalMs;
    try {
      const previous = await this.readCheckpoint();
      if (cancelled()) return { reviewed: false, reason: "stopped" };
      if (at < previous.at + this.intervalMs)
        return { reviewed: false, reason: "interval" };
      const snapshot = await this.getSnapshot();
      if (cancelled()) return { reviewed: false, reason: "stopped" };
      if (!eligible(snapshot)) return { reviewed: false, reason: "ineligible" };
      const context = managerReviewContext(snapshot, at);
      if (!context) return { reviewed: false, reason: "empty" };
      if (context.fingerprint === previous.fingerprint)
        return { reviewed: false, reason: "unchanged" };
      const checkpoint = {
        schemaVersion: 1,
        at,
        fingerprint: context.fingerprint,
      };
      await this.saveCheckpoint(checkpoint);
      // Disk I/O may overlap an incoming conversation, Stop, update hold or
      // voice connection. Re-read immediately before asking native admission.
      const fresh = await this.getSnapshot();
      if (
        cancelled() ||
        !eligible(fresh) ||
        managerReviewContext(fresh, this.now())?.fingerprint !==
          context.fingerprint
      ) {
        await this.saveCheckpoint({ ...previous, at });
        return { reviewed: false, reason: cancelled() ? "stopped" : "changed" };
      }
      const result = await this.runReview({
        ...context,
        reviewedAt: new Date(at).toISOString(),
      });
      if (result === false || (record(result) && result.accepted === false)) {
        await this.saveCheckpoint({ ...previous, at });
        return { reviewed: false, reason: "rejected" };
      }
      return { reviewed: true, fingerprint: context.fingerprint };
    } finally {
      this.busy = false;
    }
  }
}
