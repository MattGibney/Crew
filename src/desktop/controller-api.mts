import { record } from "./validation.mjs";
import type { DesktopApiReply } from "./host-contracts.mjs";

export function parseControllerReply(input: unknown): DesktopApiReply {
  const value = record(input, "Local controller response");
  // A successful HTTP response is still an untrusted process boundary. Validate
  // the fields consumed by native ownership, attention and update coordination.
  const reply: DesktopApiReply = { ...value };
  if (value.error !== undefined) {
    if (value.error !== null && typeof value.error !== "string")
      throw new Error("Invalid controller error.");
    reply.error = value.error;
  }
  if (value.tasks !== undefined) {
    if (!Array.isArray(value.tasks))
      throw new Error("Invalid controller tasks.");
    reply.tasks = value.tasks.map((input) => {
      const task = record(input);
      if (typeof task.status !== "string")
        throw new Error("Invalid controller task status.");
      return {
        ...task,
        status: task.status,
        attention: Array.isArray(task.attention)
          ? task.attention.map((input) => {
              const attention = record(input);
              return {
                ackedAt:
                  typeof attention.ackedAt === "string"
                    ? attention.ackedAt
                    : null,
              };
            })
          : [],
      };
    });
  }
  if (value.requests !== undefined) {
    if (!Array.isArray(value.requests))
      throw new Error("Invalid controller approval list.");
    reply.requests = value.requests;
  }
  if (value.activeTurnId !== undefined && value.activeTurnId !== null) {
    if (typeof value.activeTurnId !== "string")
      throw new Error("Invalid controller turn.");
    reply.activeTurnId = value.activeTurnId;
  }
  for (const key of [
    "voiceActive",
    "voiceConnecting",
    "marked",
    "reserved",
    "safe",
  ] as const)
    if (value[key] !== undefined) {
      if (typeof value[key] !== "boolean")
        throw new Error("Invalid controller lifecycle response.");
      reply[key] = value[key];
    }
  for (const key of ["reasons", "notices"] as const)
    if (value[key] !== undefined) {
      if (
        !Array.isArray(value[key]) ||
        !value[key].every((item: unknown) => typeof item === "string")
      )
        throw new Error("Invalid controller activity details.");
      reply[key] = value[key];
    }
  if (value.plan !== undefined) {
    if (value.plan === null) reply.plan = null;
    else {
      const plan = record(value.plan);
      if (
        typeof plan.id !== "string" ||
        typeof plan.phase !== "string" ||
        typeof plan.kind !== "string" ||
        typeof plan.consent !== "boolean" ||
        !(plan.targetVersion === null || typeof plan.targetVersion === "string")
      )
        throw new Error("Invalid controller update plan.");
      reply.plan = {
        ...plan,
        id: plan.id,
        phase: plan.phase,
        kind: plan.kind,
        consent: plan.consent,
        targetVersion: plan.targetVersion,
      };
    }
  }
  return reply;
}
