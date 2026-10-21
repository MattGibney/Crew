import { Ajv } from "ajv";
import type { PausePlan } from "./contracts.mjs";
const text = { type: "string" };
const validate = new Ajv({ strict: false }).compile<PausePlan>({
  type: "object",
  required: [
    "schema",
    "kind",
    "consent",
    "id",
    "targetVersion",
    "fromVersion",
    "phase",
    "createdAt",
    "updatedAt",
    "targets",
    "progress",
    "reasons",
    "voiceClosed",
    "manager",
  ],
  properties: {
    schema: { const: 1 },
    kind: { const: "pause-update" },
    consent: { const: true },
    id: text,
    targetVersion: text,
    fromVersion: text,
    phase: text,
    createdAt: text,
    updatedAt: text,
    voiceClosed: { type: "boolean" },
    reasons: { type: "array", items: text },
    targets: {
      type: "array",
      items: {
        type: "object",
        required: [
          "taskId",
          "originalRunId",
          "originalStatus",
          "resumeEligible",
          "pauseActionId",
          "resumeActionId",
          "progress",
          "pauseConfirmed",
        ],
        properties: {
          taskId: text,
          originalRunId: { type: ["string", "null"] },
          originalStatus: text,
          resumeEligible: { type: "boolean" },
          pauseActionId: text,
          resumeActionId: text,
          progress: text,
          pauseConfirmed: { type: "boolean" },
        },
      },
    },
    progress: {
      type: "array",
      items: {
        type: "object",
        required: ["at", "message"],
        properties: { at: text, message: text, taskId: text },
      },
    },
    manager: {
      type: "object",
      required: [
        "originalActive",
        "originalTurnId",
        "interruptRequested",
        "interrupted",
      ],
      properties: {
        originalActive: { type: "boolean" },
        originalTurnId: { type: ["string", "null"] },
        interruptRequested: { type: "boolean" },
        interrupted: { type: "boolean" },
        interruptTurnId: { type: ["string", "null"] },
      },
    },
  },
});
export function parsePausePlan(text: string): PausePlan {
  const data: unknown = JSON.parse(text);
  if (!validate(data))
    throw new Error(
      "Update plan is malformed; review retained state before starting work.",
    );
  return data;
}
