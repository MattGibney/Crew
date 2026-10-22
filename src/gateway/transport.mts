import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallerContext, JsonObject } from "../agents/contracts.mjs";
import { withStateLock } from "../orchestration/state-lock.mjs";
import { atomicJson } from "./store.mjs";
import { canonicalJson, sha256 } from "./json.mjs";
import { createGatewayMcpServer } from "./mcp.mjs";
import type { DurableOperationBroker } from "./broker.mjs";

/** Request IDs belong to a transport generation, not to an agent forever.
 * #88 supplies an authenticated, durable native request key when available; when
 * JSON-RPC IDs are used, its epoch must change for a new client that resets IDs.
 * Reconnect/re-delivery of the SAME native request must preserve that key. */
export interface GatewayNativeRequest {
  epoch: string;
  requestId: string | number;
}
export class GatewayRequestJournal {
  constructor(private readonly directory: string) {}
  async initialize(): Promise<void> {
    if (!isAbsolute(this.directory))
      throw new Error("Gateway journal path must be absolute.");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.mode & 0o077 ||
      info.uid !== process.getuid?.()
    )
      throw new Error(
        "Gateway request journal must be private and owner controlled.",
      );
  }
  async resolve(
    caller: CallerContext,
    native: GatewayNativeRequest,
    request: JsonObject,
  ): Promise<string> {
    if (
      !native.epoch ||
      native.epoch.length > 512 ||
      !["string", "number"].includes(typeof native.requestId)
    )
      throw new Error("Trusted native request identity is required.");
    const key = sha256(canonicalJson({ caller, native }));
    const fingerprint = sha256(canonicalJson(request));
    const invocationId = `gw_${key}`;
    const file = join(this.directory, `${key}.json`);
    return withStateLock(this.directory, `${key}.lock`, async () => {
      try {
        const handle = await open(
          file,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const info = await handle.stat();
          if (
            !info.isFile() ||
            info.nlink !== 1 ||
            info.size > 2048 ||
            info.mode & 0o077 ||
            info.uid !== process.getuid?.()
          )
            throw new Error("Invalid gateway request identity record.");
          const saved: unknown = JSON.parse(await handle.readFile("utf8"));
          if (
            !saved ||
            typeof saved !== "object" ||
            canonicalJson(saved) !==
              canonicalJson({ version: 1, invocationId, fingerprint })
          )
            throw new Error(
              "Native request identity was reused for different tool arguments.",
            );
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (!(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        ))
          throw error;
        await atomicJson(file, { version: 1, invocationId, fingerprint });
      }
      return invocationId;
    });
  }
}

/** Bind the real gateway server to #88's authenticated transport. The host owns
 * listener/token/session lifetime and must close this binding on logical Stop.
 * No owner/admin or service credential is accepted through this boundary. */
export async function attachGatewayMcpTransport(options: {
  broker: DurableOperationBroker;
  transport: Transport;
  journal: GatewayRequestJournal;
  authenticatedCaller(): Promise<CallerContext | null>;
  nativeRequest(requestId: string | number): Promise<GatewayNativeRequest>;
}): Promise<{ close(): Promise<void> }> {
  const server = createGatewayMcpServer({
    broker: options.broker,
    authenticatedCaller: options.authenticatedCaller,
    invocationIdForRequest: async (requestId, request) => {
      const caller = await options.authenticatedCaller();
      if (!caller) throw new Error("Authenticated Crew session required.");
      return options.journal.resolve(
        caller,
        await options.nativeRequest(requestId),
        request,
      );
    },
  });
  try {
    await server.connect(options.transport);
  } catch {
    await server.close().catch(() => {});
    throw new Error("Gateway transport could not be attached.");
  }
  return { close: () => server.close() };
}
