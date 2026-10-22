import type { RuntimeResult } from "./contracts.mjs";
import { CodexRpcError, type CodexPeer } from "./codex-peer.mjs";
import {
  projectCodexUsageRead,
  type SubscriptionUsageSnapshot,
} from "./codex-usage.mjs";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read subscription usage through an already initialized, trusted native peer.
 * This neither signs in nor refreshes authentication, starts a model turn,
 * enables reserve fallback, or consumes a rate-limit reset. Account metadata
 * remains local to the type check and is never returned in values or errors.
 */
export async function readCodexSubscriptionUsage(
  peer: Pick<CodexPeer, "rpc">,
): Promise<RuntimeResult<SubscriptionUsageSnapshot>> {
  try {
    const response = await peer.rpc("account/read", { refreshToken: false });
    if (!object(response) || !("account" in response)) {
      throw new Error("Invalid native account response.");
    }
    if (response.account === null) {
      return {
        state: "failed",
        error: {
          code: "disconnected",
          message: "ChatGPT subscription sign-in is unavailable.",
        },
      };
    }
    if (!object(response.account)) {
      throw new Error("Invalid native account response.");
    }
    if (
      response.account.type === "apiKey" ||
      response.account.type === "amazonBedrock"
    ) {
      return {
        state: "failed",
        error: {
          code: "unsupported",
          message: "Subscription usage requires ChatGPT subscription sign-in.",
        },
      };
    }
    if (response.account.type !== "chatgpt") {
      throw new Error("Invalid native account response.");
    }
    const value = await peer.rpc("account/rateLimits/read", {
      excludeResetCreditDetails: false,
    });
    return { state: "acknowledged", value: projectCodexUsageRead(value) };
  } catch (error) {
    if (
      error instanceof CodexRpcError &&
      (error.code === -32601 || error.code === -32602)
    ) {
      return {
        state: "failed",
        error: {
          code: "unsupported",
          message:
            "This Codex build does not support subscription usage reads.",
        },
      };
    }
    if (error instanceof CodexRpcError && error.code === null) {
      return {
        state: "failed",
        error: {
          code: "disconnected",
          message: "The native subscription usage connection is unavailable.",
        },
      };
    }
    return {
      state: "failed",
      error: {
        code: "runtime_error",
        message: "Native subscription usage could not be verified.",
      },
    };
  }
}
