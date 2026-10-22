import { createHash } from "node:crypto";
import type { Rpc, WireEnvelope } from "./protocol.mjs";
import { decodeApprovalParams } from "./protocol.mjs";
import type {
  ThreadBootstrap,
  ManagerApproval,
  BridgeWorkItem,
} from "./contracts.mjs";
interface RequestState {
  threadBootstrap: ThreadBootstrap | undefined;
  threadId: string | undefined;
  activeTurnId: string | null;
  requestEpoch: string | undefined;
}
/** Native request ownership includes startup connector input before the opening RPC resolves. */
export function createManagerRequests({
  state,
  rpc,
  approvals,
  items,
  send,
  emit,
  changed,
}: {
  state: RequestState;
  rpc: Rpc;
  approvals: Map<string, ManagerApproval>;
  items: Map<string, BridgeWorkItem>;
  send: (value: unknown) => void;
  emit: (type: string, data: Record<string, unknown>) => void;
  changed: () => void;
}) {
  function bindBootstrapThread(id: unknown) {
    if (
      !state.threadBootstrap ||
      typeof id !== "string" ||
      !/^[\w-]+$/.test(id)
    )
      return false;
    if (
      (state.threadBootstrap.expectedThreadId &&
        id !== state.threadBootstrap.expectedThreadId) ||
      (state.threadBootstrap.observedThreadId &&
        id !== state.threadBootstrap.observedThreadId)
    )
      return false;
    state.threadBootstrap.observedThreadId = id;
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
    state.threadBootstrap = bootstrap;
    let opened = false;
    try {
      const result = await rpc(method, params);
      if (!bindBootstrapThread(result.thread?.id))
        throw new Error(
          "Native manager thread startup correlation mismatch; pending requests were not answered automatically.",
        );
      state.threadId = result.thread.id;
      opened = true;
      return result;
    } finally {
      if (state.threadBootstrap === bootstrap)
        state.threadBootstrap = undefined;
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
  function handle(message: WireEnvelope): boolean {
    if (message.id !== undefined && message.method) {
      const { threadBootstrap, threadId, activeTurnId, requestEpoch } = state;
      const method = message.method;
      const rawParams = message.params || {};
      if (method === "currentTime/read")
        send({
          id: message.id,
          result: { currentTimeAt: Math.floor(Date.now() / 1000) },
        });
      if (method === "currentTime/read") return true;
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
        return true;
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
        return true;
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
      return true;
    }
    return false;
  }
  return { bindBootstrapThread, openNativeThread, handle };
}
