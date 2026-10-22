import type {
  ExecutionPlan,
  ScriptAction,
} from "../../../src/workers/contracts.mjs";
export type { ExecutionPlan };
export type ExecutionCommand = ScriptAction;
export interface Repository {
  id: string;
  name: string;
  path: string;
  baseRef: string | null;
  components?: string[];
}
export interface ProjectConfig {
  runtime: {
    codexBinary: string | null;
    port: string | number;
    dataDir: string;
  };
  project: {
    id: string;
    name: string;
    context: string;
    mode: string;
    worker: {
      maxConcurrent: number | string;
      environment: { executionPlan?: ExecutionPlan; [key: string]: unknown };
    };
    repositories: Repository[];
    prompts: { manager: string; worker: string };
    tracking?: import("../../../src/shared/tracking.mjs").TrackingPreferences;
    linear: {
      teamId: string | null;
      teamKey: string | null;
      projectId: string | null;
    };
  };
}
export interface CheckStatus {
  status: string;
  detail?: string;
  name?: string;
}
export interface ToolsStatus extends CheckStatus {
  linear?: CheckStatus;
  github?: CheckStatus;
  servers?: { name: string; tools: string[]; status: string; auth: string }[];
}
export interface RepositoryOption extends Repository {
  status?: string;
  detail?: string;
  branches: { ref?: string; value?: string; kind?: string; label: string }[];
}
export interface SetupSnapshot {
  config?: ProjectConfig;
  revision?: string;
  notice?: string;
  error?: string;
  missingConfig?: boolean;
  migration?: {
    issue: string;
    newConfigPath: string;
    legacyConfigPaths?: string[];
  };
  checks?: {
    codex?: CheckStatus;
    git?: CheckStatus;
    protocol?: CheckStatus;
    auth?: CheckStatus;
    voices?: CheckStatus;
    project?: CheckStatus;
    tools?: ToolsStatus;
    paths?: CheckStatus[];
    [key: `toolchain_${string}`]: CheckStatus;
  };
  microphone?: string;
  controllerRunning?: boolean;
  repositoryOptions?: RepositoryOption[];
  workerEnvironmentOptions?: {
    status: string;
    detail?: string;
    plan: ExecutionPlan;
    actions?: ExecutionCommand[];
  }[];
  githubOptions?: { status: string; detail: string; repositories: { fullName: string; url: string }[]; truncated: boolean };
  linearOptions?: {
    detail?: string;
    teams?: { id: string; name: string; key: string }[];
    projects?: { id: string; name: string; teamIds?: string[] }[];
  };
  discoveryRoot?: string;
  discoverySummary?: {
    sources?: string[];
    truncated?: boolean;
    findings?: { statement: string; sources?: string[] }[];
  };
}
export interface SetupBridge {
  snapshot(): Promise<SetupSnapshot>;
  save(input: {
    config: ProjectConfig;
    revision?: string;
  }): Promise<SetupSnapshot>;
  chooseRepository(): Promise<string | null>;
  repositoryOptions(path: string): Promise<RepositoryOption>;
  chooseCodex(): Promise<string | null>;
  cancelDiscovery(): Promise<{ notice: string }>;
  settings(name: string): Promise<void>;
  storageUse(index: number): Promise<void>;
  storageRetry(): Promise<void>;
  storageFolder(): Promise<void>;
  launch(): Promise<void>;
  initialize(): Promise<SetupSnapshot>;
  openConfig(): Promise<void>;
  openPrompts(): Promise<void>;
  help(): Promise<void>;
  chooseDiscovery(): Promise<SetupSnapshot>;
  discover(): Promise<SetupSnapshot>;
  runtime(): Promise<SetupSnapshot>;
  account(): Promise<SetupSnapshot>;
  login(): Promise<SetupSnapshot>;
  microphone(): Promise<SetupSnapshot>;
  paths(): Promise<SetupSnapshot>;
  githubOptions(repository?: string): Promise<SetupSnapshot>;
  linearOptions(): Promise<SetupSnapshot>;
}
export type Setup = ReturnType<typeof import("../setup/useSetup.js").useSetup>;
export type SetupProps = { setup: Setup };
export type SetupCheck =
  "runtime" | "account" | "login" | "microphone" | "paths" | "linearOptions" | "githubOptions";
export interface WorkspaceSnapshot {
  selectedId?: string;
  workerLimit?: number;
  projects: {
    id: string;
    name: string;
    pending?: number;
    error?: string;
    ready?: boolean;
    active?: boolean;
  }[];
}
export interface WorkspaceBridge {
  snapshot(): Promise<WorkspaceSnapshot>;
  subscribe(callback: (value: WorkspaceSnapshot) => void): () => void;
  rename(input: { id: string; name: string }): Promise<unknown>;
  setWorkerLimit(value: number): Promise<unknown>;
  select(id: string): Promise<unknown>;
  add(): Promise<unknown>;
}
