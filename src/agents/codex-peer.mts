import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { JsonObject, JsonValue } from "./contracts.mjs";

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function json(value: unknown, depth = 0): value is JsonValue {
  if (depth > 40) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => json(item, depth + 1));
  return (
    object(value) && Object.values(value).every((item) => json(item, depth + 1))
  );
}
export function record(value: unknown): Record<string, unknown> {
  if (!object(value)) throw new CodexRpcError("Malformed native response.");
  return value;
}
export function string(value: unknown): string {
  if (typeof value !== "string" || !value)
    throw new CodexRpcError("Missing native identity.");
  return value;
}
export class CodexRpcError extends Error {
  constructor(
    message: string,
    readonly code: number | null = null,
    readonly sent = true,
  ) {
    super(message);
  }
}
export interface CodexLaunch {
  executable: string;
  args: string[];
  cwd: string;
  /** Complete trusted environment. Never merged with process.env. */
  env: Record<string, string>;
}
export interface CodexEnvelope {
  id?: string | number;
  method: string;
  params: Record<string, unknown>;
}

/** One explicitly resolved app-server process. No discovery, auth copying or daemon adoption. */
export class CodexPeer {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<void>;
  private live = true;
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: CodexRpcError): void;
      timer: NodeJS.Timeout;
    }
  >();
  constructor(
    launch: CodexLaunch,
    private receive: (envelope: CodexEnvelope) => void,
    private disconnected: () => void,
    readonly timeoutMs = 10_000,
  ) {
    this.child = spawn(launch.executable, launch.args, {
      cwd: launch.cwd,
      env: { ...launch.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Native stderr can contain configuration/authentication details; drain without retaining it.
    this.child.stderr.resume();
    this.child.stdin.on("error", () => this.fail());
    this.child.once("error", () => this.fail());
    this.exited = new Promise((resolve) => {
      this.child.once("exit", () => {
        this.fail();
        resolve();
      });
      this.child.once("error", () => {
        if (this.child.pid === undefined) resolve();
      });
    });
    let buffer = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 8 * 1024 * 1024) {
        this.fail();
        this.child.stdout.pause();
        return;
      }
      let boundary: number;
      while ((boundary = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        if (!line) continue;
        try {
          this.accept(JSON.parse(line));
        } catch {
          this.fail();
        }
      }
    });
  }
  get connected() {
    return this.live;
  }
  private accept(value: unknown) {
    const packet = record(value);
    if (typeof packet.method === "string") {
      if (
        packet.id !== undefined &&
        typeof packet.id !== "string" &&
        typeof packet.id !== "number"
      )
        throw new Error("Invalid request ID");
      this.receive({
        ...(packet.id === undefined ? {} : { id: packet.id }),
        method: packet.method,
        params: record(packet.params ?? {}),
      });
      return;
    }
    if (typeof packet.id !== "number") return;
    const pending = this.pending.get(packet.id);
    if (!pending) return; // Late replies never cause retries or a new operation.
    this.pending.delete(packet.id);
    clearTimeout(pending.timer);
    if (object(packet.error))
      pending.reject(
        new CodexRpcError(
          typeof packet.error.message === "string"
            ? packet.error.message
            : "Native RPC rejected.",
          typeof packet.error.code === "number" ? packet.error.code : null,
        ),
      );
    else if ("result" in packet) pending.resolve(packet.result);
    else pending.reject(new CodexRpcError("Malformed native reply."));
  }
  private fail() {
    if (!this.live) return;
    this.live = false;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new CodexRpcError("Native transport disconnected."));
    }
    this.pending.clear();
    this.disconnected();
  }
  send(value: JsonObject): void {
    if (!this.live || !this.child.stdin.writable)
      throw new CodexRpcError("Native transport unavailable.", null, false);
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }
  rpc(method: string, params: JsonObject): Promise<unknown> {
    if (!this.live)
      return Promise.reject(
        new CodexRpcError("Native transport unavailable.", null, false),
      );
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexRpcError("Native acknowledgement timed out."));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(
          error instanceof CodexRpcError
            ? error
            : new CodexRpcError("Native write failed."),
        );
      }
    });
  }
  /** Only after native idle/approval settlement. No signals or descendant cleanup. */
  async close(): Promise<boolean> {
    this.child.stdin.end();
    let timer: NodeJS.Timeout | undefined;
    const stopped = await Promise.race([
      this.exited.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), this.timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    return stopped;
  }
}
