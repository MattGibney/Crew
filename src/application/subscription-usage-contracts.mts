/** Owner-only, read-only projection of native account/rateLimits/read.
 * No account identifiers, credentials, credit identifiers or monetary balances.
 * Null means unavailable. The host merges sparse native notifications or refetches
 * before publishing a complete projection; the renderer does not merge raw data.
 */
export interface SubscriptionUsageWindow {
  /** Native window role or a bounded presentation label, never a guessed duration. */
  label: string;
  usedPercent: number | null;
  windowDurationMins: number | null;
  /** ISO-8601 instant converted from native Unix seconds. */
  resetsAt: string | null;
}

export interface SubscriptionUsageSnapshot {
  observedAt: string;
  buckets: {
    label: string;
    /** Preserve unavailable primary/secondary windows as null entries. */
    windows: (SubscriptionUsageWindow | null)[];
  }[];
  fullResets: {
    /** Authoritative returned count; never infer from capped detail rows. */
    availableCount: number | null;
    details: {
      status: "available" | "expired" | "used" | "unavailable";
      expiresAt: string | null;
    }[] | null;
  } | null;
}

export type SubscriptionUsageState = {
  status: "available" | "disconnected" | "unsupported" | "error";
  /** A failed refresh may retain the last successful snapshot. */
  snapshot: SubscriptionUsageSnapshot | null;
};

/** Desktop command: subscription.usage, args: {}.
 * A single application-owned native listener publishes sanitized state updates.
 * This reader never consumes a reset, starts an agent/turn or requests media.
 */
export interface SubscriptionUsageClient {
  read(): Promise<SubscriptionUsageState>;
  subscribe?(listener: (state: SubscriptionUsageState) => void): () => void;
}
