import { createRunnerDirections } from "./runner-directions.mjs";
import { createRunnerPreparation } from "./runner-preparation.mjs";
import { createRunnerControl } from "./runner-control.mjs";
import { createWorkerPeer } from "./worker-peer.mjs";
import {
  parseWorkerConfiguration,
  type WorkerNativeMessage,
  type WorkerNativeParams,
  type WorkerStopRequest,
} from "./worker-protocol.mjs";
import type { StopEvidence } from "../processes/ownership.mjs";
import type { ApprovalRecord } from "./approvals.mjs";
import { errorMessage as describeError } from "./errors.mjs";
import { requireWorkerModel } from "./model-selection.mjs";
// Detached per-run supervisor: survives controller/browser/voice closure.
import {
  readFile,
  writeFile,
  rename,
  open,
  appendFile,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  OwnedProcessTree,
  snapshotProcesses,
} from "../processes/ownership.mjs";
import { buildWorkerInstructions } from "../manager/instructions/settings.mjs";
import { waitOwnedNatural } from "../processes/cooperative.mjs";
import {
  recordWorkerRequest,
  markWorkerRequestResolved,
  invalidateWorkerRequests,
} from "./approval-store.mjs";
const configPath = process.argv[2];
const config = parseWorkerConfiguration(
  JSON.parse(await readFile(configPath, "utf8")),
);
const runDir = path.dirname(configPath);
async function atomic(name: string, value: unknown) {
  const file = path.join(runDir, name),
    temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, file);
}
const claim = await open(path.join(runDir, "runner.claim"), "wx", 0o600);
await claim.close();
await atomic("started.json", {
  runId: config.runId,
  pid: process.pid,
  at: new Date().toISOString(),
});
const finalFile = path.join(runDir, "final.txt");
const fixturePrompt = `${buildWorkerInstructions({ ...config, project: config.project || undefined, environment: config.environment || undefined, modelSelection: config.modelSelection || undefined })}
Disposable fixture acceptance procedure (task data): Inspect only this fixture worktree. Run node importing ./src/totals.mjs and print JSON {emptyActual:sum([]),sumActual:sum([1,2,3])}. Verify the Git root and tracked files with real commands. In the result report's evidence array include one JSON string {"emptyActual":NUMBER,"sumActual":NUMBER,"emptyExpected":NUMBER,"sumExpected":NUMBER,"finding":"initial_value_one"}. Expected additive totals are 0 and 6 unless the relayed answer explicitly selects a base fee of 1 (then 1 and 7). Explain the observed difference in the result. The controller independently checks these fixture values.`;
const repositoryPrompt = buildWorkerInstructions({
  ...config,
  project: config.project || undefined,
  environment: config.environment || undefined,
  modelSelection: config.modelSelection || undefined,
});
const selectedModel = config.modelSelection?.model || null;
let modelWrites = Promise.resolve();
const modelEvidence = (
  status: string,
  message: string,
  extra: Record<string, unknown> = {},
) => {
  if (!selectedModel) return Promise.resolve();
  const evidence = {
    runId: config.runId,
    requestId: config.modelSelection?.id,
    requestedModel: selectedModel,
    threadId,
    turnId,
    status,
    message,
    ...extra,
    at: new Date().toISOString(),
  };
  modelWrites = modelWrites.then(() =>
    atomic("model-selection.json", evidence),
  );
  return modelWrites;
};
const prompt =
  config.project?.mode === "repository" ? repositoryPrompt : fixturePrompt;
let modelTurnAcknowledged = false,
  modelEventBytes = 0;
const pendingModelEvents: WorkerNativeMessage[] = [];
const modelTurnEvents = new Set([
  "turn/started",
  "turn/completed",
  "model/rerouted",
  "item/completed",
]);
let threadId: string | null = config.threadId || null,
  nativeTurnStatus: string | null = null,
  completedTurn = false,
  finalMessage = "",
  commands: { command: string; exitCode?: number | null; output: string }[] =
    [],
  errorMessage: string | null = null;
function currentStopRequest(): WorkerStopRequest | null {
  return control.request;
}
const peer = await createWorkerPeer(config, {
  onSpawnError: (code) => {
    errorMessage = `Could not start worker (${code}).`;
  },
  onChannelError: (code) => {
    errorMessage = errorMessage || `Worker protocol channel closed (${code}).`;
  },
});
const { worker, closed, rpc, send, sendResponse } = peer;
const tree = worker.pid ? new OwnedProcessTree(worker.pid) : null;
let writes = Promise.resolve(),
  turnId: string | null = null,
  ending = false,
  turnStartPending = false,
  finishPending = false,
  threadStartPending = false,
  interruptRequested = false;
const nativeRequests = new Map<string, ApprovalRecord>(),
  attemptedResponses = new Set<string>();
const requestContext = () => ({
  stateDir: config.stateDir,
  taskId: config.taskId,
  runId: config.runId,
});
let preparationActive = false;
const observePreparation = createRunnerPreparation({
  stateDir: config.stateDir,
  actor: {
    role: "worker",
    taskId: config.taskId,
    runId: config.runId,
    projectId: config.project?.id,
  },
  snapshot: () => ({
    threadId,
    turnId,
    acknowledged: modelTurnAcknowledged && !turnStartPending,
    ending: ending || Boolean(nativeTurnStatus),
  }),
  steer: ({ threadId, expectedTurnId, requestId, text }) =>
    rpc("turn/steer", {
      threadId,
      expectedTurnId,
      clientUserMessageId: requestId,
      input: [{ type: "text", text }],
    }),
  onPreparing: () => {
    preparationActive = true;
    clearTimeout(timeout);
  },
});
const directions = createRunnerDirections({
  globalCapacityDir: config.globalCapacityDir,
  ...requestContext(),
  snapshot: () => ({
    threadId,
    turnId,
    acknowledged: modelTurnAcknowledged && !turnStartPending,
    ending:
      ending || Boolean(nativeTurnStatus) || Boolean(currentStopRequest()),
  }),
  steer: ({ threadId, expectedTurnId, requestId, text }) =>
    rpc("turn/steer", {
      threadId,
      expectedTurnId,
      clientUserMessageId: requestId,
      input: [{ type: "text", text }],
    }),
});
const runnerControl = createRunnerControl({
  runDir,
  runId: config.runId,
  workerPid: worker.pid,
  tree,
  spawnError: peer.spawnError,
  atomic,
  snapshot: () => ({ turnId, ending, turnStartPending }),
  interruptTurn,
  finish,
  capture,
  observePreparation,
  observeDirections: directions.observe,
  onCooperative: () => clearTimeout(timeout),
  onError: (message) => {
    errorMessage = errorMessage || message;
  },
  requestContext,
  nativeRequests,
  attemptedResponses,
  sendResponse,
});
const { control, stopOwnedWorker, acceptControl } = runnerControl;
function interruptTurn() {
  if (
    interruptRequested ||
    !turnId ||
    ending ||
    (selectedModel && (!modelTurnAcknowledged || turnStartPending))
  )
    return;
  interruptRequested = true;
  void rpc("turn/interrupt", { threadId, turnId }).catch((error) => {
    errorMessage = describeError(error);
  });
}
function saveRuntime() {
  writes = writes.then(() =>
    atomic("runtime.json", {
      runId: config.runId,
      threadId,
      turnId,
      completedTurn,
      commands,
      updatedAt: new Date().toISOString(),
    }),
  );
  return writes;
}
async function applyModelReroute(params: WorkerNativeParams) {
  if (
    !selectedModel ||
    !modelTurnAcknowledged ||
    ending ||
    params.threadId !== threadId ||
    !turnId ||
    params.turnId !== turnId
  )
    return;
  await modelEvidence(
    "rerouted",
    `The native provider rerouted this turn from ${params.fromModel} to ${params.toModel}. Review the reported model with the manager; Crew did not substitute a model.`,
    {
      selectedModel: params.toModel,
      source: "native-model-rerouted",
      reason: params.reason,
    },
  );
}
async function completeTurn(params: WorkerNativeParams) {
  if (!modelTurnAcknowledged || ending) return;
  if (!params.turn) throw new Error("Native completion has no turn identity.");
  if (turnId && params.turn.id !== turnId) return;
  nativeTurnStatus = params.turn.status || null;
  completedTurn = nativeTurnStatus === "completed";
  if (params.turn.error) {
    errorMessage = params.turn.error.message || "Codex turn failed";
    await modelEvidence(
      "failed",
      `Native worker failed after model selection: ${errorMessage}`,
      { selectedModel: null },
    );
  }
  await finish();
}
async function finish() {
  if (ending) return;
  if (turnStartPending) {
    finishPending = true;
    return;
  }
  ending = true;
  await saveRuntime();
  await writeFile(finalFile, finalMessage, { mode: 0o600 });
  await invalidateWorkerRequests({
    ...requestContext(),
    reason: "Worker turn ended; this native request is no longer actionable.",
  });
  worker.stdin.end();
}
const approvalMethods = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
]);
async function handle(message: WorkerNativeMessage, replayModelEvent = false) {
  if (peer.consumeResponse(message)) return;
  const { method, params = {} } = message;
  if (!method) return;
  if (message.id !== undefined && method) {
    if (method === "currentTime/read") {
      send({
        id: message.id,
        result: { currentTimeAt: Math.floor(Date.now() / 1000) },
      });
      return;
    }
    if (approvalMethods.has(method)) {
      // Turn-bound requests are observations until the new turn is acknowledged.
      if (params.turnId) {
        if (ending || nativeTurnStatus) return;
        if (!modelTurnAcknowledged || (turnStartPending && !replayModelEvent)) {
          if (turnStartPending) {
            const size = Buffer.byteLength(JSON.stringify(message));
            if (
              pendingModelEvents.length >= 100 ||
              modelEventBytes + size > 262144
            )
              throw new Error(
                "Early native requests exceeded their bounded journal; no response was sent.",
              );
            pendingModelEvents.push(message);
            modelEventBytes += size;
          }
          return;
        }
        if (params.turnId !== turnId) return;
      }

      if (
        !threadId &&
        threadStartPending &&
        typeof params.threadId === "string"
      )
        threadId = params.threadId;
      if (params.threadId && params.threadId !== threadId)
        throw new Error("Worker approval belongs to another thread.");
      if (params.turnId && turnId && params.turnId !== turnId)
        throw new Error("Worker approval belongs to another turn.");
      if (!threadId)
        throw new Error("Worker approval has no native thread identity.");
      const record = await recordWorkerRequest({
        ...requestContext(),
        threadId,
        turnId: params.turnId || turnId,
        requestId: message.id,
        method,
        params: { ...params, threadId, turnId: params.turnId || turnId },
      });
      nativeRequests.set(record.approvalId, record);
      await saveRuntime();
      return;
    }
    errorMessage = `Worker requested unsupported native method ${method}; no action was approved.`;
    send({ id: message.id, error: { code: -32601, message: errorMessage } });
    return;
  }
  if (params.threadId && params.threadId !== threadId) return;
  // In every turn, native notifications are observations until the
  // start response positively binds their turn. Keep one bounded ordered queue;
  // stale items must never become current-run command or terminal evidence.
  if (
    modelTurnEvents.has(method) ||
    (method === "error" && typeof params.turnId === "string")
  ) {
    if (ending || nativeTurnStatus || params.threadId !== threadId) return;
    const eventTurnId =
      method === "turn/started" || method === "turn/completed"
        ? params.turn?.id
        : params.turnId;
    if (typeof eventTurnId !== "string" || !eventTurnId) return;
    if (!modelTurnAcknowledged || (turnStartPending && !replayModelEvent)) {
      if (turnStartPending) {
        const size = Buffer.byteLength(JSON.stringify(message));
        if (pendingModelEvents.length >= 100 || modelEventBytes + size > 262144)
          throw new Error(
            "Early native turn events exceeded their bounded journal; execution is unverified.",
          );
        pendingModelEvents.push(message);
        modelEventBytes += size;
      }
      return;
    }
    if (eventTurnId !== turnId) return;
  }
  if (method === "thread/started" && !threadId && params.thread?.id) {
    threadId = params.thread.id;
    await saveRuntime();
  }
  if (method === "turn/started") {
    if (!params.turn) throw new Error("Native turn start has no identity.");
    turnId = params.turn.id;
    await saveRuntime();
    if (
      currentStopRequest()?.cooperative &&
      !currentStopRequest()?.settleNaturally
    )
      interruptTurn();
  }
  if (method === "model/rerouted" && selectedModel)
    await applyModelReroute(params);
  if (method === "item/completed") {
    const item = params.item;
    if (item?.type === "agentMessage") finalMessage = item.text || "";
    if (item?.type === "commandExecution" && typeof item.command === "string")
      commands.push({
        command: item.command,
        exitCode: item.exitCode,
        output: String(item.aggregatedOutput || "").slice(0, 5000),
      });
    writes = writes.then(() =>
      appendFile(
        path.join(runDir, "events.jsonl"),
        JSON.stringify({
          taskId: config.taskId,
          assignmentId: config.assignmentId || "initial",
          runId: config.runId,
          at: new Date().toISOString(),
          type: "item.completed",
          nativeMethod: method,
          turnId: params.turnId,
          item:
            item?.type === "agentMessage"
              ? {
                  id: item.id,
                  type: "agent_message",
                  text: String(item.text || "").slice(0, 12000),
                }
              : item?.type === "commandExecution"
                ? {
                    id: item.id,
                    type: "command_execution",
                    command: item.command,
                    status: item.status,
                    exitCode: item.exitCode,
                  }
                : { type: item?.type, status: item?.status },
        }) + "\n",
        { mode: 0o600 },
      ),
    );
    await saveRuntime();
  }
  if (method === "serverRequest/resolved" && !ending && !nativeTurnStatus) {
    for (const [id, request] of nativeRequests)
      if (request.requestId === params.requestId) {
        await markWorkerRequestResolved({
          ...requestContext(),
          approvalId: id,
        });
        nativeRequests.delete(id);
      }
  }
  if (method === "turn/completed") await completeTurn(params);
  if (method === "error") {
    errorMessage = params.error?.message || "Codex worker error";
    await modelEvidence(
      "failed",
      `Native worker reported an error: ${errorMessage}`,
      { selectedModel: null },
    );
  }
}
peer.listen(
  (message) => handle(message),
  async (error) => {
    errorMessage = describeError(error);
    await finish();
  },
);
const bootstrap = (async () => {
  try {
    await rpc("initialize", {
      clientInfo: { name: "crew_worker", version: "0.10.0" },
      capabilities: {
        experimentalApi: true,
        mcpServerOpenaiFormElicitation: true,
      },
    });
    send({ method: "initialized", params: {} });
    if (ending || control.request) {
      await finish();
      return;
    }
    const { account } = await rpc("account/read", { refreshToken: false });
    if (account?.type !== "chatgpt")
      throw new Error("ChatGPT subscription sign-in is required for workers.");
    if (ending || control.request) {
      await finish();
      return;
    }
    if (selectedModel) {
      await modelEvidence(
        "validating",
        "Validating the requested model before the next native turn.",
      );
      await requireWorkerModel(rpc, selectedModel);
      if (!config.threadId)
        throw new Error(
          "Model continuation requires the retained native conversation; no replacement thread was started.",
        );
    }
    if (ending || control.request) {
      await finish();
      return;
    }
    const options: { cwd: string; model?: string; sandbox?: string } = {
      cwd: config.worktree,
      ...(selectedModel ? { model: selectedModel } : {}),
    };
    // Disposable fixture acceptance retains its explicitly authorized read-only boundary.
    if (config.project?.mode !== "repository") options.sandbox = "read-only";
    threadStartPending = true;
    const started = await rpc(
      config.threadId ? "thread/resume" : "thread/start",
      config.threadId
        ? { ...options, threadId: config.threadId, excludeTurns: true }
        : options,
    );
    threadStartPending = false;
    if (config.threadId && started.thread.id !== config.threadId)
      throw new Error(
        "Native continuation returned another thread; no new turn was started.",
      );
    threadId = started.thread.id;
    await saveRuntime();
    if (selectedModel && started.model !== selectedModel)
      throw new Error(
        "Native model selection did not confirm the requested exact model; no fallback turn was started.",
      );
    if (ending || control.request) {
      await finish();
      return;
    }
    const settings = await rpc("config/read", {
      cwd: config.worktree,
      includeLayers: false,
    });
    await atomic("effective-policy.json", {
      runId: config.runId,
      threadId,
      configResolutionCwd: config.worktree,
      source: started.sandbox ? "native-thread-response" : "config-read",
      sandboxType: started.sandbox?.type ?? null,
      configSandboxMode: settings.config?.sandbox_mode ?? null,
      approvalPolicy:
        started.approvalPolicy ?? settings.config?.approval_policy ?? null,
      approvalsReviewer: started.approvalsReviewer ?? null,
      permissionsProfile: settings.config?.default_permissions ?? null,
    });
    if (ending || control.request) {
      await finish();
      return;
    }
    turnStartPending = true;
    const result = await rpc("turn/start", {
      threadId,
      ...(selectedModel ? { model: selectedModel } : {}),
      input: [{ type: "text", text: prompt }],
    });
    if (typeof result.turn?.id !== "string" || !result.turn.id)
      throw new Error(
        "Native model continuation did not acknowledge a turn identity; selection was not confirmed.",
      );
    if (turnId && turnId !== result.turn.id)
      throw new Error(
        "Native model continuation returned a different turn identity; selection was not confirmed.",
      );
    if (!turnId) turnId = result.turn.id;
    {
      if (errorMessage) throw new Error(errorMessage);
      modelTurnAcknowledged = true;
      if (!ending)
        await modelEvidence(
          "selected",
          `Native worker selected ${selectedModel} for the resumed turn.`,
          {
            selectedModel,
            source: "native-thread-resume-response-and-turn-start",
            turnStartAcknowledged: true,
          },
        );
      while (pendingModelEvents.length && !ending && !nativeTurnStatus) {
        const event = pendingModelEvents.shift();
        if (!event) break;
        modelEventBytes -= Buffer.byteLength(JSON.stringify(event));
        await handle(event, true);
      }
      pendingModelEvents.length = 0;
      modelEventBytes = 0;
    }
    turnStartPending = false;
    await saveRuntime();
    if (finishPending) await finish();
    else if (
      currentStopRequest()?.cooperative &&
      !currentStopRequest()?.settleNaturally
    )
      interruptTurn();
  } catch (error) {
    turnStartPending = false;
    modelTurnAcknowledged = false;
    pendingModelEvents.length = 0;
    modelEventBytes = 0;
    if (!control.request && !nativeTurnStatus) {
      errorMessage = describeError(error);
      await modelEvidence(
        "failed",
        `Model change failed: ${describeError(error)} Retained task, worktree and native conversation were preserved.`,
        { selectedModel: null },
      );
    }
    await finish();
  }
})();
async function capture() {
  if (tree) {
    const records = await tree.capture();
    await atomic("ownership.json", {
      runId: config.runId,
      records,
      at: new Date().toISOString(),
    });
  }
}
await capture();
await atomic("owner.json", {
  runId: config.runId,
  supervisorPid: process.pid,
  supervisorIdentity: (await snapshotProcesses()).get(process.pid) || null,
  workerPid: worker.pid || null,
  at: new Date().toISOString(),
});
const timeoutMs =
  typeof config.timeoutMs === "number" &&
  Number.isSafeInteger(config.timeoutMs) &&
  config.timeoutMs >= 1000 &&
  config.timeoutMs <= 86400000
    ? config.timeoutMs
    : 300000;
let timeout: NodeJS.Timeout | undefined;
const checkTimeout = () => {
  timeout = setTimeout(() => {
    void (async () => {
      await acceptControl().catch(() => {});
      await observePreparation().catch(() => {});
      if (preparationActive || runnerControl.isCooperative()) return;
      if (nativeRequests.size) {
        checkTimeout();
        return;
      }
      errorMessage = `Bounded worker run exceeded ${timeoutMs} milliseconds.`;
      void stopOwnedWorker();
    })();
  }, timeoutMs);
};
if (config.project?.mode !== "repository") checkTimeout();
runnerControl.startMonitoring();
process.on("SIGTERM", () => {
  errorMessage = "Worker supervisor was stopped.";
  if (runnerControl.isCooperative()) runnerControl.clearCooperative();
  void stopOwnedWorker();
});
const exitCode = await closed;
clearTimeout(timeout);
runnerControl.stopMonitoring();
// Natural native closure retains agent-started resources for explicit cleanup.
await acceptControl().catch(() => {});
let observedStop = control.stopPromise;
let ownership: StopEvidence;
if (observedStop || runnerControl.isCooperative())
  ownership = await (observedStop || waitOwnedNatural(tree));
else if (tree) {
  await tree.capture();
  let remaining = await tree.remaining();
  const deadline = Date.now() + 1000;
  while (remaining.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    remaining = await tree.remaining();
  }
  ownership = {
    confirmed: Boolean(tree.rootIdentity) && remaining.length === 0,
    remaining,
    tracked: [...tree.records.values()],
  };
} else
  ownership = {
    confirmed: Boolean(peer.spawnError()),
    remaining: [],
    tracked: [],
  };
if (control.stopPromise && control.stopPromise !== observedStop)
  ownership = await control.stopPromise;
peer.rejectPending();
await directions.drain();
await bootstrap;
await peer.drain();
await writes;
await invalidateWorkerRequests({
  ...requestContext(),
  reason: "Worker process exited.",
});
await atomic("exit.json", {
  connectionClosed: true,
  runId: config.runId,
  threadId,
  nativeTurnStatus,
  exitCode: errorMessage && exitCode === 0 ? 1 : exitCode,
  completedTurn,
  commands,
  finalMessage,
  error: errorMessage,
  stopped: Boolean(control.request) && ownership.confirmed,
  stopConfirmed: ownership.confirmed,
  ownership: {
    confirmed: ownership.confirmed,
    remaining: ownership.remaining || [],
    tracked: ownership.tracked || [],
  },
  stopAction: control.request?.action || null,
  stopRequestId: control.request?.requestId || null,
  supervisorPid: process.pid,
  workerPid: worker.pid || null,
  at: new Date().toISOString(),
});
