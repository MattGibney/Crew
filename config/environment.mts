import { isAbsolute } from 'node:path';
import { fail, object, text } from './validation.mjs';
import { parseEnvironmentShape } from './shape.mjs';
import type { WorkerEnvironmentConfig, SourceEvidence } from '../execution/contracts.mjs';
export function validateWorkerEnvironment(value: unknown, {mode = 'repository'}: {mode?:string} = {}): WorkerEnvironmentConfig {
  const input = value === undefined ? undefined : parseEnvironmentShape(value);
  const environment: WorkerEnvironmentConfig = {};
  if (input !== undefined) {
    object(
      input,
      ["executionPlan", "bootstrap", "start", "ready", "resume", "cleanup"],
      "project.worker.environment",
    );
    if ("executionPlan" in input) {
      if (
        mode !== "repository" ||
        Object.keys(input).length !== 1
      )
        fail(
          "Project execution plans require repository mode without custom hooks.",
        );
      const plan = input.executionPlan;
      if (!plan) fail("Project execution plan must be an object.");
      object(
        plan,
        [
          "schemaVersion",
          "sources",
          "setup",
          "start",
          "resume",
          "ready",
          "stop",
          "teardown",
          "env",
          "networkAccess",
          "permissionsSource",
        ],
        "project execution plan",
      );
      if (
        plan.schemaVersion !== 1 ||
        !Array.isArray(plan.sources) ||
        !plan.sources.length ||
        plan.sources.length > 64
      )
        fail(
          "Project execution plan requires version 1 and bounded source provenance.",
        );
      const validateSource = (source: SourceEvidence) => {
        object(source, ["path", "sha256"], "execution source");
        text(source.path, "execution source path", { max: 4096 });
        if (
          isAbsolute(source.path) ||
          source.path.split("/").includes("..") ||
          !/^[a-f0-9]{64}$/.test(source.sha256)
        )
          fail(
            "Execution sources must identify committed project files and SHA-256 hashes.",
          );
      };
      plan.sources.forEach(validateSource);
      for (const phase of [
        "setup",
        "start",
        "resume",
        "ready",
        "stop",
        "teardown",
      ] as const) {
        if (plan[phase] == null) continue;
        object(
          plan[phase],
          ["command", "source", "timeoutMs"],
          `execution ${phase}`,
        );
        text(plan[phase].command, `execution ${phase} command`);
        validateSource(plan[phase].source!);
        if (
          !plan.sources.some(
            (source) =>
              source.path === plan[phase]!.source!.path &&
              source.sha256 === plan[phase]!.source!.sha256,
          )
        )
          fail("Execution command source must be present in plan sources.");
        if (
          !Number.isInteger(plan[phase].timeoutMs) ||
          plan[phase].timeoutMs < 1000 ||
          plan[phase].timeoutMs > 600000
        )
          fail(
            "Execution timeouts must be between 1000 and 600000 milliseconds.",
          );
      }
      if (plan.permissionsSource !== undefined) {
        object(
          plan.permissionsSource,
          ["path", "sha256"],
          "project permissions source",
        );
        text(plan.permissionsSource.path, "project permissions path", {
          max: 4096,
        });
        if (
          !isAbsolute(plan.permissionsSource.path) ||
          !/^[a-f0-9]{64}$/.test(plan.permissionsSource.sha256)
        )
          fail(
            "Project permissions require an absolute local source path and SHA-256.",
          );
      }
      if (
        plan.networkAccess !== undefined &&
        typeof plan.networkAccess !== "boolean"
      )
        fail(
          "Project networkAccess must be a boolean sourced from project permissions.",
        );
      if (plan.env !== undefined) {
        object(plan.env, ["PATH"], "execution environment");
        if (plan.env.PATH !== undefined)
          text(plan.env.PATH, "execution PATH", { max: 16000 });
      }
      environment.executionPlan = structuredClone(plan);
    }
    for (const name of [
      "bootstrap",
      "start",
      "ready",
      "resume",
      "cleanup",
    ] as const) {
      const hook = input[name];
      if (!hook) continue;
      const label = `project.worker.environment.${name}`;
      object(hook, ["command", "args", "timeoutMs"], label);
      text(hook.command, `${label}.command`, { max: 4096 });
      if (
        !Array.isArray(hook.args) ||
        hook.args.length > 64 ||
        hook.args.some(
          (argument) =>
            typeof argument !== "string" ||
            argument.length > 8192 ||
            argument.includes("\0"),
        )
      )
        fail(
          `${label}.args must be an array of at most 64 strings, each at most 8192 characters and without NUL.`,
        );
      if (
        !Number.isInteger(hook.timeoutMs) ||
        hook.timeoutMs < 1000 ||
        hook.timeoutMs > 600000
      )
        fail(
          `${label}.timeoutMs must be an integer between 1000 and 600000 milliseconds.`,
        );
      environment[name] = {
        command: hook.command,
        args: [...hook.args],
        timeoutMs: hook.timeoutMs,
      };
    }
  }
  return environment;
}
