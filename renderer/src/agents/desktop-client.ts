import type { AgentsClient, AgentsClientEvent, AgentsSnapshot } from "./client";
import type { DesktopQuitSnapshot } from "../../../src/desktop/unified-quit.mjs";
import type { UnifiedUpdateSnapshot } from "../../../src/desktop/unified-updates.mjs";

export interface DesktopSnapshot {
  projects: {
    id: string;
    name: string;
    directory: string;
    error?: string | null;
  }[];
  selectedId: string | null;
  quit: DesktopQuitSnapshot;
  updates: UnifiedUpdateSnapshot | null;
}
export type DesktopUpdateAction =
  "status" | "check" | "download" | "prepare" | "cancel" | "install";
export interface DesktopBridge {
  integratedTitlebar: boolean;
  request(method: string, value?: unknown): Promise<unknown>;
  subscribe(listener: (event: unknown) => void): () => void;
}
declare global {
  interface Window {
    crewDesktop?: DesktopBridge;
  }
}

export function createDesktopClient(bridge: DesktopBridge, projectId: string) {
  const command = async <T>(command: string, args: unknown): Promise<T> =>
    (await bridge.request("ownerCommand", { projectId, command, args })) as T;
  const client: AgentsClient = {
    readSnapshot: async () =>
      (await bridge.request("ownerSnapshot", { projectId })) as AgentsSnapshot,
    subscribe(listener) {
      return bridge.subscribe((value) => {
        const event = value as {
          type?: string;
          projectId?: string;
          event?: AgentsClientEvent;
        };
        if (
          event?.type === "owner" &&
          event.projectId === projectId &&
          event.event
        )
          listener(event.event);
      });
    },
    readHistory: (agentId, cursor) =>
      command("readHistory", { agentId, cursor }),
    readVoiceArtifacts: (agentId, cursor) =>
      command("readVoiceArtifacts", { agentId, cursor }),
    createAgent: (input) => command("createAgent", { input }),
    saveProfile: (agentId, input) => command("saveProfile", { agentId, input }),
    lifecycle: (agentId, action) => command("lifecycle", { agentId, action }),
    sendMessage: (input) => command("sendMessage", { input }),
    reconcileMessage: (messageId) => command("reconcileMessage", { messageId }),
    retryMessage: (messageId) => command("retryMessage", { messageId }),
    respondToHelp: (helpId, content) =>
      command("respondToHelp", { helpId, content }),
    respondToNativeApproval: (agentId, approvalId, response) =>
      command("respondToNativeApproval", { agentId, approvalId, response }),
    createJob: (input) => command("createJob", { input }),
    assignJob: (jobId, agentId, instruction) =>
      command("assignJob", { jobId, agentId, instruction }),
    archiveAgent: (agentId) => command("archiveAgent", { agentId }),
    prepare: (reason) => command("prepare", { reason }),
    saveImage: (picture) => command("images.save", { picture }),
    readImage: (imageRef) => command("images.read", { imageRef }),
  };
  return { client, command };
}
