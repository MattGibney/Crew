import type { EventEmitter } from "node:events";
export interface UpdateActivity {
  safe: boolean;
  reasons?: string[];
  notices?: string[];
}
export interface UpdateReservation {
  reserved?: boolean;
  reasons?: string[];
}
export interface UpdateStatus {
  phase: string;
  currentVersion: string;
  availableVersion: string | null;
  downloadPercent: number | null;
  error: string | null;
  installBlocked: boolean;
  reasons: string[];
  notices: string[];
  supported: boolean;
  releaseUrl: string;
  workspacePlan?: PausePlan | null;
}
export interface PauseTarget {
  taskId: string;
  progress?: string;
  projectId?: string;
  projectName?: string;
}
export interface PausePlan {
  purpose?: "update" | "quit";
  preparation?: import("../preparation/coordinator.mjs").ObservedPreparation;
  id: string;
  kind: string;
  consent: boolean;
  targetVersion: string | null;
  phase: string;
  targets?: PauseTarget[];
  reasons?: string[];
  manager?: { interrupted: boolean };
  fromVersion?: string;
  createdAt?: string;
  updatedAt?: string;
  projects?: Array<{ id: string; name: string; phase: string; ready: boolean }>;
}
export interface PlanReply {
  plan?: PausePlan | null;
  marked?: boolean;
  reserved?: boolean;
  reasons?: string[];
  safe?: boolean;
  notices?: string[];
}
export interface NativeUpdater extends EventEmitter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  logger: unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(silent?: boolean, runAfter?: boolean): void;
}
export interface UpdateClient {
  getStatus(): UpdateStatus;
  request(
    action: string,
    options?: { beforeInstall?: () => Promise<void> },
  ): Promise<UpdateStatus>;
}
export interface UpdateProjectHost {
  api(route: string, input?: Record<string, unknown>): Promise<PlanReply>;
  updateToken(
    route: string,
    input?: Record<string, unknown>,
  ): Promise<PlanReply>;
}
export interface UpdateProject {
  id: string;
  configPath: string;
  name?: string;
  host: UpdateProjectHost;
}
export type AdmissionControl = (paused: boolean) => Promise<unknown>;
