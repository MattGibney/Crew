import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  TaskRecord,
  WorkerEnvironmentConfig,
} from "../workers/contracts.mjs";
import type { RuntimeProjectScope } from "../config/shape.mjs";
import { parseRuntimeProject } from "../config/shape.mjs";
import { parseRecord, record } from "../shared/errors.mjs";
import { readTask } from "./store.mjs";
import { createEnvironmentSettings } from "../projects/environment-settings.mjs";

/** Command context with execution environment values deliberately omitted. */
export async function projectEnvironmentContext({
  stateDir,
  role,
  taskId,
  runId,
  project,
  runtime,
  scoped,
}: {
  stateDir: string;
  role: string;
  taskId?: string;
  runId?: string;
  project: RuntimeProjectScope | null;
  runtime: Record<string, unknown> | null;
  scoped: (task: TaskRecord) => TaskRecord;
}) {
  const task = taskId ? scoped(await readTask(stateDir, taskId)) : null;
  let activeProject = project;
  let configuredEnvironment: unknown = project?.worker?.environment || null;
  if (role === "worker") {
    if (!task || !taskId || !runId || task.runId !== runId)
      throw new Error("Stale worker run");
    const config = parseRecord(
      await readFile(
        path.join(stateDir, "runs", taskId, runId, "config.json"),
        "utf8",
      ),
    );
    activeProject = config.project ? parseRuntimeProject(config.project) : null;
    if (
      config.taskId !== taskId ||
      config.runId !== runId ||
      (activeProject?.id && activeProject.id !== task.projectId)
    )
      throw new Error(
        "Worker environment context identity does not match its bound run",
      );
    configuredEnvironment = activeProject?.worker?.environment || null;
  } else if (typeof runtime?.environmentConfigPath === "string") {
    const settings = await createEnvironmentSettings({
      configuration: { configPath: runtime.environmentConfigPath, project },
    });
    configuredEnvironment = (await settings.read()).environment;
  }
  const context = record(configuredEnvironment)
    ? structuredClone(configuredEnvironment)
    : null;
  if (record(context?.executionPlan)) delete context.executionPlan.env;
  return {
    projectId: activeProject?.id || task?.projectId || null,
    taskId: taskId || null,
    configuredEnvironment: context,
    retainedEnvironment: task?.environment
      ? {
          id: task.environment.id,
          kind: task.environment.kind,
          status: task.environment.status,
          prepared: task.environment.prepared,
          hooks: task.environment.hooks?.map((hook) => ({
            phase: hook.phase,
            status: hook.status,
            exitCode: hook.exitCode,
          })),
          readinessKind: task.environment.readinessKind,
        }
      : null,
    executionPolicy:
      "Agents run project commands through native tools and approvals. Crew does not run setup or readiness as a dispatch precondition.",
  };
}
