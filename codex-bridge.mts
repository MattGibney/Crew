import { observeNotification } from "./bridge/observation.mjs";
import type { NativeObservationState } from "./bridge/observation.mjs";
import { safeError } from "./bridge/redaction.mjs";
import { createRpcChannel } from "./bridge/transport.mjs";
import { createTimelineJournal } from "./bridge/journal.mjs";
import { hydrateHistory } from "./bridge/history.mjs";
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
} from "./bridge/contracts.mjs";
import type { NativeItem, TimelineOptions } from "./shared/conversation.mjs";
import type { ApprovalResponse } from "./execution/approvals.mjs";
import {
  decodeEnvelope,
  decodeNotification,
  decodeApprovalParams,
} from "./bridge/protocol.mjs";
import type { WireEnvelope } from "./bridge/protocol.mjs";
import { record as isRecord } from "./shared/errors.mjs";
import { errorCode, errorMessage } from "./shared/errors.mjs";
// AI-002: native Codex protocol adapter. No separate model/tool loop.
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { readFile, writeFile, rename } from "node:fs/promises";
import { createConversationTimeline } from "./conversation-timeline.mjs";
import { managerAttention } from "./manager-attention.mjs";
import { buildManagerInstructions } from "./prompt-settings.mjs";
import { workerApprovalResponse } from "./worker-approvals.mjs";
export { safeError } from "./bridge/redaction.mjs";
export function createBridge({
  cwd,
  statePath,
  executable,
  orchestrationDir,
  project,
  managerPrompt,
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
      | { token: string; generation: number; sent: boolean }
      | undefined,
    lastVoice: LastVoice | null = null;
  const approvals = new Map<string, ManagerApproval>(),
    items = new Map<string, BridgeWorkItem>(),
    workRequests = new Map<string, Promise<WorkResult>>();
  const timeline = createConversationTimeline();
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
    messages: timeline.snapshot(),
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
  function bindBootstrapThread(id: unknown) {
    if (!threadBootstrap || typeof id !== "string" || !/^[\w-]+$/.test(id))
      return false;
    if (
      (threadBootstrap.expectedThreadId &&
        id !== threadBootstrap.expectedThreadId) ||
      (threadBootstrap.observedThreadId &&
        id !== threadBootstrap.observedThreadId)
    )
      return false;
    threadBootstrap.observedThreadId = id;
    return true;
  }
  async function openNativeThread(
    method: "thread/resume" | "thread/start" | "thread/fork",
    params: Record<string, unknown>,
  ) {
    const bootstrap: ThreadBootstrap = {
      expectedThreadId:
        method === "thread/resume" && typeof params.threadId === "string"
          ? params.threadId
          : null,
      observedThreadId: null,
      approvals: new Map<string, ManagerApproval>(),
    };
    threadBootstrap = bootstrap;
    let opened = false;
    try {
      const result = await rpc(method, params);
      if (!bindBootstrapThread(result.thread?.id))
        throw new Error(
          "Native manager thread startup correlation mismatch; pending requests were not answered automatically.",
        );
      threadId = result.thread.id;
      opened = true;
      return result;
    } finally {
      if (threadBootstrap === bootstrap) threadBootstrap = undefined;
      if (!opened) {
        let cleared = false;
        for (const [id, request] of bootstrap.approvals)
          if (approvals.get(id) === request) {
            approvals.delete(id);
            cleared = true;
          }
        if (cleared) {
          emit("notice", {
            message:
              "Native manager startup did not complete; its pending requests are no longer actionable. No response was sent automatically.",
          });
          changed();
        }
      }
    }
  }
  function record(
    item: NativeItem,
    turnId: string | null,
    options?: TimelineOptions,
  ) {
    timeline.record(item, turnId, options);
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
    if (message.id !== undefined && message.method) {
      const method = message.method;
      const rawParams = message.params || {};
      if (method === "currentTime/read")
        return send({
          id: message.id,
          result: { currentTimeAt: Math.floor(Date.now() / 1000) },
        });
      const params = [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/tool/requestUserInput",
        "mcpServer/elicitation/request",
        "item/permissions/requestApproval",
      ].includes(method)
        ? decodeApprovalParams(rawParams)
        : null;
      if (!params) {
        send({
          id: message.id,
          error: {
            code: -32601,
            message: `This minimal client does not support ${method}. No action was approved.`,
          },
        });
        emit("notice", {
          message: `Codex requested ${method}, which this client cannot handle.`,
        });
        return;
      }
      const requestThreadMatches = threadBootstrap
        ? (Boolean(threadBootstrap.observedThreadId) &&
            params.threadId === threadBootstrap.observedThreadId) ||
          (!threadBootstrap.observedThreadId &&
            method === "mcpServer/elicitation/request" &&
            bindBootstrapThread(params.threadId))
        : params.threadId === threadId;
      if (
        requestThreadMatches &&
        [
          "item/commandExecution/requestApproval",
          "item/fileChange/requestApproval",
          "item/tool/requestUserInput",
          "mcpServer/elicitation/request",
          "item/permissions/requestApproval",
        ].includes(method)
      ) {
        const attentionId =
          approvals.get(String(message.id))?.attentionId ||
          createHash("sha256")
            .update(
              JSON.stringify([
                params.turnId ||
                  items.get(
                    typeof params.itemId === "string" ? params.itemId : "",
                  )?.turnId ||
                  activeTurnId ||
                  requestEpoch,
                params.itemId || "",
                method,
                String(message.id),
              ]),
            )
            .digest("hex");
        const request = { id: message.id, attentionId, method, params };
        approvals.set(String(message.id), request);
        threadBootstrap?.approvals.set(String(message.id), request);
        changed();
        return;
      }
      send({
        id: message.id,
        error: {
          code: -32601,
          message: `This minimal client does not support ${method}. No action was approved.`,
        },
      });
      emit("notice", {
        message: `Codex requested ${method}, which this client cannot handle.`,
      });
      return;
    }
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
      const env = { ...process.env };
      for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"])
        delete env[key];
      const args = [
        "app-server",
        "--stdio",
        "-c",
        'forced_login_method="chatgpt"',
        "-c",
        'model_provider="openai"',
      ];
      if (orchestrationDir)
        args.push(
          "-c",
          `mcp_servers.local_orchestration.command=${JSON.stringify(process.execPath)}`,
          "-c",
          `mcp_servers.local_orchestration.args=${JSON.stringify([`${cwd}/orchestration-mcp.mjs`, orchestrationDir, "manager", ...(runtimeProjectPath ? [runtimeProjectPath] : [])])}`,
          "-c",
          "mcp_servers.local_orchestration.required=true",
          "-c",
          'mcp_servers.local_orchestration.default_tools_approval_mode="approve"',
        );
      if (orchestrationDir && process.env.ELECTRON_RUN_AS_NODE === "1")
        args.push(
          "-c",
          'mcp_servers.local_orchestration.env.ELECTRON_RUN_AS_NODE="1"',
        );
      requestEpoch = randomUUID();
      child = spawn(executable, args, {
        cwd: sessionCwd,
        env,
        stdio: ["pipe", "pipe", "ignore"],
      });
      const proc = child;
      const fail = (error: unknown) => {
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
      proc.on("error", fail);
      proc.on("exit", () =>
        fail(
          new Error("Codex process stopped. Reconnect to resume this chat."),
        ),
      );
      createInterface({ input: proc.stdout }).on("line", (line) => {
        if (proc !== child) return;
        try {
          handle(decodeEnvelope(JSON.parse(line)));
        } catch (error) {
          emit("notice", { message: safeError(error) });
        }
      });
      await rpc("initialize", {
        clientInfo: { name: "crew_manager", version: "0.6.0" },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          mcpServerOpenaiFormElicitation: true,
        },
      });
      send({ method: "initialized", params: {} });
      const { account } = await rpc("account/read", { refreshToken: false });
      if (account?.type !== "chatgpt")
        throw new Error(
          "ChatGPT sign-in required. API-key authentication is not allowed.",
        );
      return { auth: account.type, plan: account.planType };
    })();
    try {
      return await ready;
    } catch (error) {
      await shutdown();
      throw error;
    }
  }
  async function ensureThread() {
    await prepare();
    if (threadPromise) return threadPromise;
    if (threadReady) return threadId;
    threadPromise = (async () => {
      if (!threadId) {
        try {
          const reference: unknown = JSON.parse(
            await readFile(statePath, "utf8"),
          );
          if (!isRecord(reference))
            throw new Error("Invalid saved chat reference.");
          threadId =
            typeof reference.threadId === "string"
              ? reference.threadId
              : undefined;
          if (typeof threadId !== "string" || !/^[\w-]+$/.test(threadId))
            throw new Error("Invalid saved chat ID.");
          if (
            reference.reason === "saved_chat_writer_conflict" &&
            typeof reference.previousThreadId === "string" &&
            /^[\w-]+$/.test(reference.previousThreadId) &&
            reference.previousThreadId !== threadId &&
            typeof reference.recoveredAt === "string" &&
            Number.isFinite(Date.parse(reference.recoveredAt))
          ) {
            const sourceId =
              reference.journalSourceThreadId ?? reference.previousThreadId;
            if (
              typeof sourceId === "string" &&
              /^[\w-]+$/.test(sourceId) &&
              sourceId !== threadId
            )
              recoveredJournalSource = sourceId;
          }
        } catch (error) {
          if (errorCode(error) !== "ENOENT")
            throw new Error(
              "Cannot read the saved chat reference. It has not been replaced.",
            );
        }
      }
      const managerInstructions = buildManagerInstructions({
        managerPrompt:
          managerPrompt ??
          (await readFile(
            new URL("./prompts/manager.md", import.meta.url),
            "utf8",
          )),
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
      const options = { cwd: sessionCwd, developerInstructions };
      let result,
        recoveredFromThreadId = recoveredJournalSource;
      loadingHistory = true;
      if (threadId) {
        try {
          result = await openNativeThread("thread/resume", {
            threadId,
            excludeTurns: true,
            ...options,
          });
        } catch (error) {
          if (!/already has an active writer/.test(errorMessage(error)))
            throw error;
          const previousThreadId = threadId;
          const source = await rpc("thread/read", {
            threadId,
            includeTurns: false,
          });
          const recent = await rpc("thread/turns/list", {
            threadId,
            limit: 1,
            itemsView: "notLoaded",
            sortDirection: "desc",
          });
          if (
            source.thread.status?.type === "active" ||
            recent.data.some((turn) => turn.status === "inProgress")
          )
            throw new Error(
              "ChatGPT is signed in, but the saved manager chat is active in another Codex client. Finish that work before reconnecting.",
            );
          // Native history-preserving fork avoids terminating the owning desktop runtime.
          // It starts no turn; controller task files remain the same source of execution state.
          result = await openNativeThread("thread/fork", {
            threadId,
            ...options,
            excludeTurns: true,
            ephemeral: false,
            deferGoalContinuation: true,
          });
          await journal.flush();
          let journalSourceThreadId =
            recoveredJournalSource || previousThreadId;
          try {
            const journal: unknown = JSON.parse(
              await readFile(`${statePath}.conversation.json`, "utf8"),
            );
            if (
              isRecord(journal) &&
              typeof journal.threadId === "string" &&
              (journal.threadId === previousThreadId ||
                journal.threadId === recoveredJournalSource)
            )
              journalSourceThreadId = journal.threadId;
          } catch {
            /* Overlay loading below reports unreadable history without replacing it. */
          }
          const reference = {
            threadId: result.thread.id,
            previousThreadId,
            journalSourceThreadId,
            recoveredAt: new Date().toISOString(),
            reason: "saved_chat_writer_conflict",
          };
          await writeFile(
            `${statePath}.tmp`,
            JSON.stringify(reference) + "\n",
            { mode: 0o600 },
          );
          await rename(`${statePath}.tmp`, statePath);
          threadId = result.thread.id;
          recoveredJournalSource = journalSourceThreadId;
          recoveredFromThreadId = recoveredJournalSource;
          await rpc("thread/name/set", { threadId, name: "Crew work chat" });
          emit("notice", {
            message:
              "The saved manager chat was held by another Codex client. Continued from its preserved history; the original chat and worker state are retained.",
          });
        }
      } else {
        result = await openNativeThread("thread/start", {
          ...options,
          ephemeral: false,
        });
        threadId = result.thread.id;
        await writeFile(
          `${statePath}.tmp`,
          JSON.stringify({ threadId }) + "\n",
          { mode: 0o600 },
        );
        await rename(`${statePath}.tmp`, statePath);
        await rpc("thread/name/set", { threadId, name: "Crew work chat" });
      }
      threadId = result.thread.id;
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
  async function listVoices() {
    await prepare();
    if (voiceCatalog) return voiceCatalog;
    const { voices } = await rpc("thread/realtime/listVoices");
    if (
      !Array.isArray(voices?.v3) ||
      !voices.v3.length ||
      !voices.v3.every(
        (id) => typeof id === "string" && /^[a-z][a-z0-9_-]{0,60}$/.test(id),
      ) ||
      !voices.v3.includes(voices.defaultV1)
    )
      throw new Error(
        "Codex did not return a usable v3 voice catalog. Try loading voices again.",
      );
    voiceCatalog = {
      voices: [...new Set(voices.v3)].map((id) => ({
        id,
        name: id.charAt(0).toUpperCase() + id.slice(1),
      })),
      defaultVoice: voices.defaultV1,
    };
    return voiceCatalog;
  }
  async function startVoice(sdp: string, selectedVoice?: string) {
    if (connecting || voiceActive)
      throw new Error("A voice session is already active or connecting.");
    connecting = true;
    const attempt = ++voiceGeneration;
    let startRequested = false;
    try {
      await ensureThread();
      const catalog = await listVoices();
      const voice =
        selectedVoice === undefined || selectedVoice === ""
          ? catalog.defaultVoice
          : selectedVoice;
      if (
        typeof voice !== "string" ||
        !catalog.voices.some((item) => item.id === voice)
      )
        throw new Error("Choose a supported Codex voice before connecting.");
      if (attempt !== voiceGeneration)
        throw new Error("Voice connection cancelled.");
      lastVoice = {
        voice,
        requestedAt: new Date().toISOString(),
        inputTranscriptEvents: 0,
        outputTranscriptEvents: 0,
        error: null,
        browser: null,
      };
      const answer = new Promise<string>((resolve, reject) => {
        negotiation = { resolve, reject };
      });
      answer.catch(() => {});
      const timer = setTimeout(
        () =>
          negotiation?.reject(
            new Error("No WebRTC answer arrived within 40 seconds."),
          ),
        40000,
      );
      try {
        startRequested = true;
        await rpc("thread/realtime/start", {
          threadId,
          transport: { type: "webrtc", sdp },
          outputModality: "audio",
          version: "v3",
          voice,
          initialItems: [
            {
              role: "developer",
              text: `${managerPrompt ?? (await readFile(new URL("./prompts/manager.md", import.meta.url), "utf8"))}\n\nVoice runtime event (data): a new voice session is starting. Selected voice name: ${catalog.voices.find((item) => item.id === voice)!.name}. This is connection context, not a user work request.`,
            },
          ],
          clientManagedHandoffs: false,
          includeStartupContext: true,
        });
        const responseSdp = await answer;
        if (attempt !== voiceGeneration)
          throw new Error("Voice connection cancelled.");
        greetingSession = {
          token: randomUUID(),
          generation: attempt,
          sent: false,
        };
        return {
          sdp: responseSdp,
          threadId,
          sessionToken: greetingSession.token,
        };
      } finally {
        clearTimeout(timer);
        negotiation = undefined;
      }
    } catch (error) {
      if (attempt === voiceGeneration && startRequested) await stopVoice();
      throw error;
    } finally {
      connecting = false;
    }
  }
  async function greetVoice(sessionToken: string) {
    const session = greetingSession;
    if (
      !session ||
      session.token !== sessionToken ||
      session.generation !== voiceGeneration ||
      !voiceActive
    )
      throw new Error("This voice call is no longer active.");
    if (session.sent) return { requested: true };
    // Claim once: duplicate connection events cannot repeat startup acknowledgement.
    session.sent = true;
    if (lastVoice) lastVoice.voiceReadyAt = new Date().toISOString();
    // Startup behavior is in the active editable prompt. Connection acknowledgement
    // must not append a second hidden behavior instruction or synthetic user turn.
    return { requested: true };
  }
  function reportVoiceStatus(sessionToken: string, data: unknown = {}) {
    if (
      !greetingSession ||
      greetingSession.token !== sessionToken ||
      greetingSession.generation !== voiceGeneration ||
      !voiceActive
    )
      return { recorded: false };
    if (!isRecord(data)) return { recorded: false };
    const snapshot: Record<string, string | number | boolean | null> = {};
    const allowed = [
      "connection",
      "ice",
      "channel",
      "inputSource",
      "localTrack",
      "localEnabled",
      "localMuted",
      "remoteTrack",
      "audioPaused",
      "audioMuted",
      "audioVolume",
      "audioReady",
      "playbackError",
      "packetsSent",
      "packetsReceived",
      "bytesSent",
      "bytesReceived",
      "inputEnergy",
    ];
    for (const key of allowed) {
      const value = data[key];
      if (
        value === null ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
      )
        snapshot[key] = value;
      else if (typeof value === "string")
        snapshot[key] = safeError(value).slice(0, 200);
    }
    if (lastVoice)
      lastVoice.browser = { ...snapshot, at: new Date().toISOString() };
    return { recorded: true };
  }
  async function stopVoice({ preserveWork = true, cooperative = false } = {}) {
    greetingSession = undefined;
    voiceGeneration++;
    if (child && threadId && (voiceActive || connecting)) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          rpc("thread/realtime/stop", { threadId }),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Voice stop timed out.")),
              3000,
            );
          }),
        ]);
      } catch (error) {
        if (cooperative)
          throw new Error(
            `Voice shutdown could not be confirmed: ${safeError(error)}`,
          );
        if (preserveWork) throw error;
        await shutdown();
      } finally {
        clearTimeout(timer);
      }
    }
    timeline.partial();
    voiceActive = false;
    negotiation?.reject(new Error("Disconnected."));
    changed();
  }
  async function shutdown({ cooperative = false } = {}) {
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
  async function startWork(text: string, requestId: string) {
    // Explicit diagnostic/user request only. NEVER called by transcript/handoff events.
    if (workRequests.has(requestId)) return workRequests.get(requestId)!;
    const result = (async () => {
      if (activeTurnId || workStarting)
        throw new Error(
          "Codex is already working. Use voice to steer it or Stop work.",
        );
      workStarting = true;
      changed();
      try {
        await ensureThread();
        // Resumed history can reveal an already active native turn. Never launch
        // a replacement merely because it was unknown before thread loading.
        if (activeTurnId)
          throw new Error(
            "Codex is already working. Use voice to steer it or Stop work.",
          );
        const result = await rpc("turn/start", {
          threadId,
          clientUserMessageId: requestId,
          input: [{ type: "text", text }],
        });
        // The response may arrive before turn/started, or after turn/completed.
        // Close the former idle gap without resurrecting the latter finished turn.
        if (
          result?.turn?.status === "inProgress" &&
          !completedTurns.has(result.turn.id) &&
          !activeTurnId
        ) {
          activeTurnId = result.turn.id;
          status = "working";
          changed();
        }
        return result;
      } finally {
        workStarting = false;
        changed();
      }
    })();
    workRequests.set(requestId, result);
    result.catch(() => {
      if (workRequests.get(requestId) === result)
        workRequests.delete(requestId);
    });
    if (workRequests.size > 100)
      workRequests.delete(workRequests.keys().next().value!);
    return result;
  }
  async function interrupt({
    expectedTurnId,
  }: { expectedTurnId?: string | null } = {}) {
    if (expectedTurnId && activeTurnId !== expectedTurnId)
      throw new Error(
        "The active manager turn changed. Review the update plan before interrupting work.",
      );
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
