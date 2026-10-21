import path from "node:path";
import { writeFile, rename } from "node:fs/promises";
import type { Project, TaskRecord } from "./contracts.mjs";
import type { RunnerRecord } from "./evidence.mjs";
export function evidencePath(task: TaskRecord, name: string): string {
  if (!task.runDir)
    throw new Error("Worker run evidence directory is unavailable.");
  return path.join(task.runDir, name);
}
export function environmentHooks(project: Project | null) {
  const env = project?.worker.environment;
  return {
    bootstrap: env?.bootstrap,
    start: env?.start,
    resume: env?.resume,
    ready: env?.ready,
    cleanup: env?.cleanup,
  };
}
export async function atomic(file: string, value: unknown) {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, file);
}
export const confirmedExit = (
  task: TaskRecord,
  exit: RunnerRecord | null,
): exit is RunnerRecord & { stopConfirmed: true } =>
  Boolean(exit && exit.runId === task.runId && exit.stopConfirmed === true);
