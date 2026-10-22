import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { Ajv } from "ajv";
import { withStateLock } from "../orchestration/state-lock.mjs";
import type {
  AuthorizationSettlement,
  BrokerInvocation,
  BrokerResult,
  CallerContext,
  JsonObject,
  OperationReceipt,
} from "../agents/contracts.mjs";
import { canonicalJson, sha256 } from "./json.mjs";

export interface StoredOperation {
  version: 1;
  inputSchema: JsonObject; // Immutable schema/defaults for identity checks without upstream availability.
  receipt: OperationReceipt;
  invocation: BrokerInvocation | null; // Only unresolved intent retains exact arguments.
  result: BrokerResult | null; // Success bodies live in native history, never this journal.
  settlement: { attemptId: string; result: AuthorizationSettlement } | null;
}
const string = { type: "string" };
const nullable = { type: ["string", "null"] };
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const caller = object({
  projectId: string,
  agentId: string,
  sessionId: string,
});
const operation = {
  invocationId: string,
  connectionId: string,
  operation: string,
  argumentsFingerprint: string,
};
const outcome = {
  enum: ["pending", "succeeded", "not_executed", "uncertain", "failed"],
};
const validate = new Ajv({ strict: false }).compile<StoredOperation>(
  object({
    version: { const: 1 },
    inputSchema: { type: "object" },
    receipt: object({
      id: string,
      caller,
      jobId: nullable,
      operation: object(operation),
      reservationId: nullable,
      grantId: nullable,
      attempts: {
        type: "array",
        maxItems: 4,
        items: object({
          id: string,
          number: { enum: [1, 2, 3, 4] },
          startedAt: string,
          settledAt: nullable,
          outcome,
          evidenceRef: nullable,
        }),
      },
      outcome,
      externalReference: nullable,
      verificationRef: nullable,
      startedAt: string,
      settledAt: nullable,
    }),
    invocation: {
      anyOf: [
        { type: "null" },
        object({
          caller,
          jobId: nullable,
          createdAt: string,
          operation: object({ ...operation, arguments: { type: "object" } }),
        }),
      ],
    },
    result: {
      anyOf: [
        { type: "null" },
        object({
          state: { const: "succeeded" },
          receiptId: string,
          content: { type: "array", maxItems: 0 },
        }),
        object({
          state: { const: "approval_required" },
          accessRequestId: string,
        }),
        object({ state: { const: "denied" }, reason: string }),
        object({
          state: { enum: ["not_executed", "uncertain", "failed"] },
          receiptId: string,
          reason: string,
        }),
      ],
    },
    settlement: {
      anyOf: [
        { type: "null" },
        object({
          attemptId: string,
          result: {
            anyOf: [
              object({
                state: { enum: ["accepted", "uncertain"] },
                receiptId: string,
              }),
              object({
                state: { const: "not_executed" },
                receiptId: string,
                evidence: string,
              }),
            ],
          },
        }),
      ],
    },
  }),
);

export const operationKey = (caller: CallerContext, invocationId: string) =>
  sha256(canonicalJson([caller.projectId, invocationId]));

export async function atomicJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(canonicalJson(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    const directory = await open(join(file, ".."), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

/** One operation lock spans dispatch. A contender never executes on lock failure.
 * Crash recovery uses the existing verified-process ownership lock, not a TTL. */
export class GatewayStore {
  constructor(readonly directory: string) {}
  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077)
      throw new Error("Gateway state requires a private owner-only directory.");
  }
  async locked<T>(key: string, action: () => Promise<T>): Promise<T> {
    return withStateLock(this.directory, `operation-${key}.lock`, action);
  }
  async read(key: string): Promise<StoredOperation | null> {
    try {
      const file = join(this.directory, `${key}.json`);
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024)
        throw new Error("Invalid gateway receipt file.");
      const value: unknown = JSON.parse(await readFile(file, "utf8"));
      if (!validate(value))
        throw new Error("Invalid gateway receipt; retained for inspection.");
      return value;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return null;
      throw error;
    }
  }
  async save(key: string, record: StoredOperation): Promise<void> {
    const compact = {
      ...record,
      result:
        record.result?.state === "succeeded"
          ? { ...record.result, content: [] }
          : record.result,
    };
    if (!validate(compact)) throw new Error("Invalid gateway receipt write.");
    await atomicJson(join(this.directory, `${key}.json`), compact);
  }
  async cancel(key: string): Promise<void> {
    await atomicJson(join(this.directory, `${key}.cancel`), {
      cancelled: true,
    });
  }
  async isCancelled(key: string): Promise<boolean> {
    try {
      await lstat(join(this.directory, `${key}.cancel`));
      return true;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return false;
      throw error;
    }
  }
  async all(): Promise<StoredOperation[]> {
    const result: StoredOperation[] = [];
    for (const name of await readdir(this.directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const record = await this.read(name.slice(0, -5));
      if (record) result.push(record);
    }
    return result;
  }
}
