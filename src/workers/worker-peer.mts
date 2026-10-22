/** Native worker IPC. Correlated replies bypass serialized event handlers to avoid RPC deadlock. */
import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";
import { errorCode, errorMessage } from "./errors.mjs";
import {
  parseWorkerMessage,
  parseWorkerResult,
  type NativeResult,
  type ThreadResult,
  type TurnResult,
  type WorkerConfiguration,
  type WorkerNativeMessage,
} from "./worker-protocol.mjs";
interface PeerObservers {
  onSpawnError: (code: string) => void;
  onChannelError: (code: string) => void;
}
export async function createWorkerPeer(
  config: WorkerConfiguration,
  observers: PeerObservers,
) {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"])
    delete env[key];
  const mcpArgs = [
    config.mcpScript,
    config.stateDir,
    "worker",
    config.taskId,
    config.runId,
  ];
  const args = [
    "app-server",
    "--stdio",
    "-c",
    'forced_login_method="chatgpt"',
    "-c",
    'model_provider="openai"',
    "-c",
    `mcp_servers.local_orchestration.command=${JSON.stringify(process.execPath)}`,
    "-c",
    `mcp_servers.local_orchestration.args=${JSON.stringify(mcpArgs)}`,
    "-c",
    "mcp_servers.local_orchestration.required=true",
    "-c",
    'mcp_servers.local_orchestration.default_tools_approval_mode="approve"',
  ];
  if (process.env.ELECTRON_RUN_AS_NODE === "1")
    args.push(
      "-c",
      'mcp_servers.local_orchestration.env.ELECTRON_RUN_AS_NODE="1"',
    );
  let nodeEntry = false,
    handle;
  try {
    handle = await open(config.executable, "r");
    const header = Buffer.alloc(256);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    nodeEntry = /^#![^\n]*(?:\/env\s+node|\/node)(?:\s|$)/.test(
      header.subarray(0, bytesRead).toString(),
    );
  } catch {
  } finally {
    await handle?.close();
  }
  const worker = spawn(
    nodeEntry ? process.execPath : config.executable,
    nodeEntry ? [config.executable, ...args] : args,
    {
      cwd: config.worktree,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let spawnError: string | null = null;
  const closed = new Promise<number | null>((resolve) => {
    worker.once("close", resolve);
    worker.once("error", (error) => {
      spawnError = String(errorCode(error) || "spawn failed");
      observers.onSpawnError(spawnError);
      resolve(null);
    });
  });
  worker.stdin.on("error", (error) =>
    observers.onChannelError(String(errorCode(error) || "error")),
  );
  const pending = new Map<
    string | number,
    {
      method: string;
      resolve: (value: NativeResult) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  let nextId = 0;
  const send = (message: unknown) => {
    if (!worker.stdin.destroyed)
      worker.stdin.write(JSON.stringify(message) + "\n");
  };
  const sendResponse = (message: unknown) =>
    new Promise<void>((resolve, reject) => {
      if (worker.stdin.destroyed || worker.stdin.writableEnded)
        return reject(
          Object.assign(
            new Error("Native worker response channel is closed."),
            { code: "NATIVE_CHANNEL_CLOSED" },
          ),
        );
      const timer = setTimeout(
        () =>
          reject(
            Object.assign(
              new Error(
                "Native response write timed out; delivery is unknown.",
              ),
              { code: "NATIVE_WRITE_TIMEOUT" },
            ),
          ),
        5000,
      );
      worker.stdin.write(JSON.stringify(message) + "\n", (error) => {
        clearTimeout(timer);
        error ? reject(error) : resolve();
      });
    });
  function rpc(
    method: "thread/start" | "thread/resume",
    params?: Record<string, unknown>,
  ): Promise<ThreadResult>;
  function rpc(
    method: "turn/start",
    params?: Record<string, unknown>,
  ): Promise<TurnResult>;
  function rpc(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<NativeResult>;
  function rpc(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<NativeResult> {
    return new Promise((resolve, reject) => {
      const id = ++nextId,
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out.`));
        }, 90000);
      pending.set(id, { method, resolve, reject, timer });
      send({ id, method, params });
    });
  }
  function consumeResponse(message: WorkerNativeMessage) {
    if (message.id === undefined || message.method || !pending.has(message.id))
      return false;
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (!entry) return true;
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message));
    else
      try {
        entry.resolve(parseWorkerResult(entry.method, message.result));
      } catch (error) {
        entry.reject(new Error(errorMessage(error)));
      }
    return true;
  }
  function rejectPending() {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Codex worker exited."));
    }
    pending.clear();
  }
  let handling = Promise.resolve();
  function listen(
    onMessage: (message: WorkerNativeMessage) => Promise<void>,
    onFailure: (error: unknown) => Promise<void>,
  ) {
    const lines = createInterface({ input: worker.stdout });
    lines.on("line", (line) => {
      let message;
      try {
        message = parseWorkerMessage(JSON.parse(line));
      } catch {
        return;
      }
      if (consumeResponse(message)) return;
      handling = handling.then(() => onMessage(message)).catch(onFailure);
    });
  }
  // Native diagnostics may contain credentials; never persist them.
  let diagnosticBytes = 0;
  worker.stderr.on("data", (chunk) => {
    if (diagnosticBytes < 8192) diagnosticBytes += chunk.length;
  });
  return {
    worker,
    closed,
    rpc,
    send,
    sendResponse,
    consumeResponse,
    rejectPending,
    listen,
    drain: () => handling,
    spawnError: () => spawnError,
  };
}
