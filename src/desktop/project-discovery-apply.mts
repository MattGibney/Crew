import { access } from "node:fs/promises";
import { resolve, dirname, join, relative, sep, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { discoverProject } from "../projects/discovery.mjs";
import { parseConfig } from "../config/shape.mjs";
import {
  readSetupConfig,
  setupInputsKey,
  applyDiscoveryDraft,
  checkLocalRuntime,
  type SetupCheck,
} from "./setup-service.mjs";
import {
  discoverRepository,
  verifyReference,
  type LinearCatalog,
  type RepositoryOption,
} from "./project-options.mjs";
import { composeProjectSetup } from "./project-setup.mjs";
import {
  discoverWorkerEnvironment,
  assertWorkerEnvironmentSelection,
} from "./environment-options.mjs";
import { selectExecutionPlan } from "./execution-selection.mjs";
import type { SetupHostContext } from "./project-setup-host.mjs";
type Proposal = Awaited<ReturnType<typeof discoverProject>>;
interface DiscoverySummary {
  name: string;
  path: string;
  branch: string | null;
  sources: Proposal["evidence"]["sources"];
  truncated: boolean;
  findings: Proposal["findings"];
  questions: Proposal["confirmations"];
}
interface DiscoveryContext {
  context: SetupHostContext;
  discoveryRoot: string;
  signal: AbortSignal;
  checkRuntimeForSetup(): ReturnType<typeof checkLocalRuntime>;
  checkAccountForSetup(): Promise<Record<string, SetupCheck>>;
  assertSetupInputs(inputs: string): Promise<void>;
  onDiscovered(linear: LinearCatalog, repository: RepositoryOption): void;
  markSaving(): void;
  onApplied(
    applied: Awaited<ReturnType<typeof applyDiscoveryDraft>>,
    summary: DiscoverySummary,
  ): Promise<void>;
}
/** Analyze without effects, validate current identities, then apply one atomic project draft. */
export async function analyzeAndApplyProject({
  context,
  discoveryRoot,
  signal,
  checkRuntimeForSetup,
  checkAccountForSetup,
  assertSetupInputs,
  onDiscovered,
  markSaving,
  onApplied,
}: DiscoveryContext): Promise<void> {
  const {
    root,
    storage,
    host,
    env,
    api,
    poll,
    stopOwnedBackend,
    startup,
    safe,
  } = context;
  const { configPath, id } = storage;
  const before = await readSetupConfig(configPath),
    inputs = await setupInputsKey(configPath);
  const runtime = await checkRuntimeForSetup();
  if (!runtime.executable) throw new Error(runtime.checks.codex.detail);
  const account = await checkAccountForSetup();
  if (account.auth?.status !== "verified")
    throw new Error(
      "ChatGPT sign-in is required for optional project analysis.",
    );
  if (signal.aborted)
    throw new Error(
      "Project analysis canceled. Active configuration is unchanged.",
    );
  const [proposal, repository, linear] = await Promise.all([
    discoverProject({
      repositoryRoot: discoveryRoot,
      codexBinary: runtime.executable,
      env,
      signal: signal,
    }),
    discoverRepository({ path: discoveryRoot, env }),
    Promise.resolve({
      status: "not-configured",
      detail:
        "External tracking is optional. Choose integrations after selecting your project.",
      teams: [],
      projects: [],
      truncated: false,
    }),
  ]);
  await assertSetupInputs(inputs);
  if (signal.aborted)
    throw Error("Project setup canceled. Your saved settings are unchanged.");
  onDiscovered(linear, repository);
  const token = randomUUID(),
    promptDirectory = join("prompts", `discovery-${token}`);
  const currentRepository = before.config.project.repositories.find(
    (r) => r.path === repository.path,
  );
  if (currentRepository?.baseRef) {
    try {
      await verifyReference({
        path: repository.path,
        ref: currentRepository.baseRef,
        env,
      });
      repository.verifiedExistingRef = currentRepository.baseRef;
    } catch {}
  }
  const draft = composeProjectSetup({
    proposal: { config: parseConfig(JSON.stringify(proposal.config)) },
    current: before.config,
    repository,
    linear,
  });
  {
    const execution = await discoverWorkerEnvironment({
        path: repository.path,
        baseRef: draft.project.repositories[0]?.baseRef,
        env,
      }),
      saved = draft.project.worker?.environment?.executionPlan;
    if (saved && execution.plan) {
      const action = execution.actions.find(
        (item) => item.command === saved.start?.command,
      );
      draft.project.worker.environment = {
        executionPlan: selectExecutionPlan({
          discovered: execution.plan,
          saved,
          action,
        }),
      };
    } else if (
      !Object.keys(draft.project.worker?.environment || {}).length &&
      execution.plan &&
      (execution.plan.setup || execution.plan.start)
    )
      draft.project.worker.environment = {
        executionPlan: execution.plan,
      };
  }
  if (draft.project.worker?.environment?.executionPlan) {
    const options = await Promise.all(
      draft.project.repositories.map(async (repo) => ({
        ...(await discoverWorkerEnvironment({
          path: repo.path,
          baseRef: repo.baseRef,
          env,
        })),
        repositoryId: repo.id,
        path: repo.path,
        baseRef: repo.baseRef,
      })),
    );
    assertWorkerEnvironmentSelection(draft, options);
  }
  try {
    await access(
      join(
        resolve(dirname(configPath), before.config.runtime.dataDir),
        "orchestration/instance-project.json",
      ),
    );
    draft.project.id = before.config.project.id;
  } catch {}
  try {
    await access(
      join(
        resolve(dirname(configPath), before.config.runtime.dataDir),
        "manager-chat.json",
      ),
    );
    draft.project.id = before.config.project.id;
  } catch {}
  draft.project.prompts = {
    manager: join(promptDirectory, "manager.md"),
    worker: join(promptDirectory, "worker.md"),
  };
  const inside = relative(
    repository.path,
    resolve(dirname(configPath), promptDirectory),
  );
  if (
    !inside ||
    (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
  )
    throw Error(
      "Crew settings must be outside the project folder. Choose a separate configuration location.",
    );
  await host.validateCandidate(id, configPath, draft);
  const wasRunning = context.backendReady;
  if (context.backend && !context.backendReady)
    throw Error("The manager is still starting. Wait, then try again.");
  if (wasRunning) {
    await poll();
    const state = await api("state");
    if (
      context.counts.active !== 0 ||
      state.activeTurnId ||
      state.voiceActive ||
      state.voiceConnecting
    )
      throw Error(
        "Finish active work and disconnect voice before updating this project. Your saved settings are unchanged.",
      );
    await stopOwnedBackend();
  }
  try {
    if (signal.aborted)
      throw Error("Project setup canceled. Your saved settings are unchanged.");
    await assertSetupInputs(inputs);
    markSaving();
    const applied = await applyDiscoveryDraft({
      root,
      configPath,
      env,
      revision: before.revision,
      config: draft,
      managerDraft: proposal.managerDraft,
      workerDraft: proposal.workerDraft,
      promptDirectory,
    });
    await host.configured(
      id,
      before.config.project.name,
      applied.config.project.name,
    );
    await onApplied(applied, {
      name: draft.project.name,
      path: repository.path,
      branch: draft.project.repositories[0].baseRef,
      sources: proposal.evidence.sources,
      truncated: proposal.evidence.truncated,
      findings: proposal.findings,
      questions: proposal.confirmations,
    });
  } finally {
    if (wasRunning) await startup({ showWindow: false });
  }
}
