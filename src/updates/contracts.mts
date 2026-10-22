export type ProcessVerdict =
  "unknown" | "absent" | "live" | "stopped" | "pending";
export interface HookVerdict {
  id: string | null;
  phase: string | null;
  state: ProcessVerdict;
}
export interface UpdateEvidence {
  worker: ProcessVerdict;
  runtime: ProcessVerdict;
  hooks: HookVerdict[];
}
export interface ManagerActivity {
  lifecycleState?: string;
  threadId?: string | null;
  status: string;
  voiceActive: boolean;
  voiceConnecting: boolean;
  workStarting: boolean;
  activeTurnId?: string | null;
  approvals: unknown[];
}
export interface TaskActivity {
  id: string;
  threadId?: string | null;
  title?: string;
  ticket?: string;
  status: string;
  runId?: string | null;
  runDir?: string | null;
  runnerPid?: number | null;
  worktree?: string | null;
  spawnIntentAt?: string | null;
  harnessStarted?: boolean | "pending";
  question?: { id: string } | null;
  answer?: { questionId?: string } | null;
  execution?: { live?: boolean; stopConfirmed?: boolean | null } | null;
  environment?: {
    id?: string;
    kind?: string;
    worktree?: string;
    status?: string;
    servicesStarted?: boolean;
    hooks?: { status: string }[];
    runtime?: { status: string } | null;
  } | null;
  retainedResourceRuns?: Array<{ runId: string }>;
  updateEvidence?: UpdateEvidence;
  lifecycleRequests?: {
    id: string;
    status: string;
    action: string;
    expectedRunId?: string | null;
    cooperative?: boolean;
    settleNaturally?: boolean;
  }[];
}
export interface ActivityView {
  tasks: TaskActivity[];
  error?: unknown;
}
export interface ActivityResult {
  safe: boolean;
  reasons: string[];
  notices?: string[];
}
export interface PauseTarget {
  taskId: string;
  originalRunId: string | null;
  originalStatus: string;
  resumeEligible: boolean;
  pauseActionId: string;
  resumeActionId: string;
  progress: string;
  pauseConfirmed: boolean;
}
export interface PausePlan {
  schema: 1;
  kind: "pause-update";
  consent: true;
  id: string;
  targetVersion: string;
  purpose?: "update" | "quit";
  preparation?: import("../preparation/coordinator.mjs").ObservedPreparation;
  fromVersion: string;
  phase: string;
  createdAt: string;
  updatedAt: string;
  targets: PauseTarget[];
  progress: { at: string; message: string; taskId?: string }[];
  reasons: string[];
  voiceClosed: boolean;
  manager: {
    originalActive: boolean;
    originalTurnId: string | null;
    interruptRequested: boolean;
    interrupted: boolean;
    interruptTurnId?: string | null;
  };
}
export interface PlanIdentity {
  planId?: string;
  targetVersion?: string;
}
export interface UpdateStatus {
  phase: string;
  currentVersion: string;
  availableVersion: string | null;
  downloadPercent: number | null;
  error: string | null;
  installBlocked: boolean;
  reasons: string[];
  supported: boolean;
  releaseUrl: string;
  notices?: string[];
  workspacePlan?: unknown;
}
