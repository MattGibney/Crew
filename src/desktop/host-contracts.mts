import type { RawConfig } from "../config/contracts.mjs";
import type { CrewStorage } from "./storage.mjs";
import type { UpdateClient, PlanReply } from "./update-contracts.mjs";
import type { TaskSummaryInput } from "./lifecycle.mjs";
export interface ProjectStorage extends CrewStorage {
  id: string;
}
export interface DesktopApiReply extends PlanReply, TaskSummaryInput {
  [key: string]: unknown;
  error?: string | null;
  requests?: unknown[];
  activeTurnId?: string | null;
  voiceActive?: boolean;
  voiceConnecting?: boolean;
}
export interface ProjectParent {
  capacityDirectory: string;
  gate: { assertSetupAllowed(): void };
  assertControllerStartAllowed?(): void;
  changed(): void;
  isSelected(id: string): boolean;
  validateAll(): Promise<unknown>;
  validateCandidate(
    id: string,
    configPath: string,
    config: RawConfig,
  ): Promise<unknown>;
  configured(id: string, previousName: string, name: string): Promise<unknown>;
  relaunch(args: string[]): Promise<void>;
  updater: UpdateClient;
}
