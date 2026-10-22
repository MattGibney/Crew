// Pure desktop lifecycle rules, shared with focused tests.
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { activeTasks } from "../shared/worker-archive.mjs";
export interface TaskSummaryInput {
  error?: unknown;
  tasks?: Array<{
    status: string;
    execution?: { live?: boolean } | null;
    lifecycleRequests?: Array<{ status: string }>;
    attention?: Array<{ ackedAt?: string | null }>;
  }>;
}
export interface TaskCounts {
  active: number | null;
  pending: number | null;
}
export interface AudioPermissionDetails {
  requestingUrl?: string;
  securityOrigin?: string;
  mediaTypes?: string[];
  mediaType?: string;
}
export function instanceKey(configPath: string): string {
  return createHash("sha256")
    .update(resolve(configPath))
    .digest("hex")
    .slice(0, 24);
}
export function summarizeTasks(
  view: TaskSummaryInput | null | undefined,
): TaskCounts {
  if (!view || view.error || !Array.isArray(view.tasks))
    return { active: null, pending: null };
  const tasks = activeTasks(view.tasks);
  return {
    active: tasks.filter(
      (task) =>
        ![
          "completed",
          "failed",
          "canceled",
          "cancelled",
          "stopped",
          "paused",
          "disposed",
        ].includes(task.status),
    ).length,
    pending: tasks.reduce(
      (count, task) =>
        count + (task.attention || []).filter((item) => !item.ackedAt).length,
      0,
    ),
  };
}
export function isAppURL(url: string, origin: string | undefined): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.origin === origin &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}
export function isExternalHTTPS(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname !== "" &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}
export function permitsAudio(
  permission: string,
  details: AudioPermissionDetails,
  origin: string | undefined,
): boolean {
  if (
    permission !== "media" ||
    !isAppURL(details.requestingUrl || details.securityOrigin || "", origin)
  )
    return false;
  if (Array.isArray(details.mediaTypes))
    return (
      details.mediaTypes.length > 0 &&
      details.mediaTypes.every((type) => type === "audio")
    );
  return details.mediaType === "audio";
}
export function childEnvironment(
  configPath: string,
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...parent,
    ELECTRON_RUN_AS_NODE: "1",
    AI_MANAGER_CONFIG: configPath,
  };
  for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"])
    delete env[key];
  const paths = String(env.PATH || "")
    .split(":")
    .filter(Boolean);
  env.PATH = [
    ...new Set([
      ...paths,
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ]),
  ].join(":");
  return env;
}
