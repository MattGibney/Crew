import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ReadBuffer,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type {
  CallToolResult,
  JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import type { JsonObject } from "../agents/contracts.mjs";

export interface PreviewMcpClientOptions {
  endpoint: string;
  onDisconnect?: () => void;
  /** Trusted absolute executable; args identify the locally pinned 1.12.0 CLI. */
  command: string;
  args: string[];
  cwd?: string;
  /** Explicit child environment. Personal process.env is never inherited. */
  env?: Record<string, string>;
}

const allowedTools = new Set([
  "list_pages",
  "take_snapshot",
  "navigate_page",
  "click",
  "fill",
  "fill_form",
  "press_key",
  "hover",
  "evaluate_script",
  "take_screenshot",
  "wait_for",
  "list_console_messages",
  "get_console_message",
]);

// SDK StdioClientTransport currently merges inherited environment variables and
// escalates shutdown to SIGKILL. Use its public framing/protocol with an owned
// transport so child credentials and bounded cooperative shutdown stay explicit.
class PreviewStdioTransport implements Transport {
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  onmessage?: Transport["onmessage"];
  private child?: ChildProcessWithoutNullStreams;
  private exited = false;
  private started = false;
  private closing?: Promise<void>;
  private readonly buffer = new ReadBuffer({ maxBufferSize: 16 * 1024 * 1024 });

  constructor(
    private readonly options: PreviewMcpClientOptions,
    private readonly args: string[],
  ) {}

  async start(): Promise<void> {
    if (this.started) throw new Error("Preview transport already started.");
    this.started = true;
    const child = spawn(this.options.command, this.args, {
      cwd: this.options.cwd,
      env: {
        ...this.options.env,
        // os.homedir() may still resolve the OS account with an empty env.
        // Do not let personal/global MCP configuration change this binding.
        CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY: "1",
      },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    child.once("close", () => {
      this.exited = true;
      this.buffer.clear();
      this.onclose?.();
    });
    child.on("error", () =>
      this.onerror?.(new Error("Preview tool process failed.")),
    );
    child.stdin.on("error", () =>
      this.onerror?.(new Error("Preview tool input disconnected.")),
    );
    child.stdout.on("error", () =>
      this.onerror?.(new Error("Preview tool output disconnected.")),
    );
    // Drain diagnostics without logging browser state, endpoint or page secrets.
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        this.buffer.append(chunk);
        let message: JSONRPCMessage | null;
        while ((message = this.buffer.readMessage()) !== null)
          this.onmessage?.(message);
      } catch {
        this.onerror?.(
          new Error("Invalid or oversized preview tool response."),
        );
        void this.close().catch(() => {});
      }
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () =>
        reject(new Error("Preview tool process could not start.")),
      );
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const child = this.child;
    if (!child || this.exited || this.closing)
      throw new Error("Preview tool is disconnected.");
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(serializeMessage(message), (error) =>
        error
          ? reject(new Error("Preview tool request delivery is uncertain."))
          : resolve(),
      );
    });
  }

  private waitForExit(timeout: number): Promise<boolean> {
    if (this.exited || !this.child) return Promise.resolve(true);
    const child = this.child;
    return new Promise((resolve) => {
      const done = (exited: boolean) => {
        clearTimeout(timer);
        child.removeListener("close", onClose);
        resolve(exited);
      };
      const onClose = () => done(true);
      const timer = setTimeout(() => done(false), timeout);
      child.once("close", onClose);
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.closeOwnedChild().catch((error: unknown) => {
      // Retain the exact owned child and allow another close observation.
      this.closing = undefined;
      throw error;
    });
    return this.closing;
  }

  private async closeOwnedChild(): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return;
    child.stdin.end();
    if (await this.waitForExit(2000)) return;
    // This process was spawned here. Never signal a process group or the browser.
    child.kill("SIGTERM");
    if (!(await this.waitForExit(3000)))
      throw new Error(
        `Preview tool process exit is unconfirmed (owned PID ${child.pid ?? "unavailable"}).`,
      );
  }
}

export async function createPreviewMcpClient(
  options: PreviewMcpClientOptions,
): Promise<{
  connected(): boolean;
  list(): Promise<
    { name: string; description?: string; inputSchema: JsonObject }[]
  >;
  call(name: string, args: JsonObject): Promise<CallToolResult>;
  close(): Promise<void>;
}> {
  const endpoint = new URL(options.endpoint);
  if (
    endpoint.protocol !== "ws:" ||
    endpoint.hostname !== "127.0.0.1" ||
    !endpoint.port ||
    !/^\/devtools\/browser\/[^/]+$/.test(endpoint.pathname) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error("A scoped local preview endpoint is required.");
  if (
    !isAbsolute(options.command) ||
    !options.env ||
    options.args.some((arg) => arg.startsWith("--") || arg.includes("\0"))
  )
    throw new Error(
      "An explicit trusted preview command and environment are required.",
    );
  const transport = new PreviewStdioTransport(options, [
    ...options.args,
    "--wsEndpoint",
    endpoint.href,
    "--no-usage-statistics",
    "--no-performance-crux",
    "--no-file-navigations",
    "--no-category-emulation",
    "--no-category-performance",
    "--no-category-network",
    "--no-category-memory",
    "--no-category-extensions",
    "--no-category-pwa",
    "--no-category-experimental-third-party",
    "--no-category-experimental-webmcp",
  ]);
  const client = new Client(
    { name: "crew-project-preview", version: "1.0.0" },
    { capabilities: {} },
  );
  let connectionOpen = true;
  client.onclose = () => {
    connectionOpen = false;
    options.onDisconnect?.();
  };
  try {
    await client.connect(transport, { timeout: 30_000 });
  } catch {
    // Surface uncertain cleanup rather than reporting an already-clean failure.
    await transport.close();
    throw new Error("Preview tools could not connect.");
  }
  let closed = false;
  let catalogue: Set<string> | undefined;
  return {
    connected: () => !closed && connectionOpen,
    async list() {
      if (closed) throw new Error("Preview tools are closed.");
      if (!connectionOpen) throw new Error("Preview tools are disconnected.");
      const tools: {
        name: string;
        description?: string;
        inputSchema: JsonObject;
      }[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, {
          timeout: 30_000,
        });
        if (closed || !connectionOpen)
          throw new Error("Preview tools are disconnected.");
        for (const tool of page.tools) {
          if (allowedTools.has(tool.name))
            tools.push({
              name: tool.name,
              ...(tool.description ? { description: tool.description } : {}),
              inputSchema: tool.inputSchema as JsonObject,
            });
        }
        cursor = page.nextCursor;
        if (
          seen.size >= 20 ||
          (cursor && seen.has(cursor)) ||
          tools.length > 100
        )
          throw new Error("Preview tool catalogue exceeds supported bounds.");
        if (cursor) seen.add(cursor);
      } while (cursor);
      catalogue = new Set(tools.map((tool) => tool.name));
      return tools;
    },
    async call(name, args) {
      if (
        closed ||
        !connectionOpen ||
        !allowedTools.has(name) ||
        !catalogue?.has(name)
      )
        throw new Error(
          "Preview tool is unavailable; discover its current schema first.",
        );
      // 1.12 requires pageId on page-scoped tools; keep the real upstream schema.
      // A timeout or lost response may follow a mutation. Never retry this call.
      try {
        return CallToolResultSchema.parse(
          await client.callTool(
            { name, arguments: args },
            CallToolResultSchema,
            { timeout: 60_000 },
          ),
        );
      } catch {
        throw new Error(
          "Preview tool outcome is uncertain. Observe the page before taking further action; this request was not retried.",
        );
      }
    },
    async close() {
      closed = true;
      await transport.close();
    },
  };
}
