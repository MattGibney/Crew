import { useManagerConnection } from "./hooks/useManagerConnection.js";
import { useManagerSounds } from "./hooks/useManagerSounds.js";
import { useManagerRequests } from "./hooks/useManagerRequests.js";

import type {
  UpdateStatus,
  SettingsState,
  ManagerLifecycle,
  ProjectInfo,
  OrchestrationState,
  WorkerApproval,
  VoiceCatalog,
  ManagerAction,
  ManagerProfile,
  WorkerEnvironmentConfig,
} from "../contracts/manager.js";
import { useCallback, useRef, useState } from "react";
import { api, errorText } from "./api.js";
import { chooseVoice, EMPTY_WORK } from "./state.js";
import { resolveManagerVoice } from "./manager-voice.js";
import { useVoiceSession } from "./useVoiceSession.js";

// Backend state and transcript events remain evidence; they never initiate work or microphone capture.
export function useCrewManager() {
  const [error, setError] = useState("");
  const [updates, setUpdates] = useState<UpdateStatus | null>(null);
  const [settings, setSettings] = useState<SettingsState | null>(null),
    [settingsError, setSettingsError] = useState("");
  const [managerLifecycle, setManagerLifecycle] = useState<ManagerLifecycle>({
    state: "loading",
  });
  const lifecycleLock = useRef(false);
  const managerEnabled = managerLifecycle.state === "running";
  const [prepared, setPrepared] = useState(false),
    [eventReady, setEventReady] = useState(false);
  const [account, setAccount] = useState("Checking ChatGPT sign-in…");
  const [project, setProject] = useState("Loading this instance’s project…");
  const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null);
  const [work, setWork] = useState(EMPTY_WORK);
  const [orchestration, setOrchestration] = useState<OrchestrationState>({
    tasks: [],
    loading: true,
  });
  const [workerApprovals, setWorkerApprovals] = useState<WorkerApproval[]>([]);
  const [catalog, setCatalog] = useState<VoiceCatalog | null>(null),
    [selectedVoice, setSelectedVoice] = useState("");
  const [voiceLoading, setVoiceLoading] = useState(true),
    [voiceNotice, setVoiceNotice] = useState(
      "Loading available Codex voices. Microphone stays off.",
    );
  const { sounds, soundUnavailable, nativeAttentionSound } = useManagerSounds(
    work,
    orchestration,
    workerApprovals,
    projectInfo,
  );
  const voice = useVoiceSession(setError, sounds);
  const showError = useCallback(
    (value: unknown) => setError(errorText(value)),
    [],
  );
  const {
    sending,
    workNotice,
    setWorkNotice,
    reviewAttention,
    answerApproval,
    answerWorkerApproval,
    interruptManager,
    sendMessage,
    workerAction,
  } = useManagerRequests(managerEnabled, showError);
  const loadVoices = useCallback(async () => {
    setVoiceLoading(true);
    setVoiceNotice("Loading available Codex voices. Microphone stays off.");
    try {
      const [next, projectSettings] = await Promise.all([
        api("voices"),
        api("settings", {}, { method: "GET" }),
      ]);
      let storage;
      try {
        storage = window.localStorage;
      } catch {
        /* Disabled storage does not block the saved profile. */
      }
      const resolved = await resolveManagerVoice({
        catalog: next,
        profile: projectSettings.managerProfile,
        storage,
        save: async (input) => {
          const result = await api("settings/manager-profile", input, {
            method: "PUT",
          });
          setSettings(result);
          return result.managerProfile;
        },
      });
      setCatalog(next);
      setSelectedVoice(resolved.selected);
      setVoiceNotice(
        resolved.unavailable
          ? "Your saved voice is no longer available. Codex default selected for the next call."
          : "",
      );
    } catch (failure) {
      setCatalog(null);
      setVoiceNotice(
        `Could not load Codex voices: ${errorText(failure)} Retry before connecting.`,
      );
    } finally {
      setVoiceLoading(false);
    }
  }, []);
  const saveManagerProfile = useCallback(
    async (
      patch: Partial<ManagerProfile> | string | null,
      expectedVersion: string | null | undefined,
    ) => {
      const result = await api(
        "settings/manager-profile",
        {
          ...(patch && typeof patch === "object" ? patch : { voice: patch }),
          expectedVersion,
        },
        { method: "PUT" },
      );
      setSettings(result);
      if (catalog)
        setSelectedVoice(chooseVoice(catalog, result.managerProfile.voice));
      setVoiceNotice("");
      return result;
    },
    [catalog],
  );
  useManagerConnection({
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
  });
  const connect = useCallback(() => {
    if (
      !managerEnabled ||
      !prepared ||
      !eventReady ||
      !catalog ||
      voice.busy ||
      voice.allocated
    )
      return;
    setError("");
    void voice.connect(selectedVoice);
  }, [
    managerEnabled,
    prepared,
    eventReady,
    catalog,
    voice.busy,
    voice.allocated,
    voice.connect,
    selectedVoice,
  ]);
  const retryConnection = useCallback(async () => {
    setError("");
    setAccount("Reconnecting your saved chat…");
    try {
      const result = await api("prepare");
      setPrepared(true);
      setAccount(`Signed in with ChatGPT · ${result.plan || "subscription"}.`);
      if (result.state) setWork(result.state);
      const refreshed = await api("settings", {}, { method: "GET" });
      setSettings(refreshed);
      setManagerLifecycle(refreshed.managerLifecycle);
      setSettingsError("");
      await loadVoices();
    } catch (failure) {
      setPrepared(false);
      showError(failure);
    }
  }, [loadVoices, showError]);
  const loadSettings = useCallback(async () => {
    try {
      const result = await api("settings", {}, { method: "GET" });
      setSettings(result);
      setManagerLifecycle(result.managerLifecycle);
      setSettingsError("");
      return result;
    } catch (failure) {
      setSettingsError(errorText(failure));
      throw failure;
    }
  }, []);
  const savePrompt = useCallback(
    async (
      role: "manager" | "worker",
      text: string,
      expectedVersion: string,
    ) => {
      await api(
        "settings/prompts",
        { role, text, expectedVersion },
        { method: "PUT" },
      );
      return await loadSettings();
    },
    [loadSettings],
  );
  const saveWorkerEnvironment = useCallback(
    async (
      environment: WorkerEnvironmentConfig | null,
      expectedRevision: string | null,
    ) => {
      const result = await api(
        "settings/worker-environment",
        { environment, expectedRevision },
        { method: "PUT" },
      );
      setSettings(result);
      return result;
    },
    [],
  );
  const changeManagerLifecycle = useCallback(
    async (action: ManagerAction) => {
      if (lifecycleLock.current) return;
      lifecycleLock.current = true;
      setManagerLifecycle((previous) => ({
        ...previous,
        state:
          action === "start"
            ? "starting"
            : action === "stop"
              ? "stopping"
              : "restarting",
        error: "",
      }));
      try {
        if (action !== "start") {
          voice.dispose();
          await voice.disconnect("Manager stopped. Microphone off.");
        }
        const result = await api("manager/lifecycle", { action });
        if (result.managerLifecycle)
          setManagerLifecycle(result.managerLifecycle);
        if (result.state) setWork(result.state);
        await loadSettings();
        if (action !== "stop") {
          setError("");
          const preparedResult = await api("prepare");
          setPrepared(true);
          setAccount(
            `Signed in with ChatGPT · ${preparedResult.plan || "subscription"}. No API key used.`,
          );
          if (preparedResult.state) setWork(preparedResult.state);
          await loadSettings();
          await loadVoices();
        } else
          setAccount(
            "Manager stopped. Start explicitly to reconnect the saved conversation.",
          );
      } catch (failure) {
        try {
          await loadSettings();
        } catch {
          setManagerLifecycle((previous) => ({
            ...previous,
            state: "error",
            error: errorText(failure),
          }));
        }
        setSettingsError(errorText(failure));
        throw failure;
      } finally {
        lifecycleLock.current = false;
      }
    },
    [loadSettings, loadVoices, voice.dispose, voice.disconnect],
  );
  return {
    settings,
    settingsError,
    loadSettings,
    savePrompt,
    saveWorkerEnvironment,
    managerLifecycle,
    managerEnabled,
    changeManagerLifecycle,
    error,
    soundUnavailable,
    updates,
    project,
    projectInfo,
    account,
    prepared,
    eventReady,
    work,
    workNotice,
    orchestration,
    workerApprovals,
    answerWorkerApproval,
    catalog,
    selectedVoice,
    voiceLoading,
    voiceNotice,
    saveManagerProfile,
    loadVoices,
    voice,
    connect,
    reviewAttention,
    answerApproval,
    interruptManager,
    sending,
    sendMessage,
    workerAction,
    retryConnection,
  };
}
