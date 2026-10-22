import type {
  PausePlan,
  PlanReply,
  UpdateActivity,
} from "./update-contracts.mjs";

interface PreparationPlan extends PausePlan {
  purpose?: "update" | "quit";
}
interface QuitPreparationContext {
  currentVersion: string;
  group: {
    status(): PreparationPlan | null;
    begin(input: {
      targetVersion: string;
      purpose: "quit";
    }): Promise<PreparationPlan | null>;
    markInstalling(input: {
      planId: string;
      targetVersion: string;
    }): Promise<PlanReply>;
    markBlocked(
      reason: string,
      input: { planId: string; targetVersion: string },
    ): Promise<unknown>;
  };
  assertCanBegin(): Promise<void>;
  showProgress(): Promise<void>;
  activity(): Promise<UpdateActivity>;
  lease: { acquire(): Promise<() => Promise<void>> };
  setQuitting(value: boolean): void;
  stopOwnedControllers(): Promise<void>;
  finish(): void;
}
/** Explicit Quit uses the same durable all-project preparation as updates.
 * It never treats a signal or a closed window as an agent readiness proof. */
export function createPreparationQuit(context: QuitPreparationContext) {
  let beginning: Promise<void> | undefined,
    advancing: Promise<void> | undefined;
  const isQuit = (plan: PreparationPlan | null) => plan?.purpose === "quit";
  async function begin() {
    if (beginning) return beginning;
    beginning = (async () => {
      await context.assertCanBegin();
      const current = context.group.status();
      if (current && current.phase !== "complete") {
        if (!isQuit(current))
          throw Error(
            "Resolve the current update preparation before quitting Crew.",
          );
        await context.showProgress();
        return;
      }
      const plan = await context.group.begin({
        targetVersion: context.currentVersion,
        purpose: "quit",
      });
      if (
        !plan ||
        !isQuit(plan) ||
        plan.targetVersion !== context.currentVersion ||
        !plan.consent
      )
        throw Error(
          "The shared preparation coordinator did not confirm Quit. Controllers remain running.",
        );
      await context.showProgress();
    })();
    try {
      await beginning;
    } finally {
      beginning = undefined;
    }
  }
  async function advance() {
    if (advancing) return advancing;
    advancing = (async () => {
      const plan = context.group.status();
      if (!plan || !isQuit(plan) || plan.phase !== "ready") return;
      if (plan.targetVersion !== context.currentVersion || !plan.consent)
        throw Error("Quit preparation does not match this Crew version.");
      let release: (() => Promise<void>) | undefined;
      const identity = {
        planId: plan.id,
        targetVersion: context.currentVersion,
      };
      try {
        const first = await context.activity();
        if (!first.safe)
          throw Error(
            first.reasons?.join(" ") ||
              "All-project activity is unavailable before Quit.",
          );
        release = await context.lease.acquire();
        const fresh = await context.activity();
        if (!fresh.safe)
          throw Error(
            fresh.reasons?.join(" ") || "Project activity changed before Quit.",
          );
        const marked = await context.group.markInstalling(identity);
        const confirmed = context.group.status();
        if (
          marked.marked !== true ||
          marked.plan?.id !== plan.id ||
          marked.plan.phase !== "installing" ||
          marked.plan.targetVersion !== context.currentVersion ||
          marked.plan.consent !== true ||
          !confirmed ||
          !isQuit(confirmed) ||
          confirmed.id !== plan.id ||
          confirmed.phase !== "installing" ||
          confirmed.targetVersion !== context.currentVersion
        )
          throw Error(
            "Every project must confirm the final Quit barrier before any controller stops.",
          );
        context.setQuitting(true);
        await context.stopOwnedControllers();
        await release();
        release = undefined;
        context.finish();
      } catch (error) {
        context.setQuitting(false);
        const detail = (
          error instanceof Error
            ? error.message
            : "Controller shutdown could not be confirmed."
        )
          .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
          .replace(/sk-[\w-]+/g, "[redacted]")
          .slice(0, 1400);
        try {
          await context.group.markBlocked(
            `Quit did not finish: ${detail} Prepared work and admission holds are retained for review.`,
            identity,
          );
        } catch {
          /* An uncertain durable barrier must remain held. */
        }
        throw error;
      } finally {
        await release?.();
      }
    })();
    try {
      await advancing;
    } finally {
      advancing = undefined;
    }
  }
  return { begin, advance };
}
