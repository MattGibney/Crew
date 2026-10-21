import type {
  ExecutionPhase,
  ExecutionPlan,
  ProjectEnvironmentEvidence,
} from "./contracts.mjs";
import type { EnvironmentContext } from "./project-context.mjs";
import { executionPlanHash, persist } from "./project-state.mjs";
import {
  assertPlan,
  verifySources,
  verifyPermissionsSource,
} from "./project-integrity.mjs";
const now = () => new Date().toISOString();
export async function applyLifecyclePlan(
  args: EnvironmentContext,
  environment: ProjectEnvironmentEvidence,
  phases: ExecutionPhase[],
) {
  const configured = args.plan;
  const current: ExecutionPlan | null = configured
    ? {
        ...configured,
        ...(Object.hasOwn(environment.plan, "env")
          ? { env: structuredClone(environment.plan.env) }
          : {}),
      }
    : null;
  if (current && !Object.hasOwn(environment.plan, "env")) delete current.env;
  if (current) {
    // Retained workers execute against their own verified baseline dependencies.
    // A newer project's source hash does not rewrite that worktree or its history.
    const pinned = new Map(
      (environment.plan.sources || []).map((source) => [source.path, source]),
    );
    current.sources = (current.sources || []).map((source) =>
      structuredClone(pinned.get(source.path) || source),
    );
    for (const phase of [
      "setup",
      "start",
      "resume",
      "ready",
      "stop",
      "teardown",
    ] as const)
      if (current[phase]?.source && pinned.has(current[phase].source.path))
        current[phase] = {
          ...current[phase],
          source: structuredClone(pinned.get(current[phase].source.path)),
        };
  }
  if (!current || !configured) return;
  assertPlan(current);
  const previous = environment.plan;
  const mutable = new Set([
    "setup",
    "start",
    "resume",
    "ready",
    "stop",
    "teardown",
    "sources",
  ]);
  const changed = Object.keys({ ...previous, ...current }).filter(
    (key) =>
      executionPlanHash(previous?.[key] ?? null) !==
      executionPlanHash(current[key] ?? null),
  );
  if (changed.some((key) => !mutable.has(key)))
    throw new Error(
      "Retained environment or permission configuration changed. Restore its original settings before retrying lifecycle actions.",
    );
  await verifySources(
    environment.worktree,
    environment.baseCommit,
    current,
    phases,
  );
  await verifyPermissionsSource(environment.repositoryPath, current);
  const configuredPlanHash = executionPlanHash(configured),
    previousConfiguredPlanHash =
      environment.configuredPlanHash || executionPlanHash(previous);
  environment.configuredPlanHash = configuredPlanHash;
  if (!changed.length && configuredPlanHash === previousConfiguredPlanHash)
    return;
  const sourceBindings = phases
    .filter((phase) => current[phase])
    .map((phase) => ({
      phase,
      configured: structuredClone(configured[phase]?.source || null),
      effective: structuredClone(current[phase]?.source || null),
    }));
  environment.originalPlan ||= structuredClone(previous);
  environment.planHistory = [
    ...(environment.planHistory || []),
    {
      at: now(),
      plan: structuredClone(previous),
      planHash: executionPlanHash(previous),
      nextPlanHash: executionPlanHash(current),
      configuredPlanHash,
      previousConfiguredPlanHash,
      sourceBindings,
      phases: [...phases],
      reason: "configured-lifecycle-action",
    },
  ];
  environment.plan = structuredClone(current);
  environment.planHash = executionPlanHash(current);
  await persist(args, environment);
}
