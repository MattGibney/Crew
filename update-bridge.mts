import { record } from "./shared/errors.mjs";
import type { UpdateStatus } from "./shared/update.mjs";
import {
  acceptUpdateStatus,
  unavailableUpdateStatus,
} from "./backend/update-ipc.mjs";
export { unavailableUpdateStatus } from "./backend/update-ipc.mjs";
interface UpdateTransport {
  connected?: boolean;
  send?: (
    message: Record<string, unknown>,
    callback: (error: Error | null) => void,
  ) => boolean;
  on(event: string, listener: (message: unknown) => void): unknown;
  removeListener(event: string, listener: (message: unknown) => void): unknown;
}
// AI-015: bounded inherited process IPC; never expose native/Node access to a renderer.
import { randomUUID } from "node:crypto";
export const updateActions = new Set([
  "status",
  "check",
  "download",
  "restart",
  "pause-update",
  "cancel-pause-update",
  "resume-paused-work",
  "return-to-work",
]);
export function createUpdateBridge({
  transport = process,
  version,
  onStatus = () => {},
  timeoutMs = 30000,
}: {
  transport?: UpdateTransport;
  version: string;
  onStatus?: (status: UpdateStatus) => void;
  timeoutMs?: number;
}) {
  let status = unavailableUpdateStatus(version),
    closed = false;
  const pending = new Map<
    string,
    {
      resolve: (status: UpdateStatus) => void;
      reject: (error: unknown) => void;
      timer: NodeJS.Timeout;
    }
  >();
  const accept = (value: unknown) => {
    status = acceptUpdateStatus(value);
    onStatus(status);
    return status;
  };
  const listener = (message: unknown) => {
    if (!record(message)) return;
    if (message.type === "crew:update:status") {
      try {
        accept(message.status);
      } catch {}
      return;
    }
    if (
      message.type !== "crew:update:response" ||
      typeof message.id !== "string" ||
      !pending.has(message.id)
    )
      return;
    const request = pending.get(message.id)!;
    pending.delete(message.id);
    clearTimeout(request.timer);
    try {
      const next = accept(message.status);
      if (message.error)
        request.reject(new Error(String(message.error).slice(0, 1000)));
      else request.resolve(next);
    } catch (error) {
      request.reject(error);
    }
  };
  transport.on("message", listener);
  const disconnected = () => {
    status = unavailableUpdateStatus(version);
    onStatus(status);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Desktop update connection closed."));
    }
    pending.clear();
  };
  transport.on("disconnect", disconnected);
  return {
    getStatus: () => structuredClone(status),
    async request(action = "status") {
      if (!updateActions.has(action)) throw new Error("Unknown update action.");
      if (
        closed ||
        typeof transport.send !== "function" ||
        transport.connected !== true
      ) {
        if (action === "status") return structuredClone(status);
        throw new Error("Updates are available in the installed desktop app.");
      }
      if (pending.size >= 8)
        throw new Error("An update request is already pending.");
      const id = randomUUID();
      return new Promise<UpdateStatus>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(
            new Error(
              "Desktop update request timed out. Retry from the app menu.",
            ),
          );
        }, timeoutMs);
        timer.unref?.();
        pending.set(id, { resolve, reject, timer });
        transport.send!(
          { type: "crew:update:request", id, action },
          (error) => {
            if (!error) return;
            const request = pending.get(id);
            if (request) {
              pending.delete(id);
              clearTimeout(timer);
              request.reject(new Error("Desktop update connection failed."));
            }
          },
        );
      });
    },
    close() {
      closed = true;
      transport.removeListener("message", listener);
      transport.removeListener("disconnect", disconnected);
      disconnected();
    },
  };
}
