import type {
  UpdateStatus,
  UpdateClient,
  UpdateActivity,
  UpdateReservation,
  NativeUpdater,
  PausePlan,
  PlanReply,
} from "./update-contracts.mjs";
import { newerVersion } from "./update-primitives.mjs";
import { errorMessage } from "./validation.mjs";
export {
  newerVersion,
  signedUpdateSupport,
  otherNativeInstances,
  createInstallLease,
  createRestartHandoff,
  createNativeUpdateGate,
} from "./update-primitives.mjs";
export const RELEASE_URL = "https://github.com/MattGibney/crew/releases/latest";
export const UPDATE_ACTIONS = new Set([
  "status",
  "check",
  "download",
  "restart",
]);
export const PAUSE_UPDATE_ACTIONS = new Set([
  "pause-update",
  "cancel-pause-update",
]);
export function createUpdateCoordinator({
  updater,
  currentVersion,
  support = { supported: false, error: "Updates are unavailable." },
  activity,
  prepare,
  cancel,
  stopBackend,
  install,
  lease,
  otherInstances = async () => [],
  onState = () => {},
}: {
  updater: NativeUpdater;
  currentVersion: string;
  support?: { supported: boolean; error: string | null };
  activity: () => Promise<UpdateActivity>;
  prepare: () => Promise<UpdateReservation>;
  cancel: () => Promise<unknown>;
  stopBackend: () => Promise<unknown>;
  install: () => Promise<unknown>;
  lease: { acquire(): Promise<() => Promise<void>> };
  otherInstances?: () => Promise<number[]>;
  onState?: (status: UpdateStatus) => void;
}) {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowDowngrade = false;
  updater.allowPrerelease = false;
  updater.logger = null;
  let state: UpdateStatus = {
      phase: "idle",
      currentVersion,
      availableVersion: null,
      downloadPercent: null,
      error: support.error || null,
      installBlocked: true,
      reasons: [],
      notices: [],
      supported: support.supported === true,
      releaseUrl: RELEASE_URL,
    },
    busy = false;
  const publish = (patch: Partial<UpdateStatus>) => {
    state = { ...state, ...patch };
    onState({
      ...state,
      reasons: [...state.reasons],
      notices: [...state.notices],
    });
    return {
      ...state,
      reasons: [...state.reasons],
      notices: [...state.notices],
    };
  };
  const on = (
    name: string,
    fn: (...args: Array<{ version?: string; percent?: number }>) => void,
  ) => updater.on(name, fn);
  on("update-available", (info) => {
    if (newerVersion(info?.version, currentVersion))
      publish({
        phase: "available",
        availableVersion: info.version || null,
        error: null,
      });
    else publish({ phase: "idle", availableVersion: null, error: null });
  });
  on("update-not-available", () =>
    publish({ phase: "current", availableVersion: null, error: null }),
  );
  on("download-progress", (progress) =>
    publish({
      downloadPercent: Number.isFinite(progress?.percent)
        ? Math.max(0, Math.min(100, progress.percent || 0))
        : null,
    }),
  );
  on("update-downloaded", (info) => {
    if (newerVersion(info?.version, currentVersion))
      publish({
        phase: "downloaded",
        availableVersion: info.version || null,
        downloadPercent: 100,
        error: null,
      });
  });
  on("error", () => {
    if (state.phase !== "installing")
      publish({
        phase: "error",
        error:
          "The update could not be verified or retrieved. Check your connection and the published signed release, then retry.",
      });
  });
  async function refresh() {
    let reasons: string[] = [],
      notices: string[] = [];
    if (!state.supported)
      reasons.push(support.error || "Automatic updates are unavailable.");
    try {
      const value = await activity();
      if (Array.isArray(value?.notices))
        notices = value.notices
          .filter((item) => typeof item === "string")
          .slice(0, 12)
          .map((item) => item.slice(0, 600));
      if (value?.safe !== true)
        reasons.push(
          ...(Array.isArray(value?.reasons) && value.reasons.length
            ? value.reasons
            : ["Controller activity is unavailable."]),
        );
    } catch {
      reasons.push("Controller activity is unavailable.");
    }
    try {
      if ((await otherInstances()).length)
        reasons.push("Quit other Crew instances before restarting to update.");
    } catch {
      reasons.push("Other Crew instances could not be checked.");
    }
    return publish({ installBlocked: reasons.length > 0, reasons, notices });
  }
  async function request(
    action: string,
    { beforeInstall }: { beforeInstall?: () => Promise<void> } = {},
  ) {
    if (!UPDATE_ACTIONS.has(action)) throw new Error("Unknown update action.");
    if (action === "status") return refresh();
    if (busy) throw new Error("An update operation is already in progress.");
    if (state.phase === "installing")
      throw new Error("Crew is restarting to install its update.");
    if (!state.supported)
      throw new Error(support.error || "Automatic updates are unavailable.");
    const previousPhase = state.phase;
    busy = true;
    let release: (() => Promise<void>) | null | undefined,
      reserved = false;
    try {
      if (action === "check" && state.phase === "downloaded")
        return { ...state };
      if (action === "check") {
        publish({ phase: "checking", error: null });
        await updater.checkForUpdates();
      }
      if (action === "download") {
        if (
          state.phase !== "available" ||
          !newerVersion(state.availableVersion, currentVersion)
        )
          throw new Error("Check for a newer release before downloading.");
        publish({ phase: "downloading", downloadPercent: 0, error: null });
        await updater.downloadUpdate();
      }
      if (action === "restart") {
        if (
          state.phase !== "downloaded" ||
          !newerVersion(state.availableVersion, currentVersion)
        )
          throw new Error("Download a newer signed release before restarting.");
        release = await lease.acquire();
        if ((await refresh()).installBlocked)
          throw new Error(state.reasons.join(" "));
        const reservation = await prepare();
        if (reservation?.reserved !== true)
          throw new Error(
            Array.isArray(reservation?.reasons)
              ? reservation.reasons.join(" ")
              : "Controller could not reserve a safe restart.",
          );
        reserved = true;
        // Recheck under the global lease; a new native process must acquire this
        // same lease before starting its backend. Never terminate another instance.
        if ((await otherInstances()).length)
          throw new Error(
            "Another Crew instance opened. Quit it before updating.",
          );
        if (beforeInstall) await beforeInstall();
        publish({ phase: "installing", installBlocked: true, error: null });
        await stopBackend();
        await install();
        // Successful install owns the lease until this process exits. A replacement
        // launch recovers the dead PID/start owner; ordinary Quit never installs.
        release = null;
      }
      return { ...state };
    } catch (error) {
      if (reserved) await cancel().catch(() => {});
      const detail =
        action === "restart"
          ? String(errorMessage(error) || "Safe restart was refused.").slice(
              0,
              600,
            )
          : "The update could not be verified or retrieved. Check your connection and the published signed release, then retry.";
      publish({
        phase: action === "restart" ? previousPhase : "error",
        error: detail,
      });
      throw new Error(detail);
    } finally {
      if (release) await release();
      busy = false;
    }
  }
  return {
    request,
    refresh,
    getStatus: () => ({
      ...state,
      reasons: [...state.reasons],
      notices: [...state.notices],
    }),
  };
}

// Durable pause plans come only from the owned backend. Polling observes consent;
// it never invents a plan, drains work itself, or bypasses normal install gates.
export function createPauseUpdateCoordinator({
  native,
  begin,
  status,
  cancel,
  markInstalling,
  markBlocked,
}: {
  native: UpdateClient;
  begin(input: { targetVersion: string }): Promise<PlanReply>;
  status(): Promise<PlanReply>;
  cancel(input: { planId: string }): Promise<PlanReply>;
  markInstalling(input: {
    planId: string;
    targetVersion: string | null;
  }): Promise<PlanReply>;
  markBlocked(input: {
    planId: string;
    targetVersion: string | null;
    reason: string;
  }): Promise<PlanReply>;
}) {
  let plan: PausePlan | null = null,
    advancing = false,
    commandPending = false;
  const attempted = new Set<string>();
  const valid = (value: PausePlan | null): value is PausePlan =>
    Boolean(value) &&
    value !== null &&
    typeof value.id === "string" &&
    /^[a-zA-Z0-9_-]{1,100}$/.test(value.id) &&
    value.kind === "pause-update" &&
    value.consent === true &&
    typeof value.targetVersion === "string";
  const read = async () => {
    const value = await status();
    plan = value?.plan ?? null;
    return plan;
  };
  const approvedReady = (
    value: PausePlan | null,
  ): value is PausePlan & { phase: "ready" } =>
    valid(value) && value.phase === "ready";
  const targetMatches = (value: PausePlan) => {
    const state = native.getStatus();
    return (
      state.supported &&
      state.phase === "downloaded" &&
      value.targetVersion === state.availableVersion &&
      newerVersion(value.targetVersion, state.currentVersion)
    );
  };
  const key = (value: PausePlan) => `${value.id}:${value.targetVersion}`;
  async function installPlan(value: PausePlan) {
    if (!approvedReady(value) || !targetMatches(value))
      throw new Error(
        "The approved pause plan does not match the downloaded update.",
      );
    if (attempted.has(key(value)))
      throw new Error(
        "This pause plan already attempted installation. Review it before starting a new update plan.",
      );
    attempted.add(key(value));
    if (attempted.size > 100) attempted.delete([...attempted][0] || "");
    try {
      return await native.request("restart", {
        beforeInstall: async () => {
          const marked = await markInstalling({
            planId: value.id,
            targetVersion: value.targetVersion,
          });
          if (marked?.marked !== true)
            throw new Error(
              "The update plan changed or was canceled before installation.",
            );
          plan = marked.plan ?? { ...value, phase: "installing" };
        },
      });
    } catch (error) {
      try {
        const blocked = await markBlocked({
          planId: value.id,
          targetVersion: value.targetVersion,
          reason:
            "The native update restart did not finish. Choose Resume paused work or Return to work before another update.",
        });
        plan = blocked?.plan ?? plan;
      } catch {
        /* A durable installing plan remains fail closed; never retry it by polling. */
      }
      throw error;
    }
  }
  return {
    getPlan: () => (plan ? structuredClone(plan) : null),
    isCommandPending: () => commandPending,
    refreshPlan: read,
    async request(action: string) {
      if (!PAUSE_UPDATE_ACTIONS.has(action))
        throw new Error("Unknown pause update action.");
      if (commandPending)
        throw new Error("A pause update action is already pending.");
      commandPending = true;
      try {
        if (action === "pause-update") {
          const state = native.getStatus();
          if (
            !state.supported ||
            state.phase !== "downloaded" ||
            !newerVersion(state.availableVersion, state.currentVersion)
          )
            throw new Error(
              "Download a newer signed update before pausing work.",
            );
          const value = await begin({
            targetVersion: state.availableVersion || "",
          });
          plan = value?.plan ?? null;
          if (!valid(plan) || plan.targetVersion !== state.availableVersion)
            throw new Error(
              "The backend did not confirm an approved update plan.",
            );
        } else {
          const current = await read();
          if (!valid(current))
            throw new Error(
              "There is no approved pause update plan to cancel.",
            );
          const value = await cancel({ planId: current.id });
          plan = value?.plan ?? null;
        }
        return native.getStatus();
      } finally {
        commandPending = false;
      }
    },
    async restart() {
      if (advancing)
        throw new Error("The pause update restart is already pending.");
      advancing = true;
      try {
        const current = await read();
        if (current) {
          if (approvedReady(current)) return await installPlan(current);
          if (current.phase !== "complete")
            throw new Error(
              "Choose Resume paused work or Return to work before another update.",
            );
        }
        return await native.request("restart");
      } finally {
        advancing = false;
      }
    },
    async advancePlan() {
      if (advancing || commandPending) return native.getStatus();
      advancing = true;
      try {
        const current = await read();
        if (
          approvedReady(current) &&
          targetMatches(current) &&
          !attempted.has(key(current))
        )
          return await installPlan(current);
        return native.getStatus();
      } finally {
        advancing = false;
      }
    },
  };
}
