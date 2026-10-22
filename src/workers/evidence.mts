import { readFile } from "node:fs/promises";
import { Ajv } from "ajv";
import type { EnvironmentEvidence } from "./contracts.mjs";
import { errorCode } from "./errors.mjs";
const ajv = new Ajv({ strict: false });
const environmentShape = ajv.compile<EnvironmentEvidence>({
  type: "object",
  required: ["id", "taskId", "worktree", "hooks"],
  properties: {
    id: { type: "string" },
    taskId: { type: "string" },
    worktree: { type: "string" },
    hooks: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "phase", "status"],
        properties: {
          id: { type: "string" },
          phase: { type: "string" },
          runDir: { type: "string" },
          status: { type: "string" },
        },
      },
    },
  },
});
export async function readEnvironmentEvidence(
  file: string,
): Promise<EnvironmentEvidence | null> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!environmentShape(value))
      throw new Error(
        "Malformed environment evidence; preserve the retained state.",
      );
    return value;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}
export interface CommandExit {
  id: string;
  confirmed: boolean;
  status: string;
  exitCode: number | null;
  timedOut?: boolean;
  canceled?: boolean;
  at: string;
  diagnostics?: unknown;
  error?: string;
}
const exitShape = ajv.compile<CommandExit>({
  type: "object",
  required: ["id", "confirmed", "status", "at"],
  properties: {
    id: { type: "string" },
    confirmed: { type: "boolean" },
    status: { type: "string" },
    at: { type: "string" },
    exitCode: { type: ["number", "null"] },
    timedOut: { type: "boolean" },
    canceled: { type: "boolean" },
    error: { type: ["string", "null"] },
  },
});
export async function readCommandExit(
  file: string,
): Promise<CommandExit | null> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!exitShape(value))
      throw new Error(
        "Malformed command exit evidence; preserve the retained state.",
      );
    return value;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}
export interface RunnerRecord {
  assignmentId?: string;
  fingerprint?: string;
  records?: import("../processes/ownership.mjs").ProcessIdentity[];
  ownership?: {
    remaining?: RetainedProcessObservation[];
    tracked?: RetainedProcessObservation[];
    confirmed?: boolean;
  };
  connectionClosed?: boolean;
  id?: string;
  environmentId?: string;
  runId?: string;
  taskId?: string;
  threadId?: string | null;
  turnId?: string | null;
  pid?: number;
  supervisorPid?: number;
  workerPid?: number | null;
  supervisorIdentity?: import("../processes/ownership.mjs").ProcessIdentity;
  identity?: import("../processes/ownership.mjs").ProcessIdentity;
  at?: string;
  stopConfirmed?: boolean;
  confirmed?: boolean;
  completedTurn?: boolean;
  exitCode?: number | null;
  commands?: { command: string; exitCode?: number | null; output?: string }[];
  stopped?: boolean;
  stopAction?: string | null;
  nativeTurnStatus?: string | null;
  error?: string | null;
  finalMessage?: string;
  workerPrompt?: string;
  requestId?: string;
  status?: string;
  message?: string;
  runtime?: unknown;
  repo?: string;
  base?: string;
  commit?: string;
}
// Historical terminal records may retain only a PID. These observations describe
// retained resources; active process registries require full verified identities.
export interface RetainedProcessObservation {
  pid: number;
  ppid?: number;
  start?: string;
  commandHash?: string;
  depth?: number;
  identityVerified?: boolean;
}
const identityShape = {
  type: "object",
  required: ["pid", "ppid", "start", "commandHash"],
  properties: {
    pid: { type: "number" },
    ppid: { type: "number" },
    start: { type: "string" },
    commandHash: { type: "string" },
  },
};
const retainedProcessShape = {
  ...identityShape,
  required: ["pid"],
  properties: {
    ...identityShape.properties,
    depth: { type: "number" },
    identityVerified: { type: "boolean" },
  },
};
const runnerShape = ajv.compile<RunnerRecord>({
  type: "object",
  properties: {
    connectionClosed: { type: "boolean" },
    assignmentId: { type: "string" },
    fingerprint: { type: "string" },
    records: { type: "array", items: identityShape },
    ownership: {
      type: "object",
      properties: {
        confirmed: { type: "boolean" },
        remaining: {
          type: "array",
          items: retainedProcessShape,
        },
        tracked: {
          type: "array",
          items: retainedProcessShape,
        },
      },
    },
    id: { type: "string" },
    environmentId: { type: "string" },
    runId: { type: "string" },
    taskId: { type: "string" },
    threadId: { type: ["string", "null"] },
    turnId: { type: ["string", "null"] },
    pid: { type: "number" },
    supervisorPid: { type: "number" },
    workerPid: { type: ["number", "null"] },
    supervisorIdentity: { anyOf: [identityShape, { type: "null" }] },
    identity: { anyOf: [identityShape, { type: "null" }] },
    at: { type: "string" },
    stopConfirmed: { type: "boolean" },
    confirmed: { type: "boolean" },
    completedTurn: { type: "boolean" },
    exitCode: { type: ["number", "null"] },
    commands: {
      type: "array",
      items: {
        type: "object",
        required: ["command"],
        properties: {
          command: { type: "string" },
          exitCode: { type: ["number", "null"] },
          output: { type: "string" },
        },
      },
    },
    stopped: { type: "boolean" },
    stopAction: { type: ["string", "null"] },
    nativeTurnStatus: { type: ["string", "null"] },
    error: { type: ["string", "null"] },
    finalMessage: { type: "string" },
    workerPrompt: { type: "string" },
    requestId: { type: "string" },
    status: { type: "string" },
    message: { type: "string" },
    repo: { type: "string" },
    base: { type: "string" },
    commit: { type: "string" },
  },
});
export async function readRunnerRecord(
  file: string,
): Promise<RunnerRecord | null> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!runnerShape(value))
      throw new Error(
        "Malformed runner evidence; preserve the retained state.",
      );
    return value;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}
