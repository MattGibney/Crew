import { parseRecord, record } from "../shared/errors.mjs";
import type { PromptSnapshot } from "../shared/prompts.mjs";
export interface RetainedManager {
  projectId: string;
  intent: "running" | "stopped";
  active: PromptSnapshot;
}
export function parseRetainedManager(
  text: string,
  projectId: string,
): RetainedManager {
  const value = parseRecord(text);
  if (
    value.projectId !== projectId ||
    (value.intent !== "running" && value.intent !== "stopped") ||
    !record(value.active) ||
    typeof value.active.text !== "string" ||
    typeof value.active.version !== "string"
  )
    throw new Error(
      "Invalid manager lifecycle record. Preserve it and inspect this project’s settings.",
    );
  return {
    projectId,
    intent: value.intent,
    active: { text: value.active.text, version: value.active.version },
  };
}
