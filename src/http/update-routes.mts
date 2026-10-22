import type { ApiInput } from "./input.mjs";
import type { PausePlan, ActivityResult } from "../updates/contracts.mjs";
import type { createUpdatePlan } from "../updates/plan.mjs";
import type { createUpdateBridge } from "../updates/bridge.mjs";
import type { createUpdateAdmission } from "../updates/admission.mjs";
import type { createBridge } from "../manager/bridge/index.mjs";
interface UpdateRouteContext {
  updatePlan: ReturnType<typeof createUpdatePlan>;
  updates: ReturnType<typeof createUpdateBridge>;
  updateAdmission: ReturnType<typeof createUpdateAdmission>;
  shutdownToken: string;
  drainHeld: boolean;
  hold: () => void;
  synchronizePlan: (plan: PausePlan | null) => void;
  activity: () => Promise<ActivityResult>;
  bridge: ReturnType<typeof createBridge>;
}
export async function handleUpdateRoute(
  url: string,
  input: ApiInput,
  {
    updatePlan,
    updates,
    updateAdmission,
    shutdownToken,
    drainHeld,
    hold,
    synchronizePlan,
    activity,
    bridge,
  }: UpdateRouteContext,
): Promise<{ status: number; body: unknown } | null> {
  const send = (status: number, body: unknown) => ({ status, body });
  if (url === "/api/updates") {
    if (
      typeof process.send === "function" &&
      ["resume-paused-work", "return-to-work"].includes(input.action)
    )
      return send(200, await updates.request(input.action));
    if (input.action === "return-to-work") {
      await updatePlan.releaseForReview();
      return send(200, { ...updates.getStatus(), plan: updatePlan.status() });
    }
    if (input.action === "resume-paused-work") {
      await updatePlan.resumeAfterCancel();
      return send(200, { ...updates.getStatus(), plan: updatePlan.status() });
    }
    return send(200, {
      ...(await updates.request(input.action || "status")),
      plan: updatePlan.status(),
    });
  }
  if (url === "/api/update-plan-status")
    return send(200, { plan: updatePlan.status() });
  if (
    [
      "/api/update-plan-begin",
      "/api/update-plan-cancel",
      "/api/update-plan-installing",
      "/api/update-plan-blocked",
      "/api/update-plan-resume",
      "/api/update-plan-review",
    ].includes(url)
  ) {
    if (input.token !== shutdownToken || typeof process.send !== "function")
      return send(403, {
        error: "Only this desktop owner may coordinate an update.",
      });
    if (url === "/api/update-plan-begin") {
      try {
        await updatePlan.begin({
          targetVersion: input.targetVersion,
          purpose: input.purpose,
        });
      } finally {
        synchronizePlan(updatePlan.status());
      }
      return send(200, { plan: updatePlan.status() });
    }
    if (["/api/update-plan-resume", "/api/update-plan-review"].includes(url)) {
      const plan = updatePlan.status();
      if (
        !plan ||
        input.planId !== plan.id ||
        input.targetVersion !== plan.targetVersion
      )
        return send(409, {
          error:
            "The update plan changed. Refresh before resuming or reviewing work.",
        });
      if (url === "/api/update-plan-resume")
        await updatePlan.resumeAfterCancel();
      else await updatePlan.releaseForReview();
      return send(200, { plan: updatePlan.status() });
    }
    if (url === "/api/update-plan-cancel") {
      if (input.planId && input.planId !== updatePlan.status()?.id)
        return send(409, {
          error: "The update plan changed. Refresh before canceling.",
        });
      await updatePlan.cancel();
      return send(200, { plan: updatePlan.status() });
    }
    if (url === "/api/update-plan-installing") {
      const reservation = await updateAdmission.reserve(activity);
      if (!reservation.reserved)
        return send(200, {
          marked: false,
          reasons: reservation.reasons,
          plan: updatePlan.status(),
        });
      try {
        const result = await updatePlan.markInstalling({
          planId: input.planId,
          targetVersion: input.targetVersion,
        });
        if (!result.marked) updateAdmission.cancel();
        return send(200, result);
      } catch (error) {
        updateAdmission.cancel();
        throw error;
      }
    }
    await updatePlan.markBlocked(
      "The update could not finish. Paused work is retained; review it or choose Resume paused work.",
      { planId: input.planId, targetVersion: input.targetVersion },
    );
    return send(200, { plan: updatePlan.status() });
  }
  if (url === "/api/update-activity") return send(200, await activity());
  if (url === "/api/update-prepare" || url === "/api/update-cancel") {
    if (input.token !== shutdownToken || typeof process.send !== "function")
      return send(403, {
        error: "Only this desktop owner may reserve an update.",
      });
    if (url === "/api/update-cancel") {
      updateAdmission.cancel();
      return send(200, { reserved: false });
    }
    if (
      drainHeld &&
      !["ready", "installing"].includes(updatePlan.status()?.phase || "")
    )
      return send(200, {
        reserved: false,
        reasons: [
          "Work is still pausing or needs review. Wait for the update plan to become ready.",
        ],
      });
    const reservation = await updateAdmission.reserve(activity);
    if (reservation.reserved) {
      try {
        await bridge.shutdown({ cooperative: true });
      } catch (error) {
        updateAdmission.cancel();
        throw error;
      }
    }
    return send(200, reservation);
  }
  return null;
}
