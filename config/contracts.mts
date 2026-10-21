import type {
  WorkerEnvironmentConfig,
  ExecutionPlan,
} from "../execution/contracts.mjs";
export interface RawExecutionPlan extends ExecutionPlan {
  permissionsSource?: NonNullable<ExecutionPlan["permissionsSource"]>;
  env?: { PATH?: string };
}
export interface RawEnvironment extends WorkerEnvironmentConfig {
  executionPlan?: RawExecutionPlan;
}
export interface RawRepository {
  id: string;
  name: string;
  path: string | null;
  baseRef: string | null;
  components: string[];
}
export interface RawProject {
  id: string;
  name: string;
  mode: "fixture" | "repository";
  context: string;
  repositories: RawRepository[];
  linear: {
    teamId: string | null;
    projectId: string | null;
    teamKey: string | null;
  };
  prompts: { manager: string; worker: string };
  worker: {
    sandbox: "read-only" | "workspace-write";
    timeoutMs: number;
    maxConcurrent?: number;
    environment?: RawEnvironment;
  };
}
export interface RawConfig {
  schemaVersion: number;
  runtime: { port?: unknown; codexBinary: string | null; dataDir: string };
  project: RawProject;
}
export interface LoadedProject extends Omit<RawProject, "worker"> {
  worker: {
    sandbox: "read-only" | "workspace-write";
    timeoutMs: number;
    maxConcurrent: number;
    environment: WorkerEnvironmentConfig;
  };
  readiness: { ready: boolean; issues: string[] };
}
export interface LoadedConfig {
  configPath: string | null;
  sourceConfigPath: string;
  port: number;
  executable: string | null;
  dataDir: string;
  project: LoadedProject;
  activeProject: LoadedProject;
  projectStateDir: string;
  managerStatePath: string;
  serverStatePath: string;
  managerPrompt: string;
  workerPrompt: string;
  promptPaths: Record<"manager" | "worker", string>;
  legacyState: boolean;
  runtime: {
    nodeVersion: string;
    gitVersion: string | undefined;
    codexVersion: string | null;
  };
}
