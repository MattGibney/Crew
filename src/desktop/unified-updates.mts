import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type {
  ExecutionReservation,
  PreparationReadiness,
} from "../agents/contracts.mjs";
import type { DesktopLifecycleProject } from "./unified-quit.mjs";
import type { NativeUpdater, UpdateStatus } from "./update-contracts.mjs";
import {
  createInstallLease,
  createUpdateCoordinator,
  otherNativeInstances,
  signedUpdateSupport,
} from "./updater.mjs";

export interface UnifiedUpdatePreparation {
  state:
    | "idle"
    | "preparing"
    | "blocked"
    | "ready"
    | "reserving"
    | "closing"
    | "recovery";
  detail: string | null;
  projects: {
    projectId: string;
    name: string;
    readiness: PreparationReadiness[];
    error: string | null;
    closeState: "open" | "closing" | "closed" | "unconfirmed";
  }[];
}
export interface UnifiedUpdateSnapshot extends UpdateStatus {
  preparation: UnifiedUpdatePreparation;
  holding: boolean;
  recoveryRequired: boolean;
}
interface LifecycleOptions {
  projects(): DesktopLifecycleProject[];
  changed(): void;
  busy(): boolean;
}

/** Preparation is observation. Only final composition reservations authorize close.
 * Kept separate from Electron so bounded composition checks need no installer. */
export function createUnifiedUpdateLifecycle(options: LifecycleOptions) {
  let state: UnifiedUpdatePreparation = {
    state: "idle",
    detail: null,
    projects: [],
  };
  let generation = 0,
    preparing = false,
    reserving = false,
    closingStarted = false;
  let prepared: DesktopLifecycleProject[] = [];
  let observationValid = false;
  const observations = new Map<string, string>();
  const held = new Map<
    string,
    { project: DesktopLifecycleProject; reservation: ExecutionReservation }
  >();
  const notify = () => options.changed();
  const projects = () => {
    const current = options.projects();
    if (new Set(current.map((project) => project.id)).size !== current.length)
      throw new Error(
        "Project identity is ambiguous. Reopen Crew before preparing an update.",
      );
    return current;
  };
  const sameProjects = (current: DesktopLifecycleProject[]) =>
    current.length === prepared.length &&
    current.every((project) =>
      prepared.some(
        (previous) =>
          previous.id === project.id &&
          previous.lifecycle === project.lifecycle,
      ),
    );
  const row = (id: string) =>
    state.projects.find((project) => project.projectId === id)!;
  const sessions = (readiness: PreparationReadiness[]) =>
    JSON.stringify(
      readiness
        .map((entry) => [
          entry.agentId,
          entry.sessionId,
          "preparationId" in entry ? entry.preparationId : null,
        ])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    );
  const identity = (
    value: NonNullable<
      ReturnType<NonNullable<DesktopLifecycleProject["observePreparation"]>>
    >,
  ) =>
    JSON.stringify([
      value.reason,
      value.requestedAt,
      sessions(value.readiness),
    ]);
  // Observation never issues another preparation or notifies recursively. A later
  // request cannot silently authorize installation under this owner's earlier one.
  function observe() {
    if (
      !observationValid ||
      preparing ||
      reserving ||
      closingStarted ||
      held.size
    )
      return false;
    const before = JSON.stringify(state);
    try {
      const current = projects();
      if (!sameProjects(current))
        throw new Error("Project composition changed.");
      for (const project of current) {
        if (!project.observePreparation || row(project.id).error) continue;
        const value = project.observePreparation();
        if (
          !value ||
          value.reason !== "update" ||
          identity(value) !== observations.get(project.id)
        )
          throw new Error("Preparation identity changed.");
        row(project.id).readiness = structuredClone(value.readiness);
      }
      const blocked =
        options.busy() ||
        state.projects.some(
          (project) =>
            project.error ||
            project.readiness.some((agent) => agent.state !== "ready"),
        );
      state.state = blocked ? "blocked" : "ready";
      state.detail = blocked
        ? "Some agents still need attention. Their readiness is observed without sending another preparation request."
        : "Every project reported readiness. Install will check current execution again before closing anything.";
    } catch {
      observationValid = false;
      state.state = "blocked";
      state.detail =
        "The project or preparation identity changed. Prepare every project again before installing.";
    }
    return before !== JSON.stringify(state);
  }
  async function releaseHeld() {
    for (const [id, value] of held) {
      try {
        await value.project.lifecycle.releaseExecution(value.reservation.id);
        held.delete(id);
      } catch {
        row(id).error =
          "The exact update reservation could not be released. Retry Cancel before starting work.";
      }
    }
    if (held.size)
      throw new Error(
        "An update reservation is retained. Retry Cancel before starting work.",
      );
  }
  function recovery() {
    state.state = "recovery";
    state.detail =
      "Update installation did not finish after project shutdown began. Some projects may be stopped; retained reservations prevent new work. Reopen and recover the affected projects before continuing. Crew has not restarted them.";
    notify();
  }
  return {
    snapshot: () => {
      observe();
      return structuredClone(state);
    },
    observe,
    holding: () => reserving || closingStarted || held.size > 0,
    recoveryRequired: () => closingStarted && state.state === "recovery",
    activity() {
      observe();
      if (options.busy())
        return {
          safe: false,
          reasons: ["Crew setup, switching or shutdown is in progress."],
        };
      if (state.state !== "ready" || held.size || closingStarted)
        return {
          safe: false,
          reasons: [
            state.detail ||
              "Prepare every project before installing the update.",
          ],
        };
      if (!sameProjects(projects()))
        return {
          safe: false,
          reasons: [
            "The available projects changed. Prepare every project again.",
          ],
        };
      return {
        safe: true,
        notices: [
          "Installation will freshly check and reserve every project before stopping any session.",
        ],
      };
    },
    async prepare() {
      if (preparing || reserving || held.size || closingStarted)
        throw new Error(
          "Resolve the current update preparation or retained reservation first.",
        );
      if (options.busy())
        throw new Error(
          "Finish project setup, switching or shutdown before preparing an update.",
        );
      const current = ++generation;
      preparing = true;
      prepared = [];
      observations.clear();
      observationValid = false;
      state = {
        state: "preparing",
        detail:
          "Asking every project to save continuation and report readiness.",
        projects: [],
      };
      notify();
      try {
        const targets = projects();
        state.projects = targets.map((project) => ({
          projectId: project.id,
          name: project.name,
          readiness: [],
          error: null,
          closeState: "open",
        }));
        notify();
        await Promise.all(
          targets.map(async (project) => {
            try {
              const readiness = await project.lifecycle.prepare(
                project.id,
                "update",
              );
              if (current === generation) {
                row(project.id).readiness = readiness;
                if (project.observePreparation) {
                  const value = project.observePreparation();
                  if (
                    !value ||
                    value.reason !== "update" ||
                    sessions(value.readiness) !== sessions(readiness)
                  )
                    throw new Error(
                      "Preparation changed before acknowledgement.",
                    );
                  observations.set(project.id, identity(value));
                }
              }
            } catch {
              if (current === generation)
                row(project.id).error =
                  "Update preparation is unavailable for this project.";
            }
          }),
        );
        if (current !== generation) return;
        prepared = targets;
        observationValid = true;
        const blocked =
          options.busy() ||
          !sameProjects(projects()) ||
          state.projects.some(
            (project) =>
              project.error ||
              project.readiness.some((agent) => agent.state !== "ready"),
          );
        state.state = blocked ? "blocked" : "ready";
        state.detail = blocked
          ? "Some projects need attention or changed during preparation. Communication remains available; prepare again when ready."
          : "Every project reported readiness. Install will check current execution again before closing anything.";
      } catch {
        if (current === generation) {
          state.state = "blocked";
          state.detail =
            "Every registered project must be available before preparing an update. Resolve project startup errors and retry.";
        }
      } finally {
        preparing = false;
        notify();
      }
    },
    async cancel() {
      if (reserving)
        throw new Error("The final update reservation check is in progress.");
      generation++;
      observationValid = false;
      if (closingStarted) {
        recovery();
        throw new Error(state.detail!);
      }
      try {
        await releaseHeld();
      } catch (error) {
        state.state = "blocked";
        state.detail =
          "An update reservation is retained. Retry Cancel before starting work.";
        notify();
        throw error;
      }
      prepared = [];
      state = { state: "idle", detail: null, projects: [] };
      notify();
    },
    async reserve() {
      observe();
      if (
        preparing ||
        reserving ||
        held.size ||
        closingStarted ||
        state.state !== "ready"
      )
        throw new Error("Prepare every project before installing the update.");
      reserving = true;
      observationValid = false;
      state.state = "reserving";
      state.detail = "Checking current execution and reserving every project.";
      notify();
      try {
        const targets = projects();
        if (options.busy() || !sameProjects(targets))
          throw new Error("Projects changed before installation.");
        for (const project of targets) {
          const result = await project.lifecycle.reserveExecution(
            project.id,
            "update",
          );
          if (result.state !== "reserved") {
            row(project.id).error = result.reason.slice(0, 600);
            throw new Error(
              "A project has new or unresolved work. Prepare again before installing.",
            );
          }
          held.set(project.id, { project, reservation: result.reservation });
          if (
            result.reservation.projectId !== project.id ||
            result.reservation.reason !== "update"
          )
            throw new Error(
              "A project did not confirm the requested update reservation.",
            );
        }
        if (options.busy() || !sameProjects(projects()))
          throw new Error("Projects changed during the final update check.");
        return { reserved: true };
      } catch (error) {
        state.state = "blocked";
        state.detail =
          "New or unresolved project work prevented installation. Prepare again after resolving it.";
        try {
          await releaseHeld();
        } catch {
          state.detail =
            "An update reservation is retained. Retry Cancel before starting work.";
        }
        throw error;
      } finally {
        reserving = false;
        notify();
      }
    },
    async close() {
      if (
        state.state !== "reserving" ||
        held.size !== prepared.length ||
        options.busy() ||
        !sameProjects(projects())
      )
        throw new Error(
          "Every current project must hold its update reservation before shutdown.",
        );
      closingStarted = true;
      state.state = "closing";
      state.detail =
        "Stopping owned project sessions under their confirmed update reservations.";
      notify();
      for (const { project, reservation } of held.values()) {
        row(project.id).closeState = "closing";
        notify();
        try {
          await project.close(reservation);
          row(project.id).closeState = "closed";
        } catch {
          row(project.id).closeState = "unconfirmed";
          row(project.id).error =
            "Project shutdown was not confirmed. Its update reservation is retained.";
          recovery();
          throw new Error(
            "Project shutdown was not confirmed. Installation was not started.",
          );
        }
        notify();
      }
    },
    failed() {
      observationValid = false;
      if (closingStarted) recovery();
      else {
        state.state = "blocked";
        state.detail = held.size
          ? "An update reservation is retained. Retry Cancel before starting work."
          : "Installation did not proceed. Review the update error and prepare every project before retrying.";
        notify();
      }
    },
  };
}

/** Signed native updates remain explicit. This adapter never kills a process,
 * starts a project, or installs in response to preparation becoming ready. */
export async function createUnifiedUpdates(
  options: LifecycleOptions & {
    updatesDirectory: string;
    beforeInstall(): Promise<void>;
  },
) {
  const { app } = await import("electron");
  const support = await signedUpdateSupport({ packaged: app.isPackaged });
  let updater: NativeUpdater;
  try {
    updater = createRequire(import.meta.url)("electron-updater").autoUpdater;
  } catch {
    updater = new UnavailableUpdater();
    support.supported = false;
    support.error = "The updater is unavailable in this build.";
  }
  const lease = createInstallLease({ directory: options.updatesDirectory });
  const lifecycle = createUnifiedUpdateLifecycle(options);
  let installing = false;
  const native = createUpdateCoordinator({
    updater,
    currentVersion: app.getVersion(),
    support,
    lease,
    activity: async () => lifecycle.activity(),
    prepare: () => lifecycle.reserve(),
    cancel: () => lifecycle.cancel(),
    stopBackend: async () => {
      await lifecycle.close();
      await options.beforeInstall();
    },
    otherInstances: () => otherNativeInstances(),
    onState: () => options.changed(),
    install: () =>
      new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          updater.removeListener("error", failed);
          app.removeListener("before-quit", exiting);
          error ? reject(error) : resolve();
        };
        const failed = () =>
          finish(
            new Error("The native installer could not install the update."),
          );
        const exiting = () => finish();
        const timer = setTimeout(
          () => finish(new Error("The native installer did not restart Crew.")),
          60_000,
        );
        updater.once("error", failed);
        app.once("before-quit", exiting);
        try {
          updater.quitAndInstall(false, true);
        } catch {
          failed();
        }
      }),
  });
  const snapshot = (): UnifiedUpdateSnapshot => ({
    ...native.getStatus(),
    preparation: lifecycle.snapshot(),
    holding: installing || lifecycle.holding(),
    recoveryRequired: lifecycle.recoveryRequired(),
  });
  let observedPreparation = JSON.stringify(lifecycle.snapshot());
  let refreshing: Promise<UnifiedUpdateSnapshot> | null = null;
  let refreshQueued = false,
    refreshNeeded = false;
  function queueRefresh() {
    refreshNeeded = true;
    if (refreshing || refreshQueued) return;
    refreshQueued = true;
    queueMicrotask(() => {
      refreshQueued = false;
      void status().catch(() => {
        /* The next explicit status request can retry observation. */
      });
    });
  }
  function status(): Promise<UnifiedUpdateSnapshot> {
    if (refreshing) return refreshing;
    refreshNeeded = false;
    refreshing = (async () => {
      try {
        await native.refresh();
        return snapshot();
      } finally {
        refreshing = null;
        if (refreshNeeded) queueRefresh();
      }
    })();
    return refreshing;
  }
  function observe() {
    lifecycle.observe();
    const next = JSON.stringify(lifecycle.snapshot());
    if (next === observedPreparation) return;
    observedPreparation = next;
    // Native onState calls changed(), which may observe again. Only a real
    // preparation edge queues another refresh; no notification happens inline.
    queueRefresh();
  }
  return {
    snapshot,
    observe,
    holding: () => installing || lifecycle.holding(),
    status,
    async prepare() {
      if (installing)
        throw new Error(
          "Crew is already preparing its final update installation.",
        );
      await lifecycle.prepare();
      return status();
    },
    async cancel() {
      if (installing)
        throw new Error(
          "Crew is completing its final update installation check.",
        );
      await lifecycle.cancel();
      return status();
    },
    async check() {
      await native.request("check");
      return snapshot();
    },
    async download() {
      await native.request("download");
      return snapshot();
    },
    async install() {
      if (installing)
        throw new Error("An update installation is already in progress.");
      installing = true;
      options.changed();
      try {
        await native.request("restart");
        return snapshot();
      } catch (error) {
        lifecycle.failed();
        throw error;
      } finally {
        installing = false;
        options.changed();
      }
    },
    /** All native launches use this same installation lease before opening projects. */
    async withStartupLease<T>(operation: () => Promise<T>): Promise<T> {
      if (installing || lifecycle.holding())
        throw new Error("Crew has reserved this installation for an update.");
      const release = await lease.acquire();
      try {
        return await operation();
      } finally {
        await release();
      }
    },
  };
}

class UnavailableUpdater extends EventEmitter implements NativeUpdater {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  allowDowngrade = false;
  allowPrerelease = false;
  logger: unknown = null;
  async checkForUpdates(): Promise<never> {
    throw new Error("The updater is unavailable in this build.");
  }
  async downloadUpdate(): Promise<never> {
    throw new Error("The updater is unavailable in this build.");
  }
  quitAndInstall(): never {
    throw new Error("The updater is unavailable in this build.");
  }
}
