import { createPreparationQuit } from "./preparation-quit.mjs";
import { app } from "electron";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { createRequire } from "node:module";
import { configureGlobalCapacity } from "../orchestration/capacity.mjs";
import { createWorkspacePauseUpdate } from "./workspace-pause-update.mjs";
import {
  workspaceUpdateActivity,
  reserveWorkspaceUpdate,
  createWorkspaceUpdateReservation,
} from "./workspace-update.mjs";
import {
  createUpdateCoordinator,
  createPauseUpdateCoordinator,
  signedUpdateSupport,
  otherNativeInstances,
} from "./updater.mjs";
import type {
  createInstallLease,
  createRestartHandoff,
  createNativeUpdateGate,
} from "./updater.mjs";
import type { createProjectHost } from "./project-host.mjs";
import type {
  UpdateClient,
  UpdateStatus,
  NativeUpdater,
  UpdateProject,
} from "./update-contracts.mjs";
export interface DesktopUpdater extends UpdateClient {
  refresh(): Promise<UpdateStatus>;
}
interface ApplicationUpdateContext {
  capacityDirectory: string;
  updatesDirectory: string;
  reservationPath: string;
  projectHosts(): UpdateProject[];
  hosts(): ReturnType<typeof createProjectHost>[];
  selected(): ReturnType<typeof createProjectHost>;
  gate: ReturnType<typeof createNativeUpdateGate>;
  lease: ReturnType<typeof createInstallLease>;
  restartHandoff: ReturnType<typeof createRestartHandoff>;
  changed(): void;
  finishQuit(): void;
  attempt(operation: () => unknown): void;
  reservationPending(): Promise<boolean>;
  recordReservationFailure(error: unknown): Promise<void>;
  readonly transition: boolean;
  quitting: boolean;
  updateRecoveryError: string | undefined;
}
/** Installation/update policy belongs to the app owner and spans every registered project. */
export async function createApplicationUpdates(
  context: ApplicationUpdateContext,
) {
  const {
    capacityDirectory,
    updatesDirectory,
    reservationPath,
    projectHosts,
    selected,
    gate,
    lease,
    restartHandoff,
    changed,
    attempt,
    reservationPending,
    recordReservationFailure,
  } = context;
  let updater: DesktopUpdater,
    cancelHandoff: (() => Promise<void>) | undefined,
    refreshPending: Promise<UpdateStatus> | null;
  const support = await signedUpdateSupport({ packaged: app.isPackaged });
  let nativeUpdater: NativeUpdater;
  const publish = () => {
    if (!updater) return;
    for (const host of context.hosts())
      host.broadcastUpdate(updater.getStatus());
    changed();
  };
  const workspacePause = createWorkspacePauseUpdate({
    path: join(updatesDirectory, "workspace-pause-plan.json"),
    currentVersion: app.getVersion(),
    projects: projectHosts,
    setAdmissionPaused: (admissionPaused) =>
      configureGlobalCapacity({ dir: capacityDirectory, admissionPaused }),
    onChange: publish,
  });
  await workspacePause.ready;
  try {
    nativeUpdater = createRequire(import.meta.url)(
      "electron-updater",
    ).autoUpdater;
  } catch {
    nativeUpdater = new UnavailableUpdater();
    support.supported = false;
    support.error = "The updater is unavailable in this build.";
  }
  const updateReservation = createWorkspaceUpdateReservation({
    path: reservationPath,
    currentVersion: app.getVersion(),
    projects: projectHosts,
    setAdmissionPaused: (admissionPaused) =>
      configureGlobalCapacity({
        dir: capacityDirectory,
        admissionPaused: admissionPaused || workspacePause.isHolding(),
      }),
  });
  const native = createUpdateCoordinator({
    updater: nativeUpdater,
    currentVersion: app.getVersion(),
    support,
    lease,
    activity: async () => {
      if (
        context.transition ||
        context.quitting ||
        [...context.hosts()].some((h) => h.busy())
      )
        return {
          safe: false,
          reasons: ["Crew setup, switching or shutdown is in progress."],
        };
      if (context.updateRecoveryError)
        return { safe: false, reasons: [context.updateRecoveryError] };
      return workspaceUpdateActivity(projectHosts());
    },
    prepare: () =>
      gate.reserve(async () => {
        try {
          return workspacePause.isHolding() ||
            workspacePause.status()?.phase === "ready"
            ? await reserveWorkspaceUpdate(projectHosts(), {
                setAdmissionPaused: (admissionPaused) =>
                  configureGlobalCapacity({
                    dir: capacityDirectory,
                    admissionPaused:
                      admissionPaused || workspacePause.isHolding(),
                  }),
              })
            : await updateReservation.prepare(
                updater.getStatus().availableVersion || "",
              );
        } catch (error) {
          await recordReservationFailure(error);
          throw error;
        }
      }),
    cancel: async () => {
      try {
        gate.cancel();
        await cancelHandoff?.();
        cancelHandoff = undefined;
        context.quitting = false;
        for (const host of context.hosts()) await host.cancelUpdate();
        await updateReservation.cancel();
        if (workspacePause.isHolding())
          await configureGlobalCapacity({
            dir: capacityDirectory,
            admissionPaused: true,
          });
        context.updateRecoveryError = undefined;
      } catch (error) {
        await recordReservationFailure(error);
        throw error;
      }
    },
    stopBackend: async () => {
      cancelHandoff = await restartHandoff.write({
        configPath: selected().configPath,
        version: updater.getStatus().availableVersion || "",
      });
      context.quitting = true;
      for (const host of context.hosts()) await host.stopForUpdate();
    },
    install: () =>
      new Promise<void>((done, reject) => {
        const timer = setTimeout(
          () => finish(Error("The native installer did not restart Crew.")),
          60000,
        );
        const fail = () =>
          finish(Error("The native installer could not install the update."));
        const exiting = () => finish();
        const finish = (error?: Error) => {
          clearTimeout(timer);
          nativeUpdater.removeListener("error", fail);
          app.removeListener("before-quit", exiting);
          error ? reject(error) : done();
        };
        nativeUpdater.once("error", fail);
        app.once("before-quit", exiting);
        try {
          nativeUpdater.quitAndInstall(false, true);
        } catch {
          fail();
        }
      }),
    otherInstances: async () => {
      return otherNativeInstances({
        backendPids: [...context.hosts()]
          .map((host) => host.backendPid())
          .filter(
            (pid): pid is number =>
              typeof pid === "number" && Number.isSafeInteger(pid),
          ),
      });
    },
    onState: (status) => {
      for (const host of context.hosts())
        host.broadcastUpdate({
          ...status,
          workspacePlan: workspacePause.status(),
        });
      changed();
    },
  });
  const pauseCoordinator = createPauseUpdateCoordinator({
    native,
    begin: async (input) => ({ plan: await workspacePause.begin(input) }),
    status: async () => ({ plan: workspacePause.status() }),
    cancel: async () => ({ plan: await workspacePause.cancel() }),
    markInstalling: (input) => workspacePause.markInstalling(input),
    markBlocked: async (input) => ({
      plan: await workspacePause.markBlocked(input.reason, input),
    }),
  });
  const quitPreparation = createPreparationQuit({
    currentVersion: app.getVersion(),
    group: workspacePause,
    async assertCanBegin() {
      if (
        context.transition ||
        context.quitting ||
        context.hosts().some((host) => host.busy())
      )
        throw Error("Finish project setup or switching before preparing Quit.");
      if (
        context.updateRecoveryError ||
        (await reservationPending()) ||
        gate.isReserved()
      )
        throw Error(
          "Resolve the existing update reservation before preparing Quit.",
        );
    },
    showProgress: () => selected().openWindow(),
    activity: () => workspaceUpdateActivity(projectHosts()),
    lease,
    setQuitting: (value) => {
      context.quitting = value;
    },
    async stopOwnedControllers() {
      for (const host of context.hosts()) await host.quit();
    },
    finish: () => context.finishQuit(),
  });
  updater = {
    getStatus: () => ({
      ...native.getStatus(),
      workspacePlan: workspacePause.status(),
    }),
    async request(action = "status") {
      if (["pause-update", "cancel-pause-update"].includes(action)) {
        if (action === "pause-update") {
          if (
            context.transition ||
            context.quitting ||
            [...context.hosts()].some((host) => host.busy())
          )
            throw Error(
              "Finish project setup or switching before pausing work for an update.",
            );
          if (context.updateRecoveryError || (await reservationPending()))
            throw Error(
              "Resolve the interrupted idle update before pausing work for another update.",
            );
          if (
            context.transition ||
            context.quitting ||
            [...context.hosts()].some((host) => host.busy())
          )
            throw Error(
              "A project change is in progress. Wait before pausing all projects.",
            );
        }
        await pauseCoordinator.request(action);
      } else if (["resume-paused-work", "return-to-work"].includes(action)) {
        if (await reservationPending()) {
          for (const host of context.hosts()) await host.cancelUpdate();
          await updateReservation.cancel();
          context.updateRecoveryError = undefined;
        }
        if (action === "resume-paused-work")
          await workspacePause.resumeAfterCancel();
        else await workspacePause.releaseForReview();
      } else if (action === "restart") {
        const plan = workspacePause.status();
        if (plan?.purpose === "quit" && plan.phase !== "complete")
          throw Error("Quit preparation cannot install an update.");
        await pauseCoordinator.restart();
      } else await native.request(action);
      publish();
      return updater.getStatus();
    },
    refresh() {
      if (refreshPending) return refreshPending;
      refreshPending = (async () => {
        try {
          if (workspacePause.status()?.purpose !== "quit")
            await native.refresh();
          if (!context.updateRecoveryError) {
            await workspacePause.tick();
            if (workspacePause.status()?.purpose === "quit")
              await quitPreparation.advance();
            else await pauseCoordinator.advancePlan();
          }
          return updater.getStatus();
        } finally {
          refreshPending = null;
        }
      })();
      return refreshPending;
    },
  };
  if (support.supported) {
    const timer = setTimeout(
      () => attempt(() => updater.request("check")),
      30000,
    );
    timer.unref();
    const repeat = setInterval(
      () => attempt(() => updater.request("check")),
      6 * 60 * 60 * 1000,
    );
    repeat.unref();
  }

  return { updater, workspacePause, updateReservation, quitPreparation };
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
