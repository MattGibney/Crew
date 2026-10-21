import { useEffect } from "react";
import type { Dispatch, SetStateAction, MutableRefObject } from "react";
import { api, ApiError, errorText, endVoiceBeacon } from "../api.js";
import { decodeManagerEvent } from "../../contracts/decode.js";
import type { useVoiceSession } from "../useVoiceSession.js";
import type {
  UpdateStatus,
  WorkState,
  ManagerLifecycle,
  SettingsState,
  OrchestrationState,
  WorkerApproval,
  ProjectInfo,
} from "../../contracts/manager.js";
type Setter<T> = Dispatch<SetStateAction<T>>;
interface ConnectionBindings {
  voice: ReturnType<typeof useVoiceSession>;
  loadVoices: () => Promise<void>;
  showError: (error: unknown) => void;
  nativeAttentionSound: MutableRefObject<boolean | null>;
  setEventReady: Setter<boolean>;
  setUpdates: Setter<UpdateStatus | null>;
  setWork: Setter<WorkState>;
  setManagerLifecycle: Setter<ManagerLifecycle>;
  setSettings: Setter<SettingsState | null>;
  setOrchestration: Setter<OrchestrationState>;
  setWorkerApprovals: Setter<WorkerApproval[]>;
  setWorkNotice: Setter<string>;
  setProjectInfo: Setter<ProjectInfo | null>;
  setProject: Setter<string>;
  setPrepared: Setter<boolean>;
  setAccount: Setter<string>;
  setSettingsError: Setter<string>;
  setVoiceLoading: Setter<boolean>;
  setVoiceNotice: Setter<string>;
}
/** One event stream and one bootstrap for this project renderer; observation starts no work. */
export function useManagerConnection({
  voice,
  loadVoices,
  showError,
  nativeAttentionSound,
  setEventReady,
  setUpdates,
  setWork,
  setManagerLifecycle,
  setSettings,
  setOrchestration,
  setWorkerApprovals,
  setWorkNotice,
  setProjectInfo,
  setProject,
  setPrepared,
  setAccount,
  setSettingsError,
  setVoiceLoading,
  setVoiceNotice,
}: ConnectionBindings) {
  useEffect(() => {
    let canceled = false;
    const events = new EventSource("/events");
    events.onopen = () => {
      if (!canceled) setEventReady(true);
    };
    events.onerror = () => {
      if (!canceled) {
        setEventReady(false);
        voice.transportLost();
      }
    };
    events.onmessage = (event) => {
      if (canceled) return;
      try {
        const message = decodeManagerEvent(JSON.parse(event.data));
        if (!message) return;
        if (message.type === "update-state") setUpdates(message.status);
        if (message.type === "work-state") {
          setWork(message.state);
          if (message.state.managerLifecycle)
            setManagerLifecycle(message.state.managerLifecycle);
        }
        if (message.type === "manager-lifecycle") {
          setManagerLifecycle(message.state);
          if ("activeVersion" in message.state)
            setSettings((previous) =>
              previous
                ? {
                    ...previous,
                    manager: {
                      ...previous.manager,
                      activeVersion: message.state.activeVersion,
                      retainedVersion: message.state.retainedVersion,
                      pendingRestart:
                        (previous.manager.savedBehaviorVersion ||
                          previous.manager.saved.version) !==
                        (message.state.activeVersion ||
                          message.state.retainedVersion),
                    },
                  }
                : previous,
            );
          if (message.state.state !== "running") voice.dispose();
        }
        if (message.type === "update-plan-state")
          setUpdates((previous) => ({ ...previous, plan: message.plan }));
        if (message.type === "orchestration-state")
          setOrchestration(message.state);
        if (message.type === "worker-approval-state")
          setWorkerApprovals(message.requests);
        if (message.type === "notice") setWorkNotice(message.message);
        voice.handleEvent(message);
      } catch (failure) {
        showError(`Could not read a live update: ${errorText(failure)}`);
      }
    };
    void (async () => {
      let bootstrapRunning = false;
      try {
        const config = await api("config");
        if (!canceled) {
          nativeAttentionSound.current = config.nativeAttentionSound === true;
          setProjectInfo(config.project);
          setProject(
            `${config.project.name} · ${config.project.mode === "fixture" ? "disposable fixture" : "configured project"}${config.project.readiness.ready ? "" : " · setup needed: " + config.project.readiness.issues.join("; ")}`,
          );
        }
      } catch (failure) {
        if (!canceled)
          setProject(
            `Project configuration unavailable: ${errorText(failure)}`,
          );
      }
      if (canceled) return;
      try {
        const nextSettings = await api("settings", {}, { method: "GET" });
        bootstrapRunning = nextSettings.managerLifecycle.state === "running";
        if (!canceled) {
          setSettings(nextSettings);
          setManagerLifecycle(nextSettings.managerLifecycle);
        }
        const result =
          nextSettings.managerLifecycle.state === "running"
            ? await api("prepare")
            : { state: await api("state"), plan: undefined };
        if (!canceled) {
          setPrepared(nextSettings.managerLifecycle.state === "running");
          setAccount(
            nextSettings.managerLifecycle.state === "running"
              ? `Signed in with ChatGPT · ${result.plan || "subscription"}. No API key used.`
              : "Manager stopped. Start explicitly to reconnect the saved conversation.",
          );
          if (result.state) setWork(result.state);
        }
        const refreshed = await api("settings", {}, { method: "GET" });
        if (!canceled) {
          setSettings(refreshed);
          setManagerLifecycle(refreshed.managerLifecycle);
        }
      } catch (failure) {
        if (!canceled) {
          setSettingsError(errorText(failure));
          setAccount(
            (failure instanceof ApiError ? failure.account : undefined)
              ?.auth === "chatgpt"
              ? `Signed in with ChatGPT · ${(failure instanceof ApiError ? failure.account?.plan : undefined) || "subscription"}. Saved chat could not be prepared.`
              : "Could not prepare the Codex connection.",
          );
          showError(failure);
        }
      }
      if (canceled) return;
      if (bootstrapRunning) await loadVoices();
      else {
        setVoiceLoading(false);
        setVoiceNotice("Start your manager to load available voices.");
      }
      if (canceled) return;
      try {
        const result = await api("orchestration");
        if (!canceled) setOrchestration(result);
      } catch (failure) {
        if (!canceled)
          setOrchestration((previous) => ({
            ...previous,
            loading: false,
            error: errorText(failure),
          }));
      }
    })();
    const pagehide = () => {
      voice.dispose();
      events.close();
      endVoiceBeacon();
    };
    window.addEventListener("pagehide", pagehide);
    return () => {
      canceled = true;
      events.close();
      window.removeEventListener("pagehide", pagehide);
      endVoiceBeacon();
    };
  }, [
    loadVoices,
    showError,
    voice.transportLost,
    voice.handleEvent,
    voice.dispose,
  ]);
}
