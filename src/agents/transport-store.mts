import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  rename,
  rm,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type { CallerContext, JsonObject } from "./contracts.mjs";
import { canonicalJson } from "../gateway/json.mjs";

export interface NativeToolReceipt {
  key: string;
  caller: CallerContext;
  channel: "foundation" | "gateway";
  transportId: string;
  requestId: string | number;
  fingerprint: string;
  invocationId: string;
  state: "identified" | "attempted" | "completed" | "uncertain";
  resultReferences: JsonObject;
  updatedAt: string;
}
const LIMIT = 16 * 1024 * 1024;
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const identity = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  !/[\u0000-\u001f\u007f]/.test(value);
const callerValid = (value: CallerContext) =>
  value &&
  Object.keys(value).length === 3 &&
  identity(value.projectId) &&
  identity(value.agentId) &&
  identity(value.sessionId);
const now = () => new Date().toISOString();

/** Durable correlation only: no bearer, request body, native chat or tool result
 * body is retained here. A recovered attempted mutation is never replayed. */
export class NativeTransportStore {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private failed = false;
  private closing: Promise<void> | null = null;
  private constructor(
    private directory: string,
    private projectId: string,
    private records: NativeToolReceipt[],
    private lease: FileHandle,
  ) {}

  static async open(
    directory: string,
    projectId: string,
  ): Promise<NativeTransportStore> {
    if (!isAbsolute(directory) || !identity(projectId))
      throw new Error("Invalid transport store identity.");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.mode & 0o077 ||
      stat.uid !== process.getuid?.()
    )
      throw new Error(
        "Transport store must be private and owned by the controller.",
      );
    const lease = await open(join(directory, "transport.lock"), "wx", 0o600);
    try {
      await lease.writeFile(
        JSON.stringify({ pid: process.pid, token: randomUUID() }),
      );
      await lease.sync();
      let records: NativeToolReceipt[] = [];
      try {
        const file = await open(
          join(directory, "transport.json"),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const info = await file.stat();
          if (
            !info.isFile() ||
            info.nlink !== 1 ||
            info.size > LIMIT ||
            info.mode & 0o077 ||
            info.uid !== process.getuid?.()
          )
            throw new Error("Unsafe transport state.");
          const value = JSON.parse(await file.readFile("utf8"));
          if (
            value?.schema !== 1 ||
            value.projectId !== projectId ||
            !Array.isArray(value.receipts)
          )
            throw new Error("Invalid transport state.");
          records = value.receipts;
          for (const receipt of records) {
            if (
              !receipt ||
              !callerValid(receipt.caller) ||
              receipt.caller.projectId !== projectId ||
              !identity(receipt.transportId) ||
              !identity(receipt.invocationId) ||
              !["foundation", "gateway"].includes(receipt.channel) ||
              !["identified", "attempted", "completed", "uncertain"].includes(
                receipt.state,
              ) ||
              !/^[a-f0-9]{64}$/.test(receipt.key) ||
              !/^[a-f0-9]{64}$/.test(receipt.fingerprint) ||
              !(
                identity(receipt.requestId) ||
                Number.isSafeInteger(receipt.requestId)
              ) ||
              receipt.key !== NativeTransportStore.key(receipt) ||
              !receipt.resultReferences ||
              typeof receipt.resultReferences !== "object" ||
              Array.isArray(receipt.resultReferences) ||
              Object.keys(receipt.resultReferences).some(
                (key) =>
                  ![
                    "id",
                    "agentId",
                    "jobId",
                    "messageId",
                    "helpRequestId",
                    "receiptId",
                  ].includes(key),
              ) ||
              Object.values(receipt.resultReferences).some(
                (value) => !identity(value),
              )
            )
              throw new Error("Invalid transport receipt.");
          }
          if (
            new Set(records.map((entry) => entry.key)).size !== records.length
          )
            throw new Error("Duplicate transport receipt.");
        } finally {
          await file.close();
        }
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure;
      }
      const store = new NativeTransportStore(
        directory,
        projectId,
        records,
        lease,
      );
      // A previous process may have dispatched before it lost its reply.
      for (const receipt of records)
        if (receipt.state === "attempted") receipt.state = "uncertain";
      await store.persist(records);
      return store;
    } catch {
      try {
        await NativeTransportStore.releaseLease(directory, lease);
      } finally {
        // Failed opening returns no store to retry; retain any unresolved lock,
        // but do not leak this process's file descriptor.
        await lease.close().catch(() => {});
      }
      throw new Error(
        "Transport state could not be opened; preserve it for recovery.",
      );
    }
  }

  private static async releaseLease(
    directory: string,
    lease: FileHandle,
  ): Promise<void> {
    const path = join(directory, "transport.lock");
    let current;
    try {
      current = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await lease.close();
      return;
    }
    const held = await lease.stat();
    if (
      current.isFile() &&
      current.dev === held.dev &&
      current.ino === held.ino
    )
      await unlink(path);
    // A failed unlink retains the handle for ownership verification on retry.
    // A replacement belongs to another writer and is never removed here.
    await lease.close();
  }

  private static key(
    input: Pick<
      NativeToolReceipt,
      "caller" | "channel" | "transportId" | "requestId"
    >,
  ) {
    return digest(
      canonicalJson({
        caller: input.caller,
        channel: input.channel,
        transportId: input.transportId,
        requestId: input.requestId,
      }),
    );
  }
  private async persist(receipts: NativeToolReceipt[]): Promise<void> {
    const text = JSON.stringify({
      schema: 1,
      projectId: this.projectId,
      receipts,
    });
    if (Buffer.byteLength(text) > LIMIT)
      throw new Error(
        "Transport receipt bound reached; owner maintenance required.",
      );
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(text);
      await file.sync();
      await file.close();
      await rename(temporary, join(this.directory, "transport.json"));
      const directory = await open(this.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await file.close().catch(() => {});
      await rm(temporary, { force: true });
    }
  }
  private transaction<T>(
    change: (draft: NativeToolReceipt[]) => T,
  ): Promise<T> {
    const result = this.tail.then(async () => {
      if (this.closed || this.failed)
        throw new Error("Transport state unavailable.");
      const draft = structuredClone(this.records);
      const result = change(draft);
      try {
        await this.persist(draft);
      } catch {
        this.failed = true;
        throw new Error("Transport receipt could not be committed.");
      }
      this.records = draft;
      return structuredClone(result);
    });
    this.tail = result.catch(() => {});
    return result;
  }
  identify(
    input: Pick<
      NativeToolReceipt,
      "caller" | "channel" | "transportId" | "requestId"
    >,
    request: JsonObject,
  ): Promise<NativeToolReceipt> {
    if (
      !callerValid(input.caller) ||
      input.caller.projectId !== this.projectId ||
      !identity(input.transportId) ||
      !(identity(input.requestId) || Number.isSafeInteger(input.requestId))
    )
      return Promise.reject(
        new Error("Invalid authenticated request identity."),
      );
    const key = NativeTransportStore.key(input);
    const fingerprint = digest(canonicalJson(request));
    return this.transaction((draft) => {
      const existing = draft.find((entry) => entry.key === key);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new Error(
            "MCP request identity was reused for different input.",
          );
        return existing;
      }
      const created: NativeToolReceipt = {
        ...structuredClone(input),
        key,
        fingerprint,
        invocationId: randomUUID(),
        state: "identified",
        resultReferences: {},
        updatedAt: now(),
      };
      draft.push(created);
      return created;
    });
  }
  claim(
    key: string,
  ): Promise<{ dispatch: boolean; receipt: NativeToolReceipt }> {
    return this.transaction((draft) => {
      const receipt = draft.find((entry) => entry.key === key);
      if (!receipt) throw new Error("Unknown transport request.");
      if (receipt.state !== "identified") return { dispatch: false, receipt };
      receipt.state = "attempted";
      receipt.updatedAt = now();
      return { dispatch: true, receipt };
    });
  }
  settle(
    key: string,
    state: "completed" | "uncertain",
    result: unknown,
  ): Promise<void> {
    return this.transaction((draft) => {
      const receipt = draft.find((entry) => entry.key === key);
      if (!receipt || receipt.state === "completed") return;
      receipt.state = state;
      receipt.updatedAt = now();
      if (state === "completed" && result && typeof result === "object") {
        for (const name of [
          "id",
          "agentId",
          "jobId",
          "messageId",
          "helpRequestId",
          "receiptId",
        ])
          if (identity((result as Record<string, unknown>)[name]))
            receipt.resultReferences[name] = (result as Record<string, string>)[
              name
            ];
      }
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const operation = this.tail.then(() =>
      NativeTransportStore.releaseLease(this.directory, this.lease),
    );
    this.closing = operation;
    void operation.catch(() => {
      if (this.closing === operation) this.closing = null;
    });
    return operation;
  }
}
