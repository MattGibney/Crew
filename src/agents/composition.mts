import type { RuntimeBinding } from "./contracts.mjs";
import { codexClientMessageId } from "./codex-runtime.mjs";
import type { CodexSenderLookup } from "./codex-history.mjs";
import type { FoundationStore } from "./store.mjs";

/** History can contain attempts from previous logical sessions on the same native
 * thread. Match exact receipt/attempt identities, never the current session alone. */
export function createFoundationSenderLookup(
  store: FoundationStore,
): CodexSenderLookup {
  return (binding: RuntimeBinding, clientId: string) => {
    const state = store.snapshot();
    if (binding.projectId !== state.projectId) return null;
    for (const receipt of state.receipts) {
      if (
        receipt.recipientAgentId !== binding.agentId ||
        receipt.threadId !== binding.threadId
      )
        continue;
      if (
        codexClientMessageId(
          { ...binding, sessionId: receipt.sessionId },
          receipt.attemptId,
        ) === clientId
      )
        return receipt.sender;
    }
    for (const message of state.messages) {
      if (message.recipientAgentId !== binding.agentId) continue;
      if (
        message.delivery.attempts.some(
          (attempt) =>
            attempt.threadId === binding.threadId &&
            codexClientMessageId(
              { ...binding, sessionId: attempt.sessionId },
              attempt.id,
            ) === clientId,
        )
      )
        return message.sender;
    }
    return null;
  };
}
