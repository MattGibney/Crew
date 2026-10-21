import type { ProjectConfig, SetupBridge } from "../contracts/setup.js";
export function requireBridge(): SetupBridge {
  if (!window.crewSetup)
    throw new Error("Setup requires the Crew desktop bridge.");
  return window.crewSetup;
}
export function noticeFrom(value: unknown): string | undefined {
  return value &&
    typeof value === "object" &&
    "notice" in value &&
    typeof value.notice === "string"
    ? value.notice
    : undefined;
}
function mutableRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
const editablePaths = new Set([
  "runtime.codexBinary",
  "runtime.port",
  "runtime.dataDir",
  "project.id",
  "project.name",
  "project.context",
  "project.mode",
  "project.worker.maxConcurrent",
  "project.repositories",
  "project.linear",
  "project.linear.teamId",
  "project.linear.teamKey",
  "project.linear.projectId",
  "project.prompts.manager",
  "project.prompts.worker",
]);
/** Declared optional fields may be absent in older configs. Backend validates before persistence. */
export function setDraftPath(
  config: ProjectConfig,
  keys: string[],
  value: unknown,
): void {
  if (!editablePaths.has(keys.join(".")))
    throw new Error("Unknown configuration field.");
  let target: unknown = config;
  for (const key of keys.slice(0, -1)) {
    if (!mutableRecord(target) || !(key in target))
      throw new Error("Unknown configuration field.");
    target = target[key];
  }
  const key = keys.at(-1);
  if (!key || !mutableRecord(target))
    throw new Error("Unknown configuration field.");
  target[key] = value;
}
export function readDraftPath(
  config: ProjectConfig,
  path: string,
): string | number | undefined {
  let value: unknown = config;
  for (const key of path.split(".")) {
    if (!mutableRecord(value)) return undefined;
    value = value[key];
  }
  return typeof value === "string" || typeof value === "number"
    ? value
    : undefined;
}
