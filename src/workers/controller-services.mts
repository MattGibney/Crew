import type {
  Project,
  PromptSnapshot,
  TaskRecord,
  ResultCandidate,
} from "./contracts.mjs";
import type { RunnerRecord } from "./evidence.mjs";
import type { ProcessSnapshot } from "../processes/ownership.mjs";
import type { createGlobalCapacity } from "../orchestration/capacity.mjs";
export type NativeConnectionLive = (
  task: TaskRecord,
  options?: { ignoreLaunch?: boolean },
) => Promise<boolean>;
export type ActivateFollowup = (task: TaskRecord) => Promise<TaskRecord>;
export interface ControllerServices {
  capacityDir?: string;
  stateDir: string;
  sourceDir: string;
  executable: string;
  project: Project | null;
  workerPrompt: string;
  workerProfileSource: { projectId: string } | null;
  getWorkerPrompt: (() => Promise<PromptSnapshot>) | null;
  capacity: Awaited<ReturnType<typeof createGlobalCapacity>>;
  launches: Map<string, Promise<void>>;
  operations: Map<string, Promise<unknown>>;
  startupQueued: Map<string, string>;
  admissionHeld: (request: {
    taskId: string;
    resume: boolean;
  }) => Promise<boolean>;
  isStopped: () => boolean;
  fixture: () => Promise<{
    repo: string;
    base: string;
    commit: string;
    at: string;
  }>;
  fail: (id: string, message: string) => Promise<void>;
  verify: (
    task: TaskRecord,
    exit: RunnerRecord,
    report: ResultCandidate,
  ) => Promise<void>;
  ownedTask: (task: TaskRecord) => boolean;
  ownedRunnerAlive: (task: TaskRecord) => Promise<boolean>;
  getProcessSnapshot: () => ProcessSnapshot;
}
