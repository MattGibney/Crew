import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  ID,
  type PauseJournal,
  type SavedProject,
} from "./workspace-pause-store.mjs";
import type { UpdateProject, PausePlan } from "./update-contracts.mjs";

export const approvedPauseChild = (
  child: PausePlan | null | undefined,
  target: string,
): child is PausePlan =>
  Boolean(child) &&
  child != null &&
  ID.test(child.id || "") &&
  child.kind === "pause-update" &&
  child.consent === true &&
  child.targetVersion === target;
/** Correlates registered controllers with captured child plans. Adoption requires
 * persisted begin intent and exact target/plan identity; recovery never guesses. */
export function createWorkspacePauseParticipants({
  projects,
  active,
  save,
}: {
  projects: () => UpdateProject[] | Promise<UpdateProject[]>;
  active: () => PauseJournal;
  save: () => Promise<void>;
}) {
  async function current() {
    const values = await projects();
    if (!Array.isArray(values) || !values.length || values.length > 64)
      throw new Error("Registered projects are unavailable.");
    const result: UpdateProject[] = [];
    for (const project of values) {
      if (
        !ID.test(project?.id || "") ||
        !isAbsolute(project?.configPath || "") ||
        typeof project.host?.api !== "function" ||
        typeof project.host?.updateToken !== "function"
      )
        throw new Error(
          "A registered project controller or identity is unavailable.",
        );
      result.push({
        ...project,
        name:
          typeof project.name === "string" && project.name.trim()
            ? project.name.trim().slice(0, 160)
            : project.id,
        configPath: await realpath(resolve(project.configPath)),
      });
    }
    if (
      new Set(result.map((project) => project.id)).size !== result.length ||
      new Set(result.map((project) => project.configPath)).size !==
        result.length
    )
      throw new Error("Registered project identities overlap.");
    return result;
  }
  async function matchingProjects() {
    const values = await current();
    if (
      !active().captureComplete ||
      values.length !== active().projects.length ||
      values.some(
        (project) =>
          !active().projects.some(
            (saved) =>
              saved.id === project.id &&
              saved.configPath === project.configPath,
          ),
      )
    )
      throw new Error(
        "The registered project set changed or its capture is incomplete. Review the grouped update before continuing.",
      );
    return values;
  }
  const hostFor = (values: UpdateProject[], project: SavedProject) => {
    const value = values.find((value) => value.id === project.id);
    if (!value) throw new Error("Project is unavailable.");
    return value.host;
  };
  function remember(project: SavedProject, child: PausePlan) {
    project.phase = child.phase;
    project.targets = (child.targets || [])
      .slice(0, 4096)
      .filter((target) => typeof target.taskId === "string")
      .map((target) => ({
        taskId: target.taskId,
        progress:
          typeof target.progress === "string"
            ? target.progress.slice(0, 160)
            : "captured",
      }));
    project.managerInterrupted = child.manager?.interrupted === true;
  }
  async function childStatus(
    values: UpdateProject[],
    project: SavedProject,
    { adopt = false } = {},
  ) {
    const result = await hostFor(values, project).api("update-plan-status"),
      child = result?.plan ?? null;
    if (
      !project.childPlanId &&
      adopt &&
      project.beginRequested &&
      approvedPauseChild(child, active().targetVersion) &&
      child.id !== project.previousPlanId
    ) {
      project.childPlanId = child.id;
      remember(project, child);
      await save();
    }
    if (
      !approvedPauseChild(child, active().targetVersion) ||
      child.id !== project.childPlanId
    )
      throw new Error(
        `Project ${project.name} has an unavailable or changed update plan.`,
      );
    remember(project, child);
    return child;
  }
  async function untouched(values: UpdateProject[], project: SavedProject) {
    const child =
      (await hostFor(values, project).api("update-plan-status"))?.plan ?? null;
    if (
      (child?.id ?? null) !== project.previousPlanId ||
      (child && child.phase !== "complete")
    )
      throw new Error("An uncaptured child plan changed.");
    project.phase = "complete";
  }
  async function refresh(values: UpdateProject[]) {
    for (const project of active().projects) {
      if (project.beginRequested)
        await childStatus(values, project, { adopt: true });
      else await untouched(values, project);
    }
    await save();
  }
  async function recoveryChild(
    values: UpdateProject[],
    project: SavedProject,
    { resume = false } = {},
  ) {
    let child = await childStatus(values, project, { adopt: true });
    if (child.phase === "complete" || (resume && child.phase === "resuming"))
      return child;
    if (!["canceled", "blocked"].includes(child.phase)) {
      const result = await hostFor(values, project).updateToken(
        "update-plan-blocked",
        {
          planId: project.childPlanId,
          targetVersion: active().targetVersion,
          reason: "The user explicitly chose grouped retained-work recovery.",
        },
      );
      const updated = result?.plan;
      if (
        !approvedPauseChild(updated, active().targetVersion) ||
        updated.id !== project.childPlanId ||
        !["blocked", "canceled", "complete"].includes(updated.phase)
      )
        throw new Error("Child recovery hold was not confirmed.");
      child = updated;
      remember(project, child);
    }
    return child;
  }
  return {
    current,
    matchingProjects,
    hostFor,
    remember,
    childStatus,
    untouched,
    refresh,
    recoveryChild,
  };
}
