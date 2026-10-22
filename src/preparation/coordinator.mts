import { randomUUID } from "node:crypto";
import {
  beginPreparation,
  readPreparation,
  claimPreparationDelivery,
  recordPreparationDelivery,
  cancelPreparation,
  setPreparationPhase,
} from "./store.mjs";
import { preparationMessage } from "./message.mjs";
import type { PreparationPlan, PreparationParticipant } from "./contracts.mjs";
import type {
  ManagerActivity,
  TaskActivity,
  PausePlan,
} from "../updates/contracts.mjs";
import { errorMessage } from "../shared/errors.mjs";
import type { DeliveryResult } from "../manager/bridge/work-delivery.mjs";

export interface ObservedPreparationParticipant extends PreparationParticipant {
  settled: boolean;
  settlementReason: string;
  taskLabel?: string;
}
export interface ObservedPreparation extends Omit<
  PreparationPlan,
  "participants"
> {
  participants: ObservedPreparationParticipant[];
}
export interface PreparationCoordinator {
  begin(
    plan: PausePlan,
    manager: ManagerActivity,
    tasks: TaskActivity[],
  ): Promise<void>;
  tick(
    plan: PausePlan,
    manager: ManagerActivity,
    tasks: TaskActivity[],
  ): Promise<ObservedPreparation>;
  cancel(plan: PausePlan): Promise<void>;
  complete(plan: PausePlan): Promise<void>;
}
const idle = new Set([
  "idle",
  "ready",
  "stopped",
  "completed",
  "interrupted",
  "canceled",
  "cancelled",
  "failed",
  "error",
]);
export const managerSettled = (manager: ManagerActivity) =>
  !manager.activeTurnId &&
  manager.workStarting === false &&
  idle.has(manager.status) &&
  Array.isArray(manager.approvals) &&
  manager.approvals.length === 0;
const workerSettled = (task: TaskActivity) => {
  const evidence = task.updateEvidence;
  return evidence
    ? ["absent", "stopped"].includes(evidence.worker) &&
        ["absent", "stopped"].includes(evidence.runtime) &&
        evidence.hooks.every((hook) => hook.state === "stopped")
    : (task.harnessStarted !== true && task.execution?.live !== true) ||
        (task.execution?.live === false &&
          task.execution.stopConfirmed === true);
};

/** Shared, agent-owned preparation. Observations never manufacture responses. */
export function createPreparationCoordinator({
  stateDir,
  projectId,
  sendManager,
  getManager,
}: {
  stateDir: string;
  projectId: string;
  sendManager: (
    text: string,
    requestId: string,
    preparationId: string,
  ) => Promise<DeliveryResult>;
  getManager: () => ManagerActivity | Promise<ManagerActivity>;
}): PreparationCoordinator {
  async function same(plan: PausePlan) {
    const value = await readPreparation(stateDir);
    if (
      !value ||
      value.id !== plan.id ||
      value.projectId !== projectId ||
      value.purpose !== (plan.purpose || "update")
    )
      throw new Error(
        "The agent preparation identity changed. Preserve the admission hold for review.",
      );
    return value;
  }
  return {
    async begin(plan, manager, tasks) {
      const existing = await readPreparation(stateDir);
      if (existing?.id === plan.id) {
        await same(plan);
        return;
      }
      const purpose = plan.purpose || "update";
      await beginPreparation(stateDir, {
        id: plan.id,
        projectId,
        purpose,
        participants: [
          {
            id: "manager",
            role: "manager",
            taskId: null,
            runId: null,
            threadId: manager.threadId || null,
            requestId: randomUUID(),
            required:
              manager.lifecycleState !== "stopped" &&
              Boolean(
                manager.threadId ||
                manager.activeTurnId ||
                manager.workStarting,
              ),
            message:
              "Prepare your existing manager conversation and commitments for continuation. Coordinate only this explicit preparation request; ordinary new work is held.",
          },
          ...tasks
            .filter(
              (task) =>
                [
                  "queued",
                  "launching",
                  "running",
                  "resume_queued",
                  "verifying",
                  "pausing",
                  "stopping",
                ].includes(task.status) || !workerSettled(task),
            )
            .map((task) => ({
              id: `worker-${task.id}`,
              role: "worker" as const,
              taskId: task.id,
              runId: task.runId || null,
              threadId: task.threadId || null,
              requestId: randomUUID(),
              required: Boolean(task.runId && !workerSettled(task)),
              message:
                "Prepare your existing worker context and resources for continuation. Preserve partial files, results and useful factual notes using your normal tools; decide a sensible stopping point.",
            })),
        ],
      });
    },
    async tick(plan, manager, tasks) {
      let value = await same(plan);
      const participant = value.participants.find((p) => p.role === "manager");
      if (
        ["draining", "ready"].includes(plan.phase) &&
        value.phase === "preparing" &&
        participant?.required &&
        participant.delivery.state === "pending" &&
        !manager.workStarting &&
        !manager.approvals.length
      ) {
        const identity = {
          preparationId: value.id,
          participantId: participant.id,
          requestId: participant.requestId,
        };
        if (participant.threadId && participant.threadId !== manager.threadId) {
          if (await claimPreparationDelivery(stateDir, identity))
            await recordPreparationDelivery(stateDir, identity, {
              state: "failed",
              error:
                "The manager conversation changed before preparation delivery. Review it before retrying.",
            });
        } else if (await claimPreparationDelivery(stateDir, identity)) {
          try {
            const result = await sendManager(
              preparationMessage({
                ...identity,
                purpose: value.purpose,
                projectId,
                participant,
              }),
              `crew-preparation-${value.id}-${participant.requestId}`,
              value.id,
            );
            if ("accepted" in result || !(result.turn?.id || result.turnId))
              throw new Error(
                "Native manager did not acknowledge preparation delivery.",
              );
            await recordPreparationDelivery(stateDir, identity, {
              state: "acknowledged",
              nativeTurnId: result.turn?.id || result.turnId,
            });
          } catch (error) {
            await recordPreparationDelivery(stateDir, identity, {
              state: "uncertain",
              error: `Manager preparation delivery is unverified: ${errorMessage(error).slice(0, 500)}. No automatic replay was attempted.`,
            });
          }
        }
        value = await same(plan);
      }
      // Native delivery may start/end a turn while its RPC is awaited. Render
      // the resulting state rather than the pre-delivery idle snapshot.
      manager = await getManager();
      return {
        ...value,
        participants: value.participants.map((p) => {
          // Full response history/context stays in preparation.json. The shared
          // progress surface carries only the latest bounded explanation.
          const response = p.response
            ? {
                ...p.response,
                note: p.response.note.slice(0, 1000),
                ...(p.response.continuation
                  ? { continuation: p.response.continuation.slice(0, 1000) }
                  : {}),
              }
            : null;
          const projected = {
            ...p,
            response,
            responses: response ? [response] : [],
          };
          if (p.role === "manager") {
            const settled = managerSettled(manager);
            return {
              ...projected,
              settled,
              settlementReason: settled
                ? "Native turn and input are settled."
                : manager.approvals.length
                  ? "Waiting for the manager's pending native input."
                  : manager.workStarting
                    ? "Waiting for manager delivery to settle."
                    : "Waiting for the manager's final turn and messages.",
            };
          }
          const task = tasks.find((task) => task.id === p.taskId);
          const sameRun = !!task && (task.runId || null) === p.runId;
          const settled = sameRun && workerSettled(task);
          return {
            ...projected,
            settled,
            taskLabel:
              (task?.title || task?.ticket || p.taskId || "").slice(0, 500) ||
              undefined,
            settlementReason: !task
              ? "Worker evidence is unavailable."
              : !sameRun
                ? "The worker run changed; review its retained context."
                : settled
                  ? "Owned execution and resources are settled."
                  : "Waiting for final worker messages and verified owned execution/resource shutdown.",
          };
        }),
      };
    },
    async cancel(plan) {
      const value = await readPreparation(stateDir);
      if (value?.id === plan.id && value.phase !== "complete")
        await cancelPreparation(stateDir, plan.id);
    },
    async complete(plan) {
      const value = await readPreparation(stateDir);
      if (
        value?.id === plan.id &&
        !["canceled", "complete"].includes(value.phase)
      )
        await setPreparationPhase(stateDir, plan.id, "complete");
    },
  };
}
