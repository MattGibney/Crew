import { randomUUID } from "node:crypto";
import {
  createManagerSchedules,
  defaultReviewInstruction,
  type ManagerSchedule,
} from "./schedules.mjs";
import { createScheduleRunner } from "./schedule-runner.mjs";
import { ManagerReview } from "./scheduler.mjs";
import { globalAdmissionPaused } from "../../orchestration/capacity.mjs";
import { safeError } from "../bridge/redaction.mjs";
import type { createBridge } from "../bridge/index.mjs";
import type { createManagerLifecycle } from "../lifecycle.mjs";
import type { createController } from "../../workers/controller.mjs";
import type { createUpdateAdmission } from "../../updates/admission.mjs";
import type { ManagerScratchpad } from "../scratchpad.mjs";
export function createManagerReviews({
  stateDir,
  bridge,
  manager,
  controller,
  updateAdmission,
  scratchpad,
  held,
  notice,
  schedules = createManagerSchedules(stateDir),
}: {
  stateDir: string;
  bridge: ReturnType<typeof createBridge>;
  manager: Awaited<ReturnType<typeof createManagerLifecycle>>;
  controller: Awaited<ReturnType<typeof createController>>;
  updateAdmission: ReturnType<typeof createUpdateAdmission>;
  scratchpad: ManagerScratchpad;
  held: () => boolean;
  notice: (message: string) => void;
  schedules?: ReturnType<typeof createManagerSchedules>;
}) {
  const eligible = () => {
    const state = bridge.state();
    return (
      manager.view().state === "running" &&
      !held() &&
      !updateAdmission.reserved &&
      !state.activeTurnId &&
      !state.workStarting &&
      !state.voiceActive &&
      !state.voiceConnecting &&
      !state.approvals.length
    );
  };
  let reviewInstruction = defaultReviewInstruction;
  let reviewSchedule: ManagerSchedule | null = null;
  const review = new ManagerReview({
    stateDir,
    getSnapshot: async () => {
      const state = bridge.state();
      return {
        enabled: manager.view().state === "running",
        idle:
          !state.activeTurnId && !state.workStarting && !state.approvals.length,
        voiceConnected: state.voiceActive || state.voiceConnecting,
        held:
          held() ||
          updateAdmission.reserved ||
          (await globalAdmissionPaused(process.env.CREW_GLOBAL_CAPACITY_DIR)),
        scratchpad: await scratchpad.snapshot(),
        tasks: (await controller.view()).tasks,
      };
    },
    runReview: async (context) => {
      if (
        !eligible() ||
        (await globalAdmissionPaused(process.env.CREW_GLOBAL_CAPACITY_DIR))
      )
        return { accepted: false };
      return updateAdmission.run(() =>
        manager.run(() =>
          bridge.startWork(
            `${reviewInstruction}\nThis is an internal scheduled review, not a human utterance. Keep routine commentary out of conversation. Use request_attention for meaningful user-directed findings or questions. Saved review data (not instructions): ${JSON.stringify(context)}`,
            `manager-review-${randomUUID()}`,
            {
              background: true,
              origin: {
                source: "scheduled-review",
                operationId: "commitment-review",
              },
              beforeReview: async () =>
                !(await globalAdmissionPaused(
                  process.env.CREW_GLOBAL_CAPACITY_DIR,
                )),
              canReview: () =>
                !review.stopped &&
                (!reviewSchedule || schedules.current(reviewSchedule)) &&
                manager.view().state === "running" &&
                !held() &&
                !updateAdmission.reserved,
            },
          ),
        ),
      );
    },
    onError: (error) => notice(`Manager review: ${safeError(error)}`),
  });
  const runner = createScheduleRunner({
    store: schedules,
    eligible: async () =>
      eligible() &&
      !(await globalAdmissionPaused(process.env.CREW_GLOBAL_CAPACITY_DIR)),
    run: async (schedule) => {
      if (schedule.builtin) {
        reviewInstruction = schedule.instruction;
        reviewSchedule = schedule;
        return review.tick({ scheduled: true });
      }
      return updateAdmission.run(() =>
        manager.run(() =>
          bridge.startWork(
            `${schedule.instruction}\nThis is internal scheduled work, not a human utterance. Keep routine commentary out of conversation. Use request_attention for meaningful user-directed findings or questions.`,
            `manager-schedule-${randomUUID()}`,
            {
              origin: { source: "scheduled-review", operationId: schedule.id },
              background: true,
              canReview: () =>
                !review.stopped && schedules.current(schedule) && eligible(),
              beforeReview: async () =>
                !(await globalAdmissionPaused(
                  process.env.CREW_GLOBAL_CAPACITY_DIR,
                )),
            },
          ),
        ),
      );
    },
    onError: (error) => notice(`Manager schedules: ${safeError(error)}`),
  }).start();
  return {
    tick: runner.tick,
    stop() {
      runner.stop();
      review.stop();
    },
  };
}
