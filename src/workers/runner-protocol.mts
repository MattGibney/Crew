import { Ajv } from "ajv";
import type { DiagnosticSnapshot } from "../http/diagnostics.mjs";
export interface CommandConfiguration {
  id: string;
  taskId: string;
  worktree: string;
  environmentId: string;
  command: string;
  args: string[];
  timeoutMs: number;
  cooperative?: boolean;
}
const configShape = new Ajv({ strict: false }).compile<CommandConfiguration>({
  type: "object",
  required: ["id", "worktree", "environmentId", "command", "args"],
  properties: {
    id: { type: "string" },
    taskId: { type: "string" },
    worktree: { type: "string" },
    environmentId: { type: "string" },
    command: { type: "string" },
    args: { type: "array", items: { type: "string" } },
    timeoutMs: { type: "number" },
    cooperative: { type: "boolean" },
  },
});
export function parseCommandConfiguration(
  value: unknown,
): CommandConfiguration {
  if (!configShape(value))
    throw new Error("Malformed command supervisor configuration.");
  return value;
}
export interface CommandEvent {
  type: string;
  pid?: number;
  diagnostics?: DiagnosticSnapshot;
  code?: number | null;
  error?: string | null;
}
const eventShape = new Ajv({ strict: false }).compile<CommandEvent>({
  type: "object",
  required: ["type"],
  properties: {
    type: { type: "string" },
    pid: { type: "number" },
    code: { type: ["number", "null"] },
    error: { type: ["string", "null"] },
    diagnostics: {
      type: "object",
      required: ["text"],
      properties: { text: { type: "string" } },
    },
  },
});
export function parseCommandEvent(value: unknown): CommandEvent {
  if (!eventShape(value))
    throw new Error("Malformed command supervisor event.");
  return value;
}
export interface StopControl {
  id: string;
  environmentId?: string;
  action: string;
  cooperative?: boolean;
  reason?: string;
}
const controlShape = new Ajv({ strict: false }).compile<StopControl>({
  type: "object",
  required: ["id", "action"],
  properties: {
    id: { type: "string" },
    environmentId: { type: "string" },
    action: { type: "string" },
    cooperative: { type: "boolean" },
    reason: { type: "string" },
  },
});
export function parseStopControl(value: unknown): StopControl {
  if (!controlShape(value)) throw new Error("Malformed command control.");
  return value;
}
