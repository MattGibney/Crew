import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { parseJSON, record } from "./validation.mjs";
export interface SetupConnectionOptions {
  executable: string;
  root: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface SetupRpc {
  request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
  notify(method: string, params?: Record<string, unknown>): void;
  onNotification(
    listener: (method: string, params: Record<string, unknown>) => void,
  ): void;
  close(): Promise<void>;
}
interface Pending {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}
/** Disposable read-only setup connection. It never approves native requests. */
export function openSetupRpc({
  executable,
  root,
  env = process.env,
  signal,
  timeoutMs = 20000,
}: SetupConnectionOptions): SetupRpc {
  const child = spawn(
    executable,
    [
      "app-server",
      "--stdio",
      "-c",
      'forced_login_method="chatgpt"',
      "-c",
      'model_provider="openai"',
    ],
    { cwd: root, env, stdio: ["pipe", "pipe", "ignore"] },
  );
  let sequence = 0,
    dead = false;
  const pending = new Map<number, Pending>();
  let notification:
    ((method: string, params: Record<string, unknown>) => void) | undefined;
  const fail = (error: Error) => {
    dead = true;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", () =>
    fail(new Error("Codex setup check stopped. Retry the check.")),
  );
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const message = record(parseJSON(line));
      // Native method-bearing requests have their own ID namespace. They must be
      // classified before replies, even if their numeric ID matches our request.
      if (typeof message.method === "string") {
        if (message.id !== undefined)
          child.stdin.write(
            JSON.stringify({
              id: message.id,
              error: {
                code: -32601,
                message: "Setup cannot approve work or credential requests.",
              },
            }) + "\n",
          );
        else notification?.(message.method, record(message.params || {}));
        return;
      }
      if (typeof message.id !== "number") return;
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error)
        item.reject(
          new Error(
            "Codex could not complete the setup read. Reconnect in Codex and retry.",
          ),
        );
      else item.resolve(record(message.result));
    } catch {
      /* Malformed/unrelated lines cannot satisfy a request. */
    }
  });
  const cancel = () => {
    fail(new Error("Setup check canceled."));
    child.kill("SIGTERM");
  };
  signal?.addEventListener("abort", cancel, { once: true });
  return {
    async request(method, params = {}, timeout = timeoutMs) {
      if (dead || signal?.aborted)
        throw new Error("Setup check canceled or disconnected.");
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out. Retry; no work was started.`));
        }, timeout);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      });
    },
    notify(method, params = {}) {
      child.stdin.write(JSON.stringify({ method, params }) + "\n");
    },
    onNotification(listener) {
      notification = listener;
    },
    async close() {
      signal?.removeEventListener("abort", cancel);
      fail(new Error("Setup read finished."));
      lines.close();
      child.kill("SIGTERM");
      await new Promise<void>((done) => {
        if (child.exitCode !== null) return done();
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          done();
        }, 2000);
        child.once("exit", () => {
          clearTimeout(timer);
          done();
        });
      });
    },
  };
}
export async function initializeSetupRpc(
  client: SetupRpc,
  name: string,
): Promise<void> {
  await client.request("initialize", {
    clientInfo: { name, version: "0.5.0" },
    capabilities: { experimentalApi: true },
  });
  client.notify("initialized");
}
