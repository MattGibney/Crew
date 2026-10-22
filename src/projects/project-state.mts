import { writeFile, rename } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type {
  EnvironmentEvidence,
  ProjectEnvironmentEvidence,
} from "../workers/contracts.mjs";
import type { EnvironmentContext } from "./project-context.mjs";
import { isRecord } from "../workers/errors.mjs";
import { readRunnerRecord } from "../workers/evidence.mjs";
import { environmentFile } from "./worker-environment.mjs";
import {
  snapshotProcesses,
  type ProcessSnapshot,
} from "../processes/ownership.mjs";
import { assertPlan } from "./project-integrity.mjs";
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : isRecord(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
export const executionPlanHash = (plan: unknown) =>
  digest(JSON.stringify(canonical(plan)));
const json = readRunnerRecord;
export async function save(file: string, value: unknown) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, file);
}
export function assertOwned(
  args: Pick<EnvironmentContext, "stateDir" | "taskId">,
  environment: EnvironmentEvidence | null,
): asserts environment is ProjectEnvironmentEvidence {
  if (
    environment?.kind !== "project-execution" ||
    environment.taskId !== args.taskId ||
    !/^crew-[a-f0-9]{32}$/.test(environment.id)
  )
    throw new Error("Project runtime identity does not match this task.");
  if (
    !environment.plan ||
    typeof environment.repositoryPath !== "string" ||
    typeof environment.baseCommit !== "string"
  )
    throw new Error("Project environment identity is incomplete.");
  assertPlan(environment.plan);
  if (
    environment.runtime &&
    (typeof environment.runtime.id !== "string" ||
      environment.runtime.runDir !==
        path.join(
          args.stateDir,
          "runs",
          args.taskId,
          "project-runtime",
          environment.runtime.id,
        ))
  )
    throw new Error("Runtime directory does not belong to this task.");
}
export async function persist(
  args: EnvironmentContext,
  environment: EnvironmentEvidence,
) {
  await save(environmentFile(args.stateDir, args.taskId), environment);
  await args.onEvidence?.(environment);
  return environment;
}
export async function runtimeState(
  environment: EnvironmentEvidence,
  processes: ProcessSnapshot | null = null,
) {
  const runtime = environment.runtime;
  if (!runtime) return { kind: "absent" };
  const exit = await json(path.join(runtime.runDir, "exit.json"));
  if (exit?.id === runtime.id && exit.environmentId === environment.id)
    return { kind: exit.stopConfirmed === true ? "stopped" : "unknown", exit };
  const started = await json(path.join(runtime.runDir, "started.json"));
  if (started?.id !== runtime.id || started.environmentId !== environment.id)
    return { kind: "unknown" };
  const actual = (processes || (await snapshotProcesses())).get(
      started.pid ?? -1,
    ),
    expected = started.identity;
  if (
    actual &&
    expected &&
    actual.start === expected.start &&
    actual.commandHash === expected.commandHash &&
    !actual.state?.includes("Z")
  ) {
    const commandStarted = await json(
      path.join(runtime.runDir, "command-started.json"),
    );
    return {
      kind:
        commandStarted?.id === runtime.id &&
        commandStarted.environmentId === environment.id
          ? "live"
          : "starting",
      started,
    };
  }
  const terminal = await json(path.join(runtime.runDir, "exit.json"));
  if (terminal?.id === runtime.id && terminal.environmentId === environment.id)
    return {
      kind: terminal.stopConfirmed === true ? "stopped" : "unknown",
      exit: terminal,
    };
  return { kind: "unknown" };
}
