import type {
  NativeUsageSnapshot,
  NativeUsageWindow,
} from "../agents/codex-usage.mjs";

/** Uses the runtime track's single sanitized account projection directly.
 * No account IDs, credentials, balances or reset-consumption operations. */
export type SubscriptionUsageSnapshot = NativeUsageSnapshot;
export type SubscriptionUsageWindow = NativeUsageWindow;
export interface SubscriptionUsageState {
  status: "available" | "disconnected" | "unsupported" | "error";
  snapshot: SubscriptionUsageSnapshot | null;
}
/** Desktop command subscription.usage {}. One host listener publishes complete
 * sanitized state; sparse native notifications are merged by the native adapter. */
export interface SubscriptionUsageClient {
  read(): Promise<SubscriptionUsageState>;
  subscribe?(listener: (state: SubscriptionUsageState) => void): () => void;
}
