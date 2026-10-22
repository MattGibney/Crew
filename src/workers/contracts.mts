/** Shared execution boundary contracts. Persisted fields retain their historical names. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export interface SourceEvidence {
  path: string;
  sha256: string;
  kind?: string;
}
export interface ScriptAction {
  command: string;
  timeoutMs: number;
  source?: SourceEvidence;
  role?: string | null;
  name?: string;
}
export type ExecutionPhase =
  "setup" | "start" | "resume" | "ready" | "stop" | "teardown";
export interface ExecutionPlan {
  schemaVersion: number;
  sources: SourceEvidence[];
  setup?: ScriptAction | null;
  start?: ScriptAction | null;
  resume?: ScriptAction | null;
  ready?: ScriptAction | null;
  stop?: ScriptAction | null;
  teardown?: ScriptAction | null;
  permissionsSource?: SourceEvidence;
  networkAccess?: boolean | null;
  [key: string]: unknown;
}
export interface EnvironmentHook {
  configurationSource?: string;
  planHash?: string;
  source?: SourceEvidence | null;
  command: string;
  args: string[];
  timeoutMs: number;
}
export interface WorkerEnvironmentConfig {
  executionPlan?: ExecutionPlan | null;
  bootstrap?: EnvironmentHook;
  start?: EnvironmentHook;
  resume?: EnvironmentHook;
  ready?: EnvironmentHook;
  cleanup?: EnvironmentHook;
}
export interface Repository {
  id: string;
  path: string | null;
  baseRef: string | null;
  name?: string;
  components?: string[];
}
export interface Project {
  id: string;
  name?: string;
  mode: "fixture" | "repository";
  repositories: Repository[];
  readiness?: { ready: boolean; errors?: string[]; issues?: string[] };
  worker: {
    sandbox: "read-only" | "workspace-write";
    timeoutMs?: number;
    maxConcurrent?: number;
    environment?: WorkerEnvironmentConfig;
    [key: string]: unknown;
  };
  context?: string;
  linear?: {
    teamId?: string | null;
    projectId?: string | null;
    teamKey?: string | null;
  };
  prompts?: { manager: string; worker: string };
}
export interface PromptSnapshot {
  text: string;
  version: string;
}
export interface TaskReport {
  assignmentId?: string | null;
  reportId: string;
  runId: string;
  kind: string;
  message: string;
  evidence?: string[];
  at: string;
}
export interface TaskAttention {
  id: string;
  kind?: string;
  message?: string;
  at?: string;
  ackedAt?: string;
  resolution?: string;
}
export interface TaskHistory {
  instructionVersion?: string;
  ticket?: string;
  userDecision?: string | null;
  worktreeFingerprint?: string;
  assignmentId?: string | null;
  id: string;
  actor: string;
  kind: string;
  message: string;
  at: string | null;
  runId: string | null;
  evidence?: string[];
  questionId?: string;
  status?: string | null;
  exitCode?: number | null;
}
export interface LifecycleRequest {
  id: string;
  action: string;
  status: string;
  at: string;
  expectedRunId?: string | null;
  cooperative?: boolean;
  handledAt?: string;
  error?: string;
  reviewHash?: string;
  decision?: string;
}
export interface ModelRequest {
  id: string;
  expectedRunId: string;
  model: string;
  userDecision: string;
  at: string;
}
export interface ModelSelection extends ModelRequest {
  status: string;
  message: string;
  runtime?: unknown;
}
export interface TaskRecord {
  assignments?: WorkerAssignment[];
  currentAssignmentId?: string;
  completedAt?: string | null;
  archivedAt?: string;
  removedAt?: string;
  archivedQuestions?: NonNullable<TaskRecord["question"]>[];
  archiveRestoration?: ArchiveRestoration;
  archiveRestorations?: ArchiveRestoration[];
  workflowState?: WorkflowEvent;
  workflowHistory?: WorkflowEvent[];
  followupWait?: string;
  retainedDirection?: boolean;
  retainedResourceRuns?: { runId: string; runDir?: string; at?: string }[];
  retainedWorktreeEvidence?: {
    runId?: string;
    assignmentId?: string;
    fingerprint?: string;
    at?: string;
  };
  id: string;
  ticket: string;
  brief: string;
  projectId: string | null;
  repositoryId: string | null;
  status: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  reports: TaskReport[];
  attention: TaskAttention[];
  lifecycleRequests: LifecycleRequest[];
  history: TaskHistory[];
  historyVersion?: number;
  answer: { questionId?: string; text: string; at?: string } | null;
  question?: { id: string; message?: string; runId: string } | null;
  workerPromptSnapshot?: PromptSnapshot;
  runId?: string | null;
  threadId?: string | null;
  runDir?: string | null;
  worktree?: string | null;
  worktreeName?: string;
  worktreeRoot?: string;
  repositoryPath?: string;
  baseCommit?: string;
  fixtureRepo?: string | null;
  fixtureCommit?: string | null;
  workerSandbox?: string;
  harnessStarted?: boolean | "pending";
  runnerPid?: number | null;
  failure?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  launchAt?: string;
  spawnIntentAt?: string | null;
  previousRunId?: string | null;
  capacityWait?: string;
  progress?: string | null;
  handledReports?: string[];
  candidateReportId?: string | null;
  activeMs?: number;
  accountedRuns?: string[];
  nativeTurnStatus?: string;
  disposedAt?: string;
  result?: WorkerResult | null;
  environmentStopFailure?: string;
  modelRequests?: ModelRequest[];
  modelSelection?: ModelSelection;
  workNotes?: {
    updateId: string;
    updatedAt: string;
    actor: string;
    runId: string | null;
  };
  ticketUrl?: string;
  pullRequestUrl?: string;
  environment?: EnvironmentEvidence | null;
  execution?: TaskExecution | null;
  preparationPause?: unknown;
  retirement?: unknown;
}
export interface HookEvidence extends Partial<EnvironmentHook> {
  configurationHash?: string;
  id: string;
  phase: string;
  runDir?: string;
  status: string;
  startedAt?: string;
  supervisorPid?: number | null;
  exitCode?: number | null;
  timedOut?: boolean;
  canceled?: boolean;
  endedAt?: string;
  diagnostics?: unknown;
  error?: string;
}
export interface RuntimeEvidence {
  planHash?: string;
  action?: ScriptAction | null;
  configurationSource?: string;
  id: string;
  runDir: string;
  status: string;
  createdAt: string;
}
export interface EnvironmentEvidence {
  bootstrapAttempted?: boolean;
  setupRetryHistory?: SetupRetry[];
  originalPlan?: ExecutionPlan;
  configuredPlanHash?: string;
  planHistory?: PlanHistory[];
  runtimeHistory?: RuntimeEvidence[];
  id: string;
  taskId: string;
  worktree: string;
  hooks: HookEvidence[];
  kind?: string;
  preset?: unknown;
  status?: string;
  pending?: boolean;
  createdAt?: string;
  updatedAt?: string;
  toolchain?: PersistedToolchain;
  plan?: ExecutionPlan;
  planHash?: string;
  repositoryPath?: string;
  baseCommit?: string;
  runtime?: RuntimeEvidence;
  prepared?: boolean;
  setupAttempted?: boolean;
  servicesStarted?: boolean;
  detail?: string;
  readinessKind?: string;
  readyAt?: string;
  recoveryHistory?: RecoveryHistory[];
}
export interface ProjectEnvironmentEvidence extends EnvironmentEvidence {
  kind: "project-execution";
  plan: ExecutionPlan;
  repositoryPath: string;
  baseCommit: string;
}
export interface RecoveryHistory {
  actionId: string;
  runId: string | null;
  reviewHash?: string;
  decision?: string;
  at: string;
  previousPlan: ExecutionPlan;
  previousPlanHash: string;
  currentPlanHash: string | null;
  differences: PlanDifference[];
}
export interface PlanDifference {
  field: string;
  retained: unknown;
  current: unknown;
}
export interface TaskExecution {
  runId?: string | null;
  live: boolean;
  endedAt?: string | null;
  observedAt?: string;
  totalMs?: number;
  stopConfirmed?: boolean | null;
  supervisorPid?: number | null;
  startedAt?: string;
}

export interface ToolRequirements {
  node: string[];
  npm: string[];
  sources: { tool: "node" | "npm"; requirement: string; path: string }[];
  nodeProject: boolean;
}
export interface PersistedToolchain {
  PATH: string;
  nodeVersion: string | null;
  npmVersion: string | null;
  nodePath?: string;
  npmPath?: string;
  cacheRoot: string;
  requirements: Partial<Omit<ToolRequirements, "node" | "npm">> & {
    node?: string[] | string | { requirement: string };
    npm?: string[] | string | { requirement: string };
  };
}

export interface AssignmentAdoption {
  id: string;
  fingerprint: string;
  at: string;
  expectedRunId: string | null;
  userDecision: string;
}
export interface WorkerAssignment {
  stopReason?: string;
  id: string;
  ticket: string;
  brief: string;
  status: string;
  createdAt: string;
  runIds: string[];
  userDecision?: string | null;
  expectedRunId?: string | null;
  expectedAssignmentId?: string | null;
  reviewedWorktreeFingerprint?: string;
  requestTicket?: string | null;
  requestMetadata?: Record<string, unknown>;
  enqueuedRunId?: string | null;
  enqueuedAssignmentId?: string;
  endedAt?: string | null;
  result?: WorkerResult | null;
  promptSnapshot?: PromptSnapshot;
  archivedQuestions?: TaskRecord["question"][];
  adoptions?: AssignmentAdoption[];
}
export interface WorkflowEvent {
  progressPercent?: number | null;
  reportedProgressPercent?: number | null;
  value: string;
  requestId: string;
  actor: string;
  runId: string | null;
  assignmentId: string;
  at: string;
}
export interface ArchiveRestoration {
  rearchivedAt?: string;
  operationId: string;
  at: string;
  requiresRecovery: boolean;
  reason: string;
  archiveRevision: number;
  previousStatus: string;
  previousFailure: string | null;
}
export interface SetupRetry {
  planHash?: string;
  requestId: string;
  decision?: string;
  at?: string;
  configurationHash?: string;
}
export interface PlanHistory {
  at: string;
  plan: ExecutionPlan;
  planHash: string;
  nextPlanHash: string;
  configuredPlanHash: string;
  previousConfiguredPlanHash: string;
  sourceBindings: {
    phase: ExecutionPhase;
    configured: SourceEvidence | null;
    effective: SourceEvidence | null;
  }[];
  phases: ExecutionPhase[];
  reason: string;
}

export interface WorkerResult {
  message?: string;
  evidence?: string[];
  finalMessage?: string;
  verification?: unknown;
  [key: string]: unknown;
}

export interface ResultCandidate {
  runId?: string | null;
  kind: string;
  message: string;
  evidence?: string[];
}
