/** Data visible to the renderer. Native protocol payloads remain opaque unless rendered. */
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json | undefined };
export type JsonObject = { [key: string]: Json | undefined };
export type RequestId = string | number;
export interface MessageRecord {
  id?: string;
  kind?: undefined;
  origin?: string;
  role: string;
  text?: string;
  phase?: string;
  status?: string;
  source?: string;
  turnId?: string;
  position?: number;
}
export interface WorkItem {
  id?: string;
  name?: string;
  status?: string;
  exitCode?: number | null;
  changes?: Json;
}
export interface ApprovalQuestion {
  id: string;
  question: string;
  isOther?: boolean;
  isSecret?: boolean;
  options?: { label: string; description?: string }[];
}
export type Decision =
  | string
  | {
      acceptWithExecpolicyAmendment?: Json;
      applyNetworkPolicyAmendment?: Json;
    };
export interface ApprovalParams {
  mode?: string;
  _meta?: { codex_approval_kind?: string; tool_params?: Json };
  requestedSchema?: { properties?: JsonObject };
  url?: string;
  itemId?: string;
  command?: string;
  cwd?: string;
  additionalPermissions?: Json;
  networkApprovalContext?: Json;
  permissions?: Json;
  proposedExecpolicyAmendment?: Json;
  proposedNetworkPolicyAmendments?: Json[];
  availableDecisions?: Decision[];
  questions?: ApprovalQuestion[];
  reason?: string;
  message?: string;
  title?: string;
  description?: string;
  challenge?: Json;
}
export interface Approval {
  id: RequestId;
  method: string;
  params?: ApprovalParams;
}
export interface WorkerApproval extends Approval {
  taskId: string;
  runId: string;
  approvalId: string;
  threadId: string;
  turnId?: string | null;
  requestId: RequestId;
}
export interface ManagerLifecycle {
  state: string;
  error?: string | null;
  activeVersion?: string | null;
  retainedVersion?: string | null;
}
export interface WorkState {
  approvals: Approval[];
  connectors: Json[];
  items: WorkItem[];
  messages: MessageRecord[];
  status: string;
  activeTurnId?: string | null;
  managerLifecycle?: ManagerLifecycle;
  managerScratchpad?: ManagerScratchpadState | null;
  managerScratchpadError?: string | null;
}
export interface Attention {
  id: string;
  kind: string;
  message: string;
  ackedAt?: string | null;
}
export interface WorkerTask {
  threadId?: string | null;
  revision?: number;
  archivedAt?: string;
  disposedAt?: string;
  removedAt?: string;
  archiveRestoration?: { requiresRecovery?: boolean };
  currentAssignmentId?: string;
  assignments?: WorkerAssignment[];
  followupWait?: string;
  workflowState?: { value?: string };
  workflowHistory?: {
    requestId?: string;
    value: string;
    actor?: string;
    at?: string;
  }[];
  modelSelection?: {
    model?: string;
    status?: string;
    message?: string;
    runtime?: { runId?: string; status?: string; selectedModel?: string };
  };
  id: string;
  runId?: string | null;
  status: string;
  ticket?: string;
  title?: string;
  brief?: string;
  projectId?: string;
  repositoryId?: string;
  worktree?: string | null;
  updatedAt?: string;
  createdAt?: string;
  attention?: Attention[];
  lifecycleRequests?: { status: string }[];
  execution?: {
    runId?: string;
    live?: boolean | null;
    observedAt?: string;
    startedAt?: string;
    endedAt?: string;
  };
  retirement?: { reason?: string };
  capacityWait?: string;
  failure?: string;
  result?: { message?: string };
  progress?: string;
  question?: { runId?: string; id?: string };
  answer?: { questionId?: string };
  workerPromptSnapshot?: { text?: string; version?: string };
  pendingApprovalCount?: number;
}
export interface OrchestrationState {
  tasks: WorkerTask[];
  loading?: boolean;
  error?: string | null;
}
export interface VoiceCatalog {
  voices: { id: string; name: string }[];
  defaultVoice: string;
}
export interface ManagerProfile {
  name?: string;
  picture?: string | null;
  personality?: string;
  voice: string | null;
  version: string;
  configured?: boolean;
}
export interface PromptSnapshot {
  text: string;
  version: string;
}
export interface ManagerSchedule {
  id: string;
  name: string;
  instruction: string;
  enabled: boolean;
  builtin?: boolean;
  timing:
    | { kind: "interval"; minutes: number }
    | { kind: "daily"; time: string; timeZone: string };
  run?: { nextAt: number; lastAt?: number; status?: string; error?: string };
}
export interface ManagerSchedules {
  revision: string;
  schedules: ManagerSchedule[];
}
export interface SettingsState {
  managerSchedules?: ManagerSchedules;
  projectId?: string;
  projectName?: string;
  managerProfile: ManagerProfile;
  managerLifecycle: ManagerLifecycle;
  manager: {
    defaultText: string;
    savedBehaviorVersion?: string;
    saved: PromptSnapshot;
    activeVersion?: string | null;
    retainedVersion?: string | null;
    pendingRestart?: boolean;
  };
  worker: { defaultText: string; saved: PromptSnapshot };
  workerEnvironment?: WorkerEnvironmentSettings;
}
export interface ProjectInfo {
  id?: string;
  name: string;
  mode: string;
  readiness: { ready: boolean; issues: string[] };
}
export interface UpdatePlan {
  phase: string;
  projects?: { id: string; name: string; phase?: string }[];
  targets?: {
    projectId?: string;
    taskId: string;
    projectName?: string;
    progress?: string;
  }[];
  reasons?: string[];
  manager?: { interrupted?: boolean };
}
export interface UpdateStatus {
  phase?: string;
  supported?: boolean;
  currentVersion?: string;
  availableVersion?: string | null;
  downloadPercent?: number | null;
  error?: string | null;
  installBlocked?: boolean;
  reasons?: string[];
  notices?: string[];
  plan?: UpdatePlan | null;
  workspacePlan?: UpdatePlan | null;
}
export interface WorkerExchangeRecord {
  assignmentId?: string;
  id?: string;
  type?: string;
  role?: string;
  text?: string;
  actor?: string;
  label?: string;
  timestamp?: string;
  createdAt?: string;
  runId?: string | null;
  status?: string;
  method?: string;
  name?: string;
  command?: string;
  evidence?: string[];
  at?: string | null;
  details?: Json;
  source?: string;
  message?: string;
  title?: string;
  kind?: string;
  phase?: string;
  exitCode?: number | null;
}
export interface WorkerDetailState {
  revision?: number;
  conversation?: WorkerExchangeRecord[];
  historyNotice?: string | null;
  notes?: {
    exists?: boolean;
    markdown?: string | null;
    path?: string;
    updatedAt?: string | null;
  };
  links?: { kind?: string; url?: string; path?: string; label?: string }[];
}
export interface WorkRequest {
  text: string;
  requestId: string;
}
export type WorkerAction = "pause" | "stop" | "resume" | "dispose";
export type ManagerAction = "start" | "stop" | "restart";
export interface PrepareResult {
  state?: WorkState;
  plan?: string;
}
export interface ApiResults {
  voices: VoiceCatalog;
  settings: SettingsState;
  "settings/manager-profile": SettingsState;
  "settings/prompts": SettingsState;
  "settings/worker-environment": SettingsState;
  "settings/manager-schedules": SettingsState;
  "archived-worker-action": JsonObject;
  config: { nativeAttentionSound?: boolean; project: ProjectInfo };
  state: WorkState;
  prepare: PrepareResult;
  orchestration: OrchestrationState;
  updates: UpdateStatus;
  "manager/lifecycle": PrepareResult & { managerLifecycle?: ManagerLifecycle };
  connect: { sessionToken: string; sdp: string };
  disconnect: JsonObject;
  "voice-status": JsonObject;
  "voice-ready": JsonObject;
  work: JsonObject;
  "stop-work": JsonObject;
  approval: JsonObject;
  "worker-approval": JsonObject;
  "discuss-attention": JsonObject;
}
export type ApiPath = keyof ApiResults | `workers/${string}`;
export type ApiResult<P extends ApiPath> = P extends keyof ApiResults
  ? ApiResults[P]
  : WorkerDetailState;
export type Manager = ReturnType<
  typeof import("../manager/useCrewManager.js").useCrewManager
>;
export type ManagerProps = { manager: Manager };
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface WorkerAssignment {
  id: string;
  ticket?: string;
  brief?: string;
  status?: string;
  result?: { message?: string };
  runIds?: string[];
}
export interface ManagerScratchpadState {
  updatedAt?: string | null;
  commitments?: {
    id: string;
    title: string;
    status?: string;
    outcome?: string;
    nextAction?: string;
    references?: { taskId?: string; runId?: string; ticketUrl?: string };
  }[];
  notes?: string[];
  decisions?: string[];
  questions?: string[];
}
export type EnvironmentPhase =
  | "setup"
  | "bootstrap"
  | "start"
  | "resume"
  | "ready"
  | "stop"
  | "teardown"
  | "cleanup";
export interface EnvironmentSource {
  path: string;
  sha256: string;
}
export interface EnvironmentHook {
  command: string;
  timeoutMs: number;
  args?: string[];
  source?: EnvironmentSource;
}
export type EnvironmentHooks = Partial<
  Record<EnvironmentPhase, EnvironmentHook>
>;
export interface WorkerEnvironmentPlan extends EnvironmentHooks {
  sources: EnvironmentSource[];
  env?: { PATH?: string };
  networkAccess?: boolean;
  permissionsSource?: EnvironmentSource;
}
export interface WorkerEnvironmentConfig extends EnvironmentHooks {
  executionPlan?: WorkerEnvironmentPlan;
}
export interface WorkerEnvironmentSettings {
  available?: boolean;
  detail?: string;
  configPath?: string | null;
  revision: string | null;
  environment: WorkerEnvironmentConfig;
}
