import type { RuntimeBinding } from "../../../../src/agents/contracts.mjs";

export interface PrimaryVoiceCatalog {
  voices: { id: string; name: string }[];
  defaultVoice: string;
  /** Saved owner choice; null uses the native default. */
  selectedVoice: string | null;
}
export interface PrimaryVoiceCall {
  binding: RuntimeBinding;
  /** Allocated before negotiation, so cancellation can name a pending call. */
  callId: string;
}
export type PrimaryVoiceEvent = PrimaryVoiceCall &
  (
    | { kind: "closed" | "error"; message?: string }
    | {
        kind: "transcript";
        itemId: string;
        role: "user" | "assistant";
        text: string;
        done: boolean;
        delta: boolean;
        observedAt?: string;
      }
  );

/** Owner-authenticated transport, bound again by the server to the primary agent.
 * No method starts an agent, creates a thread, sends a user message or handoff.
 * stop must cancel the exact call even while its start awaits native negotiation.
 */
export interface PrimaryVoiceClient {
  listVoices(binding: RuntimeBinding): Promise<PrimaryVoiceCatalog>;
  start(input: PrimaryVoiceCall & { sdp: string; voice: string }): Promise<{
    sdp: string;
    threadId: string;
    sessionToken: string;
  }>;
  stop(input: PrimaryVoiceCall): Promise<void>;
  ready(input: PrimaryVoiceCall & { sessionToken: string }): Promise<void>;
  subscribe(listener: (event: PrimaryVoiceEvent) => void): () => void;
  /** Saved owner changes, excluding native token/history events. */
  subscribeCatalog?(listener: () => void): () => void;
  /** Best-effort unload notification. Native window ownership is the final guard. */
  abandon?(input: PrimaryVoiceCall): void;
}

export function sameVoiceBinding(a: RuntimeBinding, b: RuntimeBinding) {
  return (
    a.projectId === b.projectId &&
    a.agentId === b.agentId &&
    a.sessionId === b.sessionId &&
    a.threadId === b.threadId
  );
}
