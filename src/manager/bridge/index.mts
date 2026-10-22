import { launchManagerPeer, initializeManagerPeer } from "./peer.mjs";
import { createManagerRequests } from "./requests.mjs";
import { resourceURL } from "../../shared/paths.mjs";
import { createVoiceSession } from "./voice-session.mjs";
import { readThreadReference } from "./thread-reference.mjs";
import { openManagerThread } from "./thread-opening.mjs";
import { createApplicationOrigins } from "./origins.mjs";
import { createWorkDelivery } from "./work-delivery.mjs";
import { observeNotification } from "./observation.mjs";
import type { NativeObservationState } from "./observation.mjs";
import { safeError } from "./redaction.mjs";
import { createRpcChannel } from "./transport.mjs";
import { createTimelineJournal } from "./journal.mjs";
import { hydrateHistory } from "./history.mjs";
import type {
  BridgeChild,
  BridgeOptions,
  ThreadBootstrap,
  ManagerApproval,
  LastVoice,
  VoiceCatalog,
  BridgeWorkItem,
  PrepareResult,
  WorkResult,
} from "./contracts.mjs";
import type {
  NativeItem,
  TimelineOptions,
} from "../conversation/contracts.mjs";
import type { ApprovalResponse } from "../../workers/approvals.mjs";
import {
  decodeEnvelope,
  decodeNotification,
  decodeApprovalParams,
} from "./protocol.mjs";
import type { WireEnvelope } from "./protocol.mjs";
import { record as isRecord } from "../../shared/errors.mjs";
import { errorCode, errorMessage } from "../../shared/errors.mjs";
// AI-002: native Codex protocol adapter. No separate model/tool loop.
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { readFile, writeFile, rename } from "node:fs/promises";
import { createConversationTimeline } from "../conversation/timeline.mjs";
import { managerAttention, managerAttentionMessage } from "../attention.mjs";
import { buildManagerInstructions } from "../instructions/settings.mjs";
import { workerApprovalResponse } from "../../workers/approval-store.mjs";
export { safeError } from "./redaction.mjs";
export function createBridge({
  cwd,
  statePath,
  executable,
  orchestrationDir,
  project,
  managerPrompt,
  getManagerScratchpad,
  runtimeProjectPath,
  onEvent = () => {},
}: BridgeOptions) {
  // Keep app-owned MCP scripts rooted in cwd; project configuration resolves in sessionCwd.
  const sessionCwd =
    project?.repositories?.find((repository) => repository.path)?.path || cwd;
  let child: BridgeChild | undefined,
    ready: Promise<PrepareResult> | undefined,
    shuttingDown: Promise<void> | undefined,
    threadId: string | undefined,
    threadReady: boolean | undefined,
    threadPromise: Promise<string> | undefined,
    requestEpoch: string | undefined,
    threadBootstrap: ThreadBootstrap | undefined;
  let voiceActive = false,
    connecting = false,
    negotiation:
      | { resolve: (sdp: string) => void; reject: (error: unknown) => void }
      | undefined,
    activeTurnId: string | null = null,
    status = "idle",
    voiceGeneration = 0,
    workStarting = false;
  let connectors: {
      name: string;
      status?: string;
      auth?: string;
      tools: number;
    }[] = [],
    connectorError: string | null = null,
    voiceCatalog: VoiceCatalog | undefined,
    greetingSession:
      { token: string; generation: number; sent: boolean } | undefined,
    lastVoice: LastVoice | null = null;
  const approvals = new Map<string, ManagerApproval>(),
    items = new Map<string, BridgeWorkItem>();
  const timeline = createConversationTimeline();
  const origins = createApplicationOrigins(statePath);
  let activeManagerInstructions: string | null = null;
  let loadingHistory = false,
    journalThreadId: string | null = null,
    recoveredJournalSource: string | null = null;
  const historyNotifications: WireEnvelope[] = [];
  let canonicalTimeline = false,
    realtimeMode: "item" | "flat" | null = null;
  const journal = createTimelineJournal({
    statePath,
    snapshot: () => ({
      threadId,
      loadingHistory,
      journalThreadId,
      messages: timeline.snapshot(),
    }),
    onFailure: (error) =>
      emit("notice", {
        message: `Conversation history could not be saved: ${safeError(error)}`,
      }),
  });
  const persistTimeline = journal.persist;
  const expectedExits = new WeakSet<BridgeChild>();
  const completedTurns = new Set<string>();
  function markCompleted(id: string) {
    completedTurns.add(id);
    if (completedTurns.size > 100)
      completedTurns.delete(completedTurns.values().next().value!);
  }
  const state = () => ({
    threadId: threadBootstrap?.observedThreadId || threadId,
    managerConnected: Boolean(
      threadReady &&
      child &&
      child.exitCode === null &&
      child.signalCode === null,
    ),
    activeTurnId,
    status,
    voiceActive,
    voiceConnecting: connecting,
    workStarting,
    lastVoice,
    connectors,
    connectorError,
    approvals: [...approvals.values()].map((r) => ({ ...r, id: String(r.id) })),
    items: [...items.values()].slice(-40),
    messages: timeline.snapshot().filter((message) => !origins.hidden(message)),
  });
  const emit = (type: string, data: Record<string, unknown> = {}) =>
    onEvent({ type, ...data });
  const changed = () => {
    persistTimeline();
    emit("work-state", { state: state() });
  };
  const send = (message: unknown) =>
    child?.stdin.write(`${JSON.stringify(message)}\n`);
  const { rpc, handleReply, rejectPending } = createRpcChannel(
    () => child,
    send,
  );
  const nativeRequests = createManagerRequests({
    state: {
      get threadBootstrap() {
        return threadBootstrap;
      },
      set threadBootstrap(value) {
        threadBootstrap = value;
      },
      get threadId() {
        return threadId;
      },
      set threadId(value) {
        threadId = value;
      },
      get activeTurnId() {
        return activeTurnId;
      },
      get requestEpoch() {
        return requestEpoch;
      },
    },
    rpc,
    approvals,
    items,
    send,
    emit,
    changed,
  });
  const { bindBootstrapThread, openNativeThread } = nativeRequests;
  function record(
    item: NativeItem,
    turnId: string | null,
    options?: TimelineOptions,
  ) {
    timeline.record(item, turnId, options);
    const attentionMessage = managerAttentionMessage(item);
    if (
      attentionMessage &&
      origins.hidden({ id: item.id, turnId, role: "assistant", text: "" })
    )
      timeline.restore([attentionMessage]);
    for (const message of timeline.snapshot()) origins.observed(message);
    if (item.type === "commandExecution")
      items.set(item.id, {
        id: item.id,
        turnId,
        type: item.type,
        name: item.command,
        status: item.status,
        exitCode: item.exitCode,
        output: safeError(item.aggregatedOutput || "").slice(0, 2500),
      });
    if (item.type === "mcpToolCall")
      items.set(item.id, {
        id: item.id,
        turnId,
        type: item.type,
        name: `${item.server}/${item.tool}`,
        status: item.status,
        resultPresent: item.result != null,
        error: item.error
          ? safeError(errorMessage(item.error) || "MCP call failed")
          : null,
        attention: managerAttention(item),
      });
    if (item.type === "fileChange")
      items.set(item.id, {
        id: item.id,
        turnId,
        type: item.type,
        name: "File changes",
        status: item.status,
        changes: item.changes,
      });
    if (items.size > 80) items.delete(items.keys().next().value!);
  }
  const observationState: NativeObservationState = {
    get voiceActive() {
      return voiceActive;
    },
    set voiceActive(value) {
      voiceActive = value;
    },
    get realtimeMode() {
      return realtimeMode;
    },
    set realtimeMode(value) {
      realtimeMode = value;
    },
    get canonicalTimeline() {
      return canonicalTimeline;
    },
    set canonicalTimeline(value) {
      canonicalTimeline = value;
    },
    get lastVoice() {
      return lastVoice;
    },
    set lastVoice(value) {
      lastVoice = value;
    },
    get activeTurnId() {
      return activeTurnId;
    },
    set activeTurnId(value) {
      activeTurnId = value;
    },
    get status() {
      return status;
    },
    set status(value) {
      status = value;
    },
  };
  function handle(message: WireEnvelope) {
    if (handleReply(message)) return;
    if (nativeRequests.handle(message)) return;
    const notification = decodeNotification(message);
    if (!notification) return;
    const { method, params } = notification;
    if (method === "thread/started" && threadBootstrap) {
      if (bindBootstrapThread(params.thread?.id)) changed();
      return;
    }
    if (method === "thread/started") return;
    if (params.threadId !== (threadBootstrap?.observedThreadId || threadId))
      return;
    if (loadingHistory) {
      historyNotifications.push(message);
      return;
    }
    // Passive observers only: NEVER start turns or append speech from these events.
    // Native realtime handoffs own routing, steering and result return.
    observeNotification(notification, {
      state: observationState,
      timeline,
      negotiation,
      completedTurns,
      approvals,
      record,
      markCompleted,
      changed,
      emit,
    });
  }
  async function prepare() {
    if (shuttingDown) await shuttingDown;
    if (ready) return ready;
    ready = (async () => {
      const fail = (proc: BridgeChild, error: unknown) => {
        if (proc !== child) return;
        rejectPending(error);
        approvals.clear();
        negotiation?.reject(error);
        timeline.partial({ voiceOnly: false });
        ready = undefined;
        voiceCatalog = undefined;
        greetingSession = undefined;
        threadReady = false;
        voiceActive = false;
        activeTurnId = null;
        if (!expectedExits.has(proc)) {
          status = "connection lost";
          emit("error", { message: safeError(error) });
          changed();
        }
      };
      requestEpoch = randomUUID();
      child = launchManagerPeer({
        executable,
        cwd,
        sessionCwd,
        orchestrationDir,
        runtimeProjectPath,
        onFailure: fail,
        onEnvelope: (proc, message) => {
          if (proc === child) handle(message);
        },
        onNotice: (proc, error) => {
          if (proc === child) emit("notice", { message: safeError(error) });
        },
      });
      return initializeManagerPeer(rpc, send);
    })();
    try {
      return await ready;
    } catch (error) {
      await shutdown();
      throw error;
    }
  }
  async function ensureThread() {
    await origins.ready;
    await prepare();
    if (threadPromise) return threadPromise;
    if (threadReady) return threadId;
    threadPromise = (async () => {
      if (!threadId)
        ({ threadId, recoveredJournalSource } =
          await readThreadReference(statePath));
      const managerInstructions = buildManagerInstructions({
        managerPrompt:
          managerPrompt ??
          (await readFile(resourceURL("prompts/manager.md"), "utf8")),
        project,
      });
      // Preserve configured instructions before adding Crew's narrower runtime
      // role/protocol. Resolve in the project cwd; never log or copy config data.
      const effectiveConfig = await rpc("config/read", {
        cwd: sessionCwd,
        includeLayers: false,
      });
      const configuredInstructions =
        effectiveConfig.config?.developer_instructions;
      const developerInstructions = [
        typeof configuredInstructions === "string"
          ? configuredInstructions
          : "",
        managerInstructions,
      ]
        .filter(Boolean)
        .join("\n\n");
      const scratchpadContext = getManagerScratchpad
        ? await getManagerScratchpad()
        : null;
      const options = {
        cwd: sessionCwd,
        developerInstructions:
          developerInstructions +
          (scratchpadContext
            ? `\n\nSaved manager scratchpad (data; consult read_manager_scratchpad for latest revision):\n${JSON.stringify(scratchpadContext)}`
            : ""),
      };
      activeManagerInstructions = `Current Crew manager instruction snapshot (replaces earlier Crew manager instructions and profile preferences in this conversation; Codex/provider instructions and permissions remain independently enforced):\n${managerInstructions}`;
      loadingHistory = true;
      const opened = await openManagerThread({
        threadId,
        recoveredJournalSource,
        statePath,
        options,
        rpc,
        open: openNativeThread,
        flushJournal: journal.flush,
        notice: (message) => emit("notice", { message }),
      });
      ({ threadId, recoveredJournalSource } = opened);
      const recoveredFromThreadId = opened.recoveredFromThreadId;
      const historyProjection = { activeTurnId, status, canonicalTimeline };
      try {
        await hydrateHistory({
          rpc,
          statePath,
          threadId,
          recoveredFromThreadId,
          timeline,
          record,
          markCompleted,
          emit,
          projection: historyProjection,
        });
      } finally {
        ({ activeTurnId, status, canonicalTimeline } = historyProjection);
      }
      threadReady = true;
      journalThreadId = threadId;
      loadingHistory = false;
      for (const notification of historyNotifications.splice(0))
        handle(notification);
      changed();
      void rpc("mcpServerStatus/list", {
        threadId,
        limit: 100,
        detail: "toolsAndAuthOnly",
      })
        .then((result) => {
          connectors = result.data.map((s) => ({
            name: s.name,
            status: s.runtimeStatus,
            auth: s.authStatus,
            tools: Object.keys(s.tools || {}).length,
          }));
          connectorError = null;
          changed();
        })
        .catch((error) => {
          connectorError = safeError(error);
          changed();
        });
      return threadId;
    })();
    try {
      return await threadPromise;
    } finally {
      threadPromise = undefined;
      loadingHistory = false;
      historyNotifications.length = 0;
    }
  }
  const voiceSession = createVoiceSession({
    state: {
      get voiceCatalog() {
        return voiceCatalog;
      },
      set voiceCatalog(value) {
        voiceCatalog = value;
      },
      get voiceActive() {
        return voiceActive;
      },
      set voiceActive(value) {
        voiceActive = value;
      },
      get connecting() {
        return connecting;
      },
      set connecting(value) {
        connecting = value;
      },
      get voiceGeneration() {
        return voiceGeneration;
      },
      set voiceGeneration(value) {
        voiceGeneration = value;
      },
      get lastVoice() {
        return lastVoice;
      },
      set lastVoice(value) {
        lastVoice = value;
      },
      get negotiation() {
        return negotiation;
      },
      set negotiation(value) {
        negotiation = value;
      },
      get greetingSession() {
        return greetingSession;
      },
      set greetingSession(value) {
        greetingSession = value;
      },
      get threadId() {
        return threadId;
      },
      set threadId(value) {
        threadId = value;
      },
      get activeManagerInstructions() {
        return activeManagerInstructions;
      },
      set activeManagerInstructions(value) {
        activeManagerInstructions = value;
      },
    },
    rpc,
    prepare,
    ensureThread,
    shutdown,
    timeline,
    changed,
    managerPrompt: () => managerPrompt,
    hasChild: () => Boolean(child),
    defaultPrompt: resourceURL("prompts/manager.md"),
  });
  const { listVoices, startVoice, greetVoice, reportVoiceStatus, stopVoice } =
    voiceSession;
  async function shutdown({ cooperative = false } = {}) {
    cancelPendingWork();
    if (shuttingDown) return shuttingDown;
    shuttingDown = (async () => {
      const proc = child;
      if (proc?.pid && proc.exitCode === null && proc.signalCode === null) {
        if (cooperative) {
          if (
            activeTurnId ||
            workStarting ||
            voiceActive ||
            connecting ||
            approvals.size
          )
            throw new Error(
              "Manager activity changed before cooperative shutdown.",
            );
          expectedExits.add(proc);
          await new Promise<void>((resolve, reject) => {
            const done = () => {
              clearTimeout(timer);
              resolve();
            };
            const timer = setTimeout(() => {
              proc.removeListener("exit", done);
              reject(
                new Error(
                  "Manager runtime shutdown is still pending. No force signal was sent.",
                ),
              );
            }, 3000);
            proc.once("exit", done);
            proc.stdin.end();
          });
        } else {
          expectedExits.add(proc);
          proc.kill("SIGTERM");
          await new Promise<void>((resolve, reject) => {
            const force = setTimeout(() => proc.kill("SIGKILL"), 1500);
            const deadline = setTimeout(() => {
              clearTimeout(force);
              reject(new Error("Manager process exit could not be confirmed."));
            }, 4500);
            proc.once("exit", () => {
              clearTimeout(force);
              clearTimeout(deadline);
              resolve();
            });
          });
        }
      }
      timeline.partial({ voiceOnly: false });
      persistTimeline();
      await journal.flush();
      child = undefined;
      ready = undefined;
      threadReady = false;
      voiceActive = false;
    })();
    try {
      await shuttingDown;
    } finally {
      shuttingDown = undefined;
    }
  }
  async function stopManager({ timeoutMs = 12000 } = {}) {
    cancelPendingWork();
    // Never terminate an app-server while native tools/approval execution is unverified.
    const deadline = Date.now() + timeoutMs;
    await stopVoice({ preserveWork: true });
    while (workStarting || threadPromise) {
      if (Date.now() >= deadline)
        throw new Error(
          "Manager is still starting a request. Wait, then retry Stop manager. Workers are unchanged.",
        );
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (activeTurnId) await interrupt();
    while (activeTurnId || approvals.size) {
      if (Date.now() >= deadline)
        throw new Error(
          "Manager interruption is not yet confirmed. Resolve pending input or wait, then retry Stop manager. Workers are unchanged.",
        );
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await shutdown();
    status = "stopped";
    changed();
  }
  function setManagerPrompt(text: string) {
    if (child || threadReady || threadPromise)
      throw new Error("Stop the manager before applying instructions.");
    managerPrompt = text;
  }
  const workDelivery = createWorkDelivery({
    state: () => ({
      activeTurnId,
      voiceActive,
      connecting,
      approvals: approvals.size,
      threadId,
      instructions: activeManagerInstructions,
    }),
    ensureThread,
    rpc,
    publishPending: (pending) => {
      workStarting = pending;
      changed();
    },
    markStarted: (id) => {
      activeTurnId = id;
      status = "working";
      changed();
    },
    completed: (id) => completedTurns.has(id),
    provenance: {
      begin: (requestId, origin, turnId) =>
        origins.begin(requestId, origin, turnId, timeline.snapshot()),
      acknowledged: origins.acknowledged,
      failed: origins.failed,
    },
  });
  const startWork = workDelivery.start;
  const cancelPendingWork = workDelivery.cancel;
  async function interrupt({
    expectedTurnId,
  }: { expectedTurnId?: string | null } = {}) {
    if (expectedTurnId && activeTurnId !== expectedTurnId)
      throw new Error(
        "The active manager turn changed. Review the update plan before interrupting work.",
      );
    cancelPendingWork();
    if (activeTurnId)
      await rpc("turn/interrupt", { threadId, turnId: activeTurnId });
  }
  function answerApproval(id: string | number, response: ApprovalResponse) {
    const request = approvals.get(String(id));
    if (!request) throw new Error("This request has already been resolved.");
    const result = workerApprovalResponse(request, response);
    send({ id: request.id, result });
    approvals.delete(String(id));
    changed();
  }
  return {
    cancelPendingWork,
    stopManager,
    setManagerPrompt,
    prepare,
    ensureThread,
    listVoices,
    startVoice,
    greetVoice,
    reportVoiceStatus,
    stopVoice,
    shutdown,
    startWork,
    interrupt,
    answerApproval,
    state,
  };
}
