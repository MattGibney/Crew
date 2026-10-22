import type {
  AgentLifecycle,
  ExecutionReservation,
  PreparationReadiness,
} from "../agents/contracts.mjs";

export interface DesktopLifecycleProject {
  id: string;
  name: string;
  lifecycle: AgentLifecycle;
  observePreparation?(): {
    reason: ExecutionReservation["reason"];
    requestedAt: string;
    readiness: PreparationReadiness[];
  } | null;
  /** Composition settles/stops owned native sessions under its exact reservation. */
  close(reservation: ExecutionReservation): Promise<void>;
}
export interface DesktopQuitSnapshot {
  state: "idle" | "preparing" | "blocked" | "ready" | "recovery";
  recoveryRequired: boolean;
  detail: string | null;
  projects: {
    projectId: string;
    name: string;
    readiness: PreparationReadiness[];
    error: string | null;
    closeState: "open" | "closing" | "closed" | "unconfirmed";
  }[];
}

/** Desktop coordinates projects; each composition remains the admission/settlement
 * authority. No shutdown occurs until every project grants its final reservation. */
export function createUnifiedQuit(options: {
  projects(): DesktopLifecycleProject[];
  changed(): void;
  finish(): Promise<void>;
}) {
  let state: DesktopQuitSnapshot = {
    state: "idle",
    recoveryRequired: false,
    detail: null,
    projects: [],
  };
  let generation = 0;
  let finishing = false;
  const preparationTimes = new Map<string, string>();
  const held = new Map<
    string,
    { project: DesktopLifecycleProject; reservation: ExecutionReservation }
  >();
  const notify = () => options.changed();
  function observe() {
    if (
      state.recoveryRequired ||
      state.state === "idle" ||
      state.state === "preparing" ||
      finishing ||
      held.size
    )
      return;
    try {
      const projects = options.projects();
      if (
        projects.length !== state.projects.length ||
        projects.some(
          (project) =>
            !state.projects.some((row) => row.projectId === project.id),
        )
      ) {
        state.state = "blocked";
        state.detail = "The project list changed. Prepare all projects again.";
        return;
      }
      for (const project of projects) {
        if (!project.observePreparation) continue;
        const row = state.projects.find(
          (item) => item.projectId === project.id,
        )!;
        const current = project.observePreparation();
        const identity = (items: PreparationReadiness[]) =>
          JSON.stringify(
            items
              .map((item) => [
                item.agentId,
                item.sessionId,
                "preparationId" in item ? item.preparationId : null,
              ])
              .sort(),
          );
        if (
          !current ||
          current.reason !== "quit" ||
          current.requestedAt !== preparationTimes.get(project.id) ||
          identity(current.readiness) !== identity(row.readiness)
        ) {
          row.error = "Preparation changed. Prepare all projects again.";
        } else row.readiness = structuredClone(current.readiness);
      }
      const blocked = state.projects.some(
        (project) =>
          project.error ||
          project.readiness.some((agent) => agent.state !== "ready"),
      );
      state.state = blocked ? "blocked" : "ready";
      state.detail = blocked
        ? "Waiting for current continuation and readiness reports. Conversation remains available."
        : "Agents reported readiness. Quit will check current execution again before closing.";
    } catch {
      state.state = "blocked";
      state.detail =
        "Project readiness is unavailable. Resolve project setup before quitting.";
    }
  }
  async function releaseHeld() {
    let failed = false;
    for (const [id, value] of held) {
      try {
        await value.project.lifecycle.releaseExecution(value.reservation.id);
        held.delete(id);
      } catch {
        failed = true;
      }
    }
    if (failed)
      throw new Error(
        "A project reservation could not be released. Retry Return to work.",
      );
  }
  return {
    snapshot: () => structuredClone(state),
    observe,
    holding: () => finishing || state.recoveryRequired || held.size > 0,
    async prepare() {
      if (state.recoveryRequired)
        throw new Error(
          "Quit recovery is required. Crew cannot prepare or resume a project whose shutdown has begun.",
        );
      if (finishing || held.size)
        throw new Error("Resolve the retained shutdown reservation first.");
      const current = ++generation;
      preparationTimes.clear();
      let projects: DesktopLifecycleProject[];
      try {
        projects = options.projects();
      } catch {
        state = {
          state: "blocked",
          recoveryRequired: false,
          detail:
            "Every registered project must be available for a current shutdown check.",
          projects: [],
        };
        notify();
        return;
      }
      state = {
        state: "preparing",
        recoveryRequired: false,
        detail: "Asking agents to save continuation and report readiness.",
        projects: projects.map((project) => ({
          projectId: project.id,
          name: project.name,
          readiness: [],
          error: null,
          closeState: "open",
        })),
      };
      notify();
      await Promise.all(
        projects.map(async (project) => {
          try {
            const readiness = await project.lifecycle.prepare(
              project.id,
              "quit",
            );
            if (current === generation) {
              state.projects.find(
                (row) => row.projectId === project.id,
              )!.readiness = readiness;
              const observed = project.observePreparation?.();
              if (observed)
                preparationTimes.set(project.id, observed.requestedAt);
            }
          } catch {
            if (current === generation)
              state.projects.find(
                (row) => row.projectId === project.id,
              )!.error =
                "Preparation is unavailable. Check this project's agents before quitting.";
          }
        }),
      );
      if (current !== generation) return;
      const blocked = state.projects.some(
        (project) =>
          project.error ||
          project.readiness.some((agent) => agent.state !== "ready"),
      );
      state.state = blocked ? "blocked" : "ready";
      state.detail = blocked
        ? "Waiting for current continuation and readiness reports. Conversation remains available."
        : "Agents reported readiness. Quit will check current execution again before closing.";
      notify();
    },
    async cancel() {
      if (state.recoveryRequired)
        throw new Error(
          "Quit recovery is required. Return to work cannot reopen projects whose shutdown has begun; their reservations remain held.",
        );
      if (finishing)
        throw new Error("Crew is completing its final shutdown check.");
      generation++;
      await releaseHeld();
      state = {
        state: "idle",
        recoveryRequired: false,
        detail: null,
        projects: [],
      };
      notify();
    },
    async quit() {
      if (state.recoveryRequired)
        throw new Error(
          "Quit recovery is required. Resolve the incomplete project shutdown before trying again.",
        );
      if (finishing) return;
      if (state.state !== "ready")
        throw new Error("Prepare all projects before quitting.");
      finishing = true;
      notify();
      let closingStarted = false;
      try {
        const projects = options.projects();
        // Never re-use the earlier readiness observation as execution authority.
        for (const project of projects) {
          const result = await project.lifecycle.reserveExecution(
            project.id,
            "quit",
          );
          if (result.state !== "reserved")
            throw new Error(
              "A project has new or unresolved work. Prepare again before quitting.",
            );
          held.set(project.id, { project, reservation: result.reservation });
        }
        closingStarted = true;
        for (const { project, reservation } of held.values()) {
          const row = state.projects.find(
            (item) => item.projectId === project.id,
          );
          if (row) row.closeState = "closing";
          notify();
          try {
            await project.close(reservation);
            if (row) row.closeState = "closed";
          } catch (error) {
            if (row) {
              row.closeState = "unconfirmed";
              row.error =
                "Project shutdown was not confirmed. Its reservation remains held.";
            }
            throw error;
          }
          notify();
        }
        await options.finish();
      } catch {
        state.recoveryRequired = closingStarted;
        state.state = closingStarted ? "recovery" : "blocked";
        state.detail = closingStarted
          ? "Quit did not finish after project shutdown began. Some projects are stopped or unconfirmed. Recovery is required before work can resume; reservations remain held and Crew has not restarted the projects."
          : "New or unresolved work prevented Quit. Prepare again after resolving the affected agents.";
        if (!closingStarted) {
          try {
            await releaseHeld();
          } catch {
            state.detail =
              "A project reservation could not be released. Retry Return to work before starting new work.";
          }
        }
        notify();
      } finally {
        finishing = false;
        notify();
      }
    },
  };
}
