import { globalAdmissionPaused } from "../orchestration/capacity.mjs";
import { readUpdatePlan, isUpdatePlanHolding } from "../updates/plan.mjs";
import { readPreparation } from "../preparation/store.mjs";
import { readTask, updateTask } from "../orchestration/store.mjs";
import type {
  DirectionDelivery,
  TaskRecord,
  WorkerAssignment,
} from "./contracts.mjs";
import { errorMessage, isRecord } from "./errors.mjs";

export function pendingDirection(task: TaskRecord) {
  return task.assignments?.find(
    (item) => item.status === "queued" && item.id !== task.currentAssignmentId,
  );
}
export function recordDirectionDelivery(
  item: WorkerAssignment,
  delivery: DirectionDelivery,
) {
  item.delivery = delivery;
  (item.deliveryHistory ||= []).push(delivery);
}
function available(task: TaskRecord, runId: string) {
  return (
    task.runId === runId &&
    !["disposed", "removed", "archived"].includes(task.status) &&
    !task.archiveRestoration?.requiresRecovery &&
    !task.lifecycleRequests?.some((r) =>
      ["pending", "processing"].includes(r.status),
    )
  );
}
/** One ordered durable attempt per direction. Acceptance is not model-consumption evidence. */
export function createRunnerDirections({
  stateDir,
  globalCapacityDir,
  taskId,
  runId,
  snapshot,
  steer,
}: {
  stateDir: string;
  globalCapacityDir?: string;
  taskId: string;
  runId: string;
  snapshot: () => {
    threadId: string | null;
    turnId: string | null;
    acknowledged: boolean;
    ending: boolean;
  };
  steer: (input: {
    threadId: string;
    expectedTurnId: string;
    requestId: string;
    text: string;
  }) => Promise<{ turnId?: string }>;
}) {
  let inFlight: Promise<void> | null = null;
  async function held() {
    if (await globalAdmissionPaused(globalCapacityDir)) return true;
    if (isUpdatePlanHolding(await readUpdatePlan(stateDir))) return true;
    const preparation = await readPreparation(stateDir);
    return Boolean(
      preparation && !["canceled", "complete"].includes(preparation.phase),
    );
  }
  async function deliver() {
    const current = snapshot();
    if (
      !current.threadId ||
      !current.turnId ||
      !current.acknowledged ||
      current.ending
    )
      return;
    if (await held()) return;
    const task = await readTask(stateDir, taskId),
      direction = pendingDirection(task);
    if (
      !available(task, runId) ||
      (task.threadId && task.threadId !== current.threadId) ||
      !direction ||
      (direction.delivery && direction.delivery.state !== "pending")
    )
      return;
    const identity = {
      runId,
      threadId: current.threadId,
      turnId: current.turnId,
    };
    let claimed = false;
    await updateTask(stateDir, taskId, async (next) => {
      if (await held()) return;
      const first = pendingDirection(next),
        live = snapshot();
      if (
        !available(next, runId) ||
        (next.threadId && next.threadId !== current.threadId) ||
        first?.id !== direction.id ||
        (first.delivery && first.delivery.state !== "pending") ||
        live.ending ||
        !live.acknowledged ||
        live.turnId !== current.turnId ||
        live.threadId !== current.threadId
      )
        return;
      next.threadId ||= current.threadId;
      recordDirectionDelivery(first, {
        state: "attempted",
        ...identity,
        at: new Date().toISOString(),
      });
      claimed = true;
    });
    if (!claimed) return;
    let state: DirectionDelivery["state"], error: string | undefined;
    try {
      const result = await steer({
        threadId: current.threadId,
        expectedTurnId: current.turnId,
        requestId: direction.id,
        text: `Manager direction (task ${taskId}, request ${direction.id}, run ${runId}):\n${direction.brief}`,
      });
      state = result.turnId === current.turnId ? "acknowledged" : "uncertain";
      if (state === "uncertain")
        error =
          "Native acknowledgement did not match the captured turn. Not replayed.";
    } catch (cause) {
      // A local before-send failure or native JSON-RPC rejection proves non-acceptance. A timeout,
      // malformed result or closed pipe can follow acceptance; never blindly retry.
      const rejected = isRecord(cause) && cause.nativeRejected === true;
      const message = errorMessage(cause);
      const notSent = isRecord(cause) && cause.nativeNotSent === true;
      const ended =
        notSent ||
        (rejected &&
          /no active turn|no turn (?:is )?(?:currently )?in progress|(?:active|expected).*turn.*(?:mismatch|does not match)|turn.*(?:not active|not found)/i.test(
            message,
          ));
      state = ended ? "rejected" : rejected ? "failed" : "uncertain";
      error = ended
        ? "Native turn ended or changed before acceptance; retained direction will continue after confirmed closure."
        : rejected
          ? "Native server rejected steering. Direction retained; inspect protocol support before sending a new request."
          : "Native delivery could not be confirmed. Not replayed; ask the worker or inspect its conversation to resolve this delivery.";
    }
    await updateTask(stateDir, taskId, (next) => {
      const item = next.assignments?.find((item) => item.id === direction.id);
      if (
        !item ||
        item.delivery?.state !== "attempted" ||
        item.delivery.runId !== runId ||
        item.delivery.turnId !== current.turnId
      )
        return;
      recordDirectionDelivery(item, {
        state,
        ...identity,
        at: new Date().toISOString(),
        ...(error ? { error } : {}),
      });
      if (state === "acknowledged") {
        item.status = "steered";
        if (!item.runIds.includes(runId)) item.runIds.push(runId);
        delete next.followupWait;
      } else next.followupWait = error;
    });
  }
  return {
    observe: () => {
      if (!inFlight)
        inFlight = deliver().finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
    drain: async () => {
      await inFlight;
    },
  };
}
