import type { ExecutionPlan, ScriptAction } from "../execution/contracts.mjs";
// Preserve local runtime choices while refreshing discovered commands and permissions.
import type { RawExecutionPlan } from "../config/contracts.mjs";
export function selectExecutionPlan({
  discovered,
  saved = null,
  action = null,
}: {
  discovered: RawExecutionPlan;
  saved?: RawExecutionPlan | null;
  action?: Pick<ScriptAction, "command" | "source"> | null;
}): RawExecutionPlan {
  const next = structuredClone(discovered);
  if (action) {
    next.start = {
      command: action.command,
      source: action.source,
      timeoutMs: 600000,
    };
    next.resume = structuredClone(next.start);
  }
  if (!saved) return next;
  const merged = {
    ...structuredClone(saved),
    schemaVersion: next.schemaVersion,
    sources: next.sources,
  };
  for (const phase of ["setup", "start"] as const)
    merged[phase] = next[phase]
      ? {
          ...next[phase],
          timeoutMs: saved[phase]?.timeoutMs || next[phase].timeoutMs,
        }
      : null;
  merged.resume =
    saved.resume && saved.resume.command !== saved.start?.command
      ? structuredClone(saved.resume)
      : next.resume
        ? {
            ...next.resume,
            timeoutMs: saved.resume?.timeoutMs || next.resume.timeoutMs,
          }
        : null;
  if (typeof next.networkAccess === "boolean")
    merged.networkAccess = next.networkAccess;
  else delete merged.networkAccess;
  if (next.permissionsSource) merged.permissionsSource = next.permissionsSource;
  else delete merged.permissionsSource;
  return merged;
}
