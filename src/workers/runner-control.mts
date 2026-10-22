import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  OwnedProcessTree,
  StopEvidence,
} from "../processes/ownership.mjs";
import { waitOwnedNatural } from "../processes/cooperative.mjs";
import {
  parseWorkerStopRequest,
  type WorkerStopRequest,
} from "./worker-protocol.mjs";
import { errorCode } from "./errors.mjs";
import type { ApprovalRecord } from "./approvals.mjs";
import {
  workerRequestDecisions,
  deliverWorkerRequest,
} from "./approval-store.mjs";
interface RunnerControlOptions {
  runDir: string;
  runId: string;
  workerPid: number | undefined;
  tree: OwnedProcessTree | null;
  spawnError: () => string | null;
  atomic: (name: string, value: unknown) => Promise<void>;
  snapshot: () => {
    turnId: string | null;
    ending: boolean;
    turnStartPending: boolean;
  };
  interruptTurn: () => void;
  finish: () => Promise<void>;
  capture: () => Promise<void>;
  observePreparation?: () => Promise<void>;
  onCooperative: () => void;
  onError: (message: string) => void;
  requestContext: () => { stateDir: string; taskId: string; runId: string };
  nativeRequests: Map<string, ApprovalRecord>;
  attemptedResponses: Set<string>;
  sendResponse: (response: {
    id: string | number;
    result: unknown;
  }) => Promise<void>;
}
export function createRunnerControl({
  runDir,
  runId,
  workerPid,
  tree,
  spawnError,
  atomic,
  snapshot,
  interruptTurn,
  finish,
  capture,
  observePreparation,
  onCooperative,
  onError,
  requestContext,
  nativeRequests,
  attemptedResponses,
  sendResponse,
}: RunnerControlOptions) {
  const control: {
    request: WorkerStopRequest | null;
    stopPromise: Promise<StopEvidence> | null;
  } = { request: null, stopPromise: null };
  let cooperative = false;
  const stopOwnedWorker = () => {
    if (!control.stopPromise)
      control.stopPromise = tree
        ? tree.stop({ graceMs: 2000 })
        : Promise.resolve<StopEvidence>({
            confirmed: Boolean(spawnError()),
            remaining: [],
          });
    return control.stopPromise;
  };
  let checking = false,
    protocolFailure: {
      runId: string;
      stage: string;
      code: string;
      message: string;
      at: string;
    } | null = null;
  async function retainProtocolFailure(error: unknown, stage: string) {
    if (protocolFailure) return;
    const code =
      typeof errorCode(error) === "string" &&
      /^[A-Z][A-Z0-9_]{0,31}$/.test(String(errorCode(error)))
        ? String(errorCode(error))
        : error instanceof SyntaxError
          ? "INVALID_JSON"
          : "PROTOCOL_FAILURE";
    protocolFailure = {
      runId: runId,
      stage,
      code,
      message: `Worker ${stage} failed (${code}); pending native requests were retained without an automatic response.`,
      at: new Date().toISOString(),
    };
    onError(protocolFailure.message);
    await atomic("protocol-error.json", protocolFailure);
  }

  async function acceptControl() {
    let request;
    try {
      request = parseWorkerStopRequest(
        JSON.parse(await readFile(path.join(runDir, "control.json"), "utf8")),
      );
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    if (
      !request ||
      request.runId !== runId ||
      typeof request.requestId !== "string" ||
      !["stop", "pause"].includes(request.action) ||
      control.request?.requestId === request.requestId
    )
      return;
    control.request = request;
    await atomic("control-accepted.json", {
      ...request,
      at: new Date().toISOString(),
      supervisorPid: process.pid,
      workerPid: workerPid,
    });
    if (request.cooperative === true) {
      cooperative = true;
      onCooperative();
      const { turnId, ending, turnStartPending } = snapshot();
      if (!request.settleNaturally) {
        if (turnId && !ending) interruptTurn();
        else if (!ending && !turnStartPending) void finish();
      }
      control.stopPromise = waitOwnedNatural(tree, {
        onBlocked: (state) =>
          atomic("cooperative-stop.json", {
            runId: runId,
            requestId: request.requestId,
            ...state,
            at: new Date().toISOString(),
          }),
        isSuperseded: () => !cooperative,
      });
    } else {
      if (cooperative) {
        cooperative = false;
        control.stopPromise = null;
      }
      void stopOwnedWorker();
    }
  }
  let controlTimer: NodeJS.Timeout | undefined;
  function startMonitoring() {
    controlTimer = setInterval(async () => {
      if (checking) return;
      checking = true;
      let stage = "process ownership observation";
      try {
        await capture();
        stage = "lifecycle control read";
        await acceptControl();
        stage = "agent preparation read";
        await observePreparation?.();
        stage = "native decision read";
        for (const decision of await workerRequestDecisions(requestContext())) {
          const request = nativeRequests.get(decision.approvalId);
          if (
            !request ||
            snapshot().ending ||
            attemptedResponses.has(decision.approvalId)
          )
            continue;
          stage = "native response delivery";
          await deliverWorkerRequest(
            { ...requestContext(), approvalId: decision.approvalId },
            async (record) => {
              attemptedResponses.add(decision.approvalId);
              await sendResponse({
                id: request.requestId,
                result: record.response,
              });
            },
          );
        }
      } catch (error) {
        await retainProtocolFailure(error, stage).catch(() => {});
      } finally {
        checking = false;
      }
    }, 100);
  }
  return {
    control,
    stopOwnedWorker,
    acceptControl,
    startMonitoring,
    stopMonitoring: () => clearInterval(controlTimer),
    isCooperative: () => cooperative,
    clearCooperative: () => {
      cooperative = false;
      control.stopPromise = null;
    },
  };
}
