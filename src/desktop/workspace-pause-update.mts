import {
  createWorkspacePauseParticipants,
  approvedPauseChild as approved,
} from "./workspace-pause-participants.mjs";
import {
  readWorkspacePauseJournal,
  writeWorkspacePauseJournal,
  VERSION,
  type PauseJournal,
} from "./workspace-pause-store.mjs";
import type {
  UpdateProject,
  AdmissionControl,
  PausePlan,
} from "./update-contracts.mjs";
// One durable native-owner plan coordinates all registered project controllers.
// Project execution remains in the existing per-project update-plan engines.
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { workspaceUpdateActivity } from "./workspace-update.mjs";
const clone = <T,>(value: T): T =>
  value == null ? value : structuredClone(value);
const terminal = (plan: { phase: string } | null) => plan?.phase === "complete";
export function createWorkspacePauseUpdate({
  path,
  currentVersion,
  projects,
  setAdmissionPaused,
  onChange = () => {},
}: {
  path: string;
  currentVersion: string;
  projects: () => UpdateProject[] | Promise<UpdateProject[]>;
  setAdmissionPaused: AdmissionControl;
  onChange?: (status: PausePlan | null) => void;
}) {
  if (
    !isAbsolute(path || "") ||
    !VERSION.test(currentVersion || "") ||
    typeof projects !== "function" ||
    typeof setAdmissionPaused !== "function"
  )
    throw new Error("Workspace update configuration is invalid.");
  let journal: PauseJournal | null = null,
    initialized = false,
    beginning = false,
    initialError: unknown = null,
    tail: Promise<unknown> = Promise.resolve();
  const active = (): PauseJournal => {
    if (!journal) throw new Error("No grouped update is active.");
    return journal;
  };
  const publicStatus = (): PausePlan | null => {
    if (!journal)
      return initialError
        ? {
            kind: "pause-update",
            consent: false,
            id: "unavailable",
            phase: "blocked",
            targetVersion: null,
            targets: [],
            reasons: [
              "The grouped update journal is unreadable. Preserve the global admission hold for review.",
            ],
            manager: { interrupted: false },
          }
        : null;
    return {
      kind: "pause-update",
      consent: true,
      id: active().id,
      targetVersion: active().targetVersion,
      purpose: active().purpose || "update",
      fromVersion: active().fromVersion,
      phase: active().phase,
      createdAt: active().createdAt,
      updatedAt: active().updatedAt,
      ...(active().projects.some((project) => project.preparation)
        ? {
            preparation: {
              schema: 1 as const,
              id: active().id,
              projectId: "all-projects",
              purpose: active().purpose || "update",
              phase:
                active().phase === "complete"
                  ? ("complete" as const)
                  : active().phase === "canceled"
                    ? ("canceled" as const)
                    : active().phase === "ready"
                      ? ("ready" as const)
                      : ("preparing" as const),
              createdAt: active().createdAt,
              updatedAt: active().updatedAt,
              participants: active().projects.flatMap((project) =>
                (project.preparation?.participants || []).map(
                  (participant) => ({
                    ...participant,
                    projectId: project.id,
                    projectName: project.name,
                  }),
                ),
              ),
            },
          }
        : {}),
      targets: active().projects.flatMap((project) =>
        (project.targets || []).map((target) => ({
          taskId: target.taskId,
          projectId: project.id,
          projectName: project.name,
          progress: target.progress || "captured",
        })),
      ),
      projects: active().projects.map((project) => ({
        id: project.id,
        name: project.name,
        phase: project.phase || "pending",
        ready: project.phase === "ready",
      })),
      reasons: [
        ...new Set([
          ...active().reasons,
          ...active().projects.flatMap((project) =>
            (project.reasons || []).map(
              (reason) => `Project ${project.name}: ${reason}`,
            ),
          ),
        ]),
      ],
      manager: {
        interrupted: active().projects.some(
          (project) => project.managerInterrupted === true,
        ),
      },
    };
  };
  async function save() {
    active().updatedAt = new Date().toISOString();
    await writeWorkspacePauseJournal(path, active());
    try {
      onChange(publicStatus());
    } catch {
      /* Observers cannot undo a durable barrier. */
    }
  }
  const ready = (async () => {
    try {
      const value = await readWorkspacePauseJournal(path);
      journal = value;
      if (journal)
        await setAdmissionPaused(
          ["marking", "installing"].includes(journal.phase),
        );
      initialized = true;
    } catch (error) {
      initialError = error;
      try {
        await setAdmissionPaused(true);
      } catch {}
      throw new Error(
        "The grouped update journal cannot be verified. Global admission must remain paused.",
      );
    }
  })();
  const enqueue = <T,>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(() => ready).then(fn);
    tail = result.catch(() => {});
    return result;
  };
  const {
    current,
    matchingProjects,
    hostFor,
    remember,
    childStatus,
    untouched,
    refresh,
    recoveryChild,
  } = createWorkspacePauseParticipants({ projects, active, save });
  async function block(reason: string) {
    active().phase = "blocked";
    active().reasons = [reason];
    await save();
    await setAdmissionPaused(false);
    return publicStatus();
  }
  async function blockChildren(values: UpdateProject[], reason: string) {
    const failures = [];
    for (const project of active().projects) {
      if (!project.childPlanId) continue;
      try {
        await hostFor(values, project).updateToken("update-plan-blocked", {
          planId: project.childPlanId,
          targetVersion: active().targetVersion,
          reason,
        });
      } catch {
        failures.push(project.name);
      }
    }
    return block(
      reason +
        (failures.length
          ? ` Child recovery could not be confirmed for ${failures.join(", ")}.`
          : ""),
    );
  }
  async function complete() {
    await matchingProjects();
    await setAdmissionPaused(false);
    active().phase = "complete";
    active().reasons = [];
    await save();
    return publicStatus();
  }
  async function tickInternal() {
    if (
      !journal ||
      terminal(journal) ||
      ["marking", "installing"].includes(active().phase)
    )
      return publicStatus();
    try {
      const values = await matchingProjects();
      await refresh(values);
      // Retained holds still observe exact child identities and late pause
      // confirmations. Refreshing never clears a block or installs/resumes.
      if (["blocked", "canceled"].includes(active().phase))
        return publicStatus();
      const bad = active().projects.find((project) =>
        ["blocked", "canceled"].includes(project.phase || ""),
      );
      if (bad)
        return block(
          `Project ${bad.name} requires review before the grouped update can continue.`,
        );
      if (active().phase === "resuming") {
        if (active().projects.every((project) => project.phase === "complete"))
          return complete();
        if (
          active().projects.some(
            (project) =>
              !["resuming", "complete"].includes(project.phase || ""),
          )
        )
          return block(
            "A project did not recover the expected installed update plan. Paused work is retained.",
          );
        active().reasons = [
          "Waiting for every project to confirm retained-work recovery.",
        ];
        await save();
        return publicStatus();
      }
      if (
        active().projects.some(
          (project) => !["draining", "ready"].includes(project.phase || ""),
        )
      )
        return block("A project update plan changed while pausing work.");
      const activity = await workspaceUpdateActivity(values);
      active().reasons = [...activity.reasons];
      if (
        active().projects.every((project) => project.phase === "ready") &&
        activity.safe
      ) {
        active().phase = "ready";
        active().reasons = [];
      } else {
        active().phase = "draining";
        if (!active().reasons.length)
          active().reasons = [
            "Waiting for every project to finish its controlled pause.",
          ];
      }
      await save();
      return publicStatus();
    } catch {
      return block(
        "Registered project activity or child plan identity is unavailable. Communication remains available; review preparation before retrying.",
      );
    }
  }
  return {
    ready,
    status: () => clone(publicStatus()),
    isHolding: () =>
      !initialized ||
      Boolean(journal && ["marking", "installing"].includes(journal.phase)),
    begin(input: { targetVersion: string; purpose?: "update" | "quit" }) {
      beginning = true;
      return enqueue(async () => {
        try {
          const targetVersion = input?.targetVersion;
          const purpose = input.purpose || "update";
          if (
            !VERSION.test(targetVersion || "") ||
            (targetVersion === currentVersion && purpose !== "quit") ||
            !["update", "quit"].includes(purpose)
          )
            throw new Error("A different valid target version is required.");
          if (journal && !terminal(journal)) {
            if (
              active().targetVersion === targetVersion &&
              (active().purpose || "update") === purpose
            )
              return publicStatus();
            throw new Error(
              "Resolve the current grouped update before starting another.",
            );
          }
          journal = {
            schema: 1,
            kind: "pause-update",
            consent: true,
            id: randomUUID(),
            fromVersion: currentVersion,
            targetVersion,
            purpose,
            phase: "draining",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            captureComplete: false,
            projects: [],
            reasons: [],
          };
          await save();
          await setAdmissionPaused(false);
          try {
            const values = await current();
            active().projects = values.map((project) => ({
              id: project.id,
              name: project.name || project.id,
              configPath: project.configPath,
              childPlanId: null,
              previousPlanId: null,
              beginRequested: false,
              phase: null,
              targets: [],
            }));
            active().captureComplete = true;
            await save();
            // Inspect all projects before creating a child plan in any of them.
            for (const project of active().projects) {
              const prior = (
                await hostFor(values, project).api("update-plan-status")
              )?.plan;
              if (prior && prior.phase !== "complete")
                throw new Error("A project already holds an update plan.");
              project.previousPlanId = prior?.id ?? null;
            }
            await save();
            for (const project of active().projects) {
              project.beginRequested = true;
              await save();
              const result = await hostFor(values, project).updateToken(
                "update-plan-begin",
                { targetVersion, purpose },
              );
              if (
                !approved(result?.plan, targetVersion) ||
                (result.plan.purpose || "update") !== purpose
              )
                throw new Error("Child plan was not confirmed.");
              project.childPlanId = result.plan.id;
              remember(project, result.plan);
              await save();
            }
            return tickInternal();
          } catch {
            return block(
              "Pausing could not be confirmed for every registered project. Global admission remains paused; review or cancel the retained group.",
            );
          }
        } finally {
          beginning = false;
        }
      });
    },
    tick: () => enqueue(tickInternal),
    cancel: () =>
      enqueue(async () => {
        if (!journal || terminal(journal)) return publicStatus();
        if (["installing", "marking"].includes(active().phase))
          throw new Error(
            "Installation has begun. Preserve paused work for recovery.",
          );
        try {
          const values = await matchingProjects();
          for (const project of active().projects) {
            if (!project.beginRequested) continue;
            const child = await childStatus(values, project, { adopt: true });
            if (child.phase === "complete") continue;
            const result = await hostFor(values, project).updateToken(
              "update-plan-cancel",
              {
                planId: project.childPlanId,
                targetVersion: active().targetVersion,
              },
            );
            if (
              !approved(result?.plan, active().targetVersion) ||
              result.plan.id !== project.childPlanId ||
              result.plan.phase !== "canceled"
            )
              throw new Error("Child cancellation was not confirmed.");
            remember(project, result.plan);
          }
          active().phase = "canceled";
          active().reasons = [
            "Update canceled. Choose Resume paused work or Return to work for all projects.",
          ];
          await save();
          return publicStatus();
        } catch {
          return block(
            "Cancellation could not be confirmed for every project. Communication remains available; review preparation before retrying.",
          );
        }
      }),
    resumeAfterCancel: () =>
      enqueue(async () => {
        if (!journal || !["canceled", "blocked"].includes(active().phase))
          throw new Error(
            "No canceled or blocked grouped update is available.",
          );
        try {
          const values = await matchingProjects();
          for (const project of active().projects) {
            if (!project.beginRequested) {
              await untouched(values, project);
              continue;
            }
            const child = await recoveryChild(values, project, {
              resume: true,
            });
            if (["complete", "resuming"].includes(child.phase)) continue;
            const result = await hostFor(values, project).updateToken(
              "update-plan-resume",
              {
                planId: project.childPlanId,
                targetVersion: active().targetVersion,
              },
            );
            if (
              !approved(result?.plan, active().targetVersion) ||
              result.plan.id !== project.childPlanId ||
              !["resuming", "complete"].includes(result.plan.phase)
            )
              throw new Error("Child resume was not confirmed.");
            remember(project, result.plan);
          }
          active().phase = "resuming";
          active().resumeMode = "explicit";
          active().reasons = [];
          await save();
          return tickInternal();
        } catch {
          return block(
            "Retained-work resume could not be confirmed for every project. Communication remains available; review preparation before retrying.",
          );
        }
      }),
    releaseForReview: () =>
      enqueue(async () => {
        if (!journal || !["canceled", "blocked"].includes(active().phase))
          throw new Error(
            "No canceled or blocked grouped update is available.",
          );
        try {
          const values = await matchingProjects();
          for (const project of active().projects) {
            if (!project.beginRequested) {
              await untouched(values, project);
              continue;
            }
            const child = await recoveryChild(values, project);
            if (child.phase === "complete") continue;
            const result = await hostFor(values, project).updateToken(
              "update-plan-review",
              {
                planId: project.childPlanId,
                targetVersion: active().targetVersion,
              },
            );
            if (
              !approved(result?.plan, active().targetVersion) ||
              result.plan.id !== project.childPlanId ||
              result.plan.phase !== "complete"
            )
              throw new Error("Child return was not confirmed.");
            remember(project, result.plan);
          }
          return complete();
        } catch {
          return block(
            "Return to work could not be confirmed for every project. Communication remains available; review preparation before retrying.",
          );
        }
      }),
    markInstalling: (input: { planId: string; targetVersion: string | null }) =>
      enqueue(async () => {
        if (
          !journal ||
          active().phase !== "ready" ||
          input?.planId !== active().id ||
          input.targetVersion !== active().targetVersion
        )
          return { marked: false, plan: publicStatus() };
        let values: UpdateProject[] | undefined;
        try {
          values = await matchingProjects();
          await refresh(values);
          if (
            !active().projects.every((project) => project.phase === "ready") ||
            !(await workspaceUpdateActivity(values)).safe
          )
            throw new Error("Fresh readiness changed.");
          await setAdmissionPaused(true);
          active().phase = "marking";
          await save();
          for (const project of active().projects) {
            const result = await hostFor(values, project).updateToken(
              "update-plan-installing",
              {
                planId: project.childPlanId,
                targetVersion: active().targetVersion,
              },
            );
            if (result?.marked !== true)
              throw new Error("Child install was not confirmed.");
            project.phase = "installing";
            await save();
          }
          await matchingProjects();
          active().phase = "installing";
          active().reasons = [];
          await save();
          return { marked: true, plan: publicStatus() };
        } catch {
          if (values)
            await blockChildren(
              values,
              "Installation could not be committed for every project. No controller may be stopped; communication remains available.",
            );
          else
            await block(
              "The registered project set changed before installation. Communication remains available; review preparation before retrying.",
            );
          return { marked: false, plan: publicStatus() };
        }
      }),
    markBlocked: (
      reason: string,
      input: { planId?: string; targetVersion?: string | null } = {},
    ) =>
      enqueue(async () => {
        if (
          !journal ||
          terminal(journal) ||
          active().phase === "canceled" ||
          input.planId !== active().id ||
          input.targetVersion !== active().targetVersion
        )
          return publicStatus();
        const message =
          typeof reason === "string"
            ? reason.slice(0, 600)
            : "Native installation did not finish. Retained work requires review.";
        try {
          return await blockChildren(await matchingProjects(), message);
        } catch {
          return block(
            "Installation failed and registered project recovery is unavailable. Communication remains available; review preparation before retrying.",
          );
        }
      }),
    recover: () =>
      enqueue(async () => {
        if (!journal || terminal(journal)) return publicStatus();
        await setAdmissionPaused(
          ["marking", "installing"].includes(active().phase),
        );
        try {
          const values = await matchingProjects();
          if (active().phase === "marking")
            return blockChildren(
              values,
              "Installation was interrupted before every project committed. Review retained work before continuing.",
            );
          if (active().phase === "installing") {
            if (active().purpose === "quit") {
              await refresh(values);
              active().phase = "canceled";
              active().reasons = [
                "Crew was prepared for shutdown. Review retained continuation and explicitly return to work or resume eligible paused workers.",
              ];
              await save();
              return publicStatus();
            }
            if (currentVersion !== active().targetVersion)
              return blockChildren(
                values,
                "The approved target version was not installed. Paused work is retained.",
              );
            await refresh(values);
            if (
              active().projects.some(
                (project) =>
                  !["resuming", "complete"].includes(project.phase || ""),
              )
            )
              return blockChildren(
                values,
                "A project did not recover the approved target version. Paused work is retained.",
              );
            active().phase = "resuming";
            active().resumeMode = "installed";
            await save();
            return tickInternal();
          }
          if (
            active().phase === "resuming" &&
            active().resumeMode !== "explicit" &&
            currentVersion !== active().targetVersion
          )
            return blockChildren(
              values,
              "The target version is unavailable during grouped recovery.",
            );
          return tickInternal();
        } catch {
          return block(
            "The grouped update cannot verify its registered projects. Communication remains available; review preparation before retrying.",
          );
        }
      }),
  };
}
