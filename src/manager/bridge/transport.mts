import type { BridgeChild, PendingRpc } from "./contracts.mjs";
import type { RpcMethod, RpcResults, WireEnvelope } from "./protocol.mjs";
import { decodeRpc, rpcErrorCode } from "./protocol.mjs";
import { errorMessage } from "../../shared/errors.mjs";
/** Client RPC IDs and method-bearing native requests are separate namespaces. */
export function createRpcChannel(
  child: () => BridgeChild | undefined,
  send: (message: unknown) => void,
) {
  const pending = new Map<number, PendingRpc>();
  let nextId = 0;
  async function rpc<M extends RpcMethod>(
    method: M,
    params: Record<string, unknown> = {},
  ): Promise<RpcResults[M]> {
    const result = await new Promise<unknown>((resolve, reject) => {
      const process = child();
      if (!process || process.exitCode !== null || process.signalCode !== null)
        return reject(new Error("Codex is not running."));
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out.`));
      }, 90000);
      pending.set(id, { resolve, reject, timer });
      send({ id, method, params });
    });
    return decodeRpc(method, result);
  }
  function handleReply(message: WireEnvelope): boolean {
    if (
      typeof message.id !== "number" ||
      message.method ||
      !pending.has(message.id)
    )
      return false;
    const entry = pending.get(message.id)!;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error)
      entry.reject(
        Object.assign(
          new Error(message.error.message || errorMessage(message.error)),
          { code: rpcErrorCode(message.error) },
        ),
      );
    else entry.resolve(message.result);
    return true;
  }
  function rejectPending(error: unknown) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }
  return { rpc, handleReply, rejectPending };
}
