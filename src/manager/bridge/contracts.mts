import type { ChildProcessByStdio } from "node:child_process";
import type { Writable, Readable } from "node:stream";
import type { Project } from "../../workers/contracts.mjs";

import type { ApprovalParams } from "../../workers/approvals.mjs";
import type { NativeId, RpcResults } from "./protocol.mjs";
export type BridgeChild = ChildProcessByStdio<Writable, Readable, null>;
export interface BridgeOptions {
  cwd: string;
  statePath: string;
  executable: string;
  orchestrationDir?: string;
  project?: Project;
  managerPrompt?: string;
  getManagerScratchpad?: () => Promise<unknown>;
  runtimeProjectPath?: string;
  onEvent?: (event: { type: string; [key: string]: unknown }) => void;
}
export interface ManagerApproval {
  id: NativeId;
  attentionId: string;
  method: string;
  params: ApprovalParams;
}
export interface ThreadBootstrap {
  expectedThreadId: string | null;
  observedThreadId: string | null;
  approvals: Map<string, ManagerApproval>;
}
export interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}
export interface VoiceCatalog {
  voices: { id: string; name: string }[];
  defaultVoice: string;
}
export interface LastVoice {
  voice: string;
  requestedAt: string;
  inputTranscriptEvents: number;
  outputTranscriptEvents: number;
  error: string | null;
  browser: Record<string, unknown> | null;
  startedAt?: string;
  closedAt?: string;
  closeReason?: string;
  voiceReadyAt?: string;
}
export interface BridgeWorkItem {
  id: string;
  turnId: string | null;
  type: string;
  name?: string;
  status?: string;
  exitCode?: number | null;
  output?: string;
  resultPresent?: boolean;
  error?: string | null;
  attention?: { id: string; message: string } | null;
  changes?: unknown;
}
export type PrepareResult = { auth: string; plan?: string };
export type WorkResult = RpcResults["turn/start"];
