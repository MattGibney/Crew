import type {
  Project,
  TaskRecord,
  LifecycleRequest,
  ExecutionPlan,
  EnvironmentEvidence,
} from "../workers/contracts.mjs";
import type { ProcessSnapshot } from "../processes/ownership.mjs";
export interface EnvironmentContext {
  plan?: ExecutionPlan | null;
  setupRetry?: import("../workers/contracts.mjs").SetupRetry | null;
  worktree?: string;
  repositoryPath?: string;
  baseCommit?: string;
  stateDir: string;
  taskId: string;
  onEvidence?: (environment: EnvironmentEvidence) => Promise<unknown>;
  processes?: ProcessSnapshot;
  cooperative?: boolean;
  signal?: AbortSignal;
  pauseBoundary?: (() => Promise<unknown>) | null;
}
export interface PrepareContext extends EnvironmentContext {
  worktree: string;
  repositoryPath: string;
  baseCommit: string;
  plan: ExecutionPlan;
  resume?: boolean;
  toolchainCacheRoot?: string;
  env?: NodeJS.ProcessEnv;
}
export interface RecoveryContext {
  stateDir: string;
  task: TaskRecord;
  project: Project | null;
  mode: string;
  request?: LifecycleRequest;
}
