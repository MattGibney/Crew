import type { AgentsClient, AgentsClientEvent, AgentsSnapshot } from "./client";

/** Same-origin owner endpoint. It never reads native credentials or personal app state. */
export function createAgentsHttpClient(base = "/api/agents"): AgentsClient {
  async function request<T>(url: string, body?: unknown): Promise<T> {
    const response = await fetch(url, {
      credentials: "same-origin",
      ...(body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    const result: unknown = await response.json();
    if (!response.ok) {
      const error =
        result && typeof result === "object" && "error" in result
          ? result.error
          : null;
      const message =
        typeof error === "string"
          ? error
          : error && typeof error === "object" && "message" in error
            ? String(error.message)
            : `Request failed (${response.status}).`;
      throw new Error(message);
    }
    return result as T;
  }
  const command = async <T>(name: string, args: unknown) =>
    (await request<{ result: T }>(`${base}/command`, { command: name, args }))
      .result;
  return {
    readSnapshot: () => request<AgentsSnapshot>(base),
    subscribe(listener) {
      const stream = new EventSource(`${base}/events`);
      const receive = (event: MessageEvent<string>) => {
        try {
          const value = JSON.parse(event.data) as AgentsClientEvent;
          if (value.kind === "changed" || value.kind === "runtime")
            listener(value);
        } catch {
          /* Broken event frames are not state or model content. Reconnect refreshes. */
        }
      };
      stream.addEventListener("message", receive);
      stream.addEventListener("open", () => listener({ kind: "changed" }));
      return () => stream.close();
    },
    readHistory: (agentId, cursor) =>
      command("readHistory", { agentId, cursor }),
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
    // Artifact serving is explicitly owned by the host. Unconfigured references stay unavailable.
  };
}
