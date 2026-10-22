import type { UnifiedApplication } from "../agents/service-composition.mjs";
import type { SubscriptionUsageState } from "./subscription-usage-contracts.mjs";

/** One owner view over the runtime's canonical sanitized native snapshot. */
export function createSubscriptionUsageOwnerAdapter(
  subscription: Pick<
    UnifiedApplication["subscription"],
    "usage" | "subscribeUsage"
  >,
) {
  let state: SubscriptionUsageState = {
    status: "disconnected",
    snapshot: null,
  };
  let observation = 0,
    disposed = false;
  let pendingRead: Promise<SubscriptionUsageState> | null = null;
  const listeners = new Set<(value: SubscriptionUsageState) => void>();
  const publish = (next: SubscriptionUsageState) => {
    if (disposed) return;
    observation++;
    state = structuredClone(next);
    for (const listener of listeners) listener(structuredClone(state));
  };
  const unsubscribe = subscription.subscribeUsage((snapshot) => {
    publish({ status: "available", snapshot });
  });
  return {
    async read(): Promise<SubscriptionUsageState> {
      if (disposed) return structuredClone(state);
      if (!pendingRead) {
        const previousObservation = observation;
        pendingRead = (async () => {
          try {
            const result = await subscription.usage();
            if (disposed || observation !== previousObservation)
              return structuredClone(state);
            if (result.state === "acknowledged")
              publish({ status: "available", snapshot: result.value });
            else
              publish({
                status:
                  result.error.code === "unsupported"
                    ? "unsupported"
                    : result.error.code === "disconnected"
                      ? "disconnected"
                      : "error",
                snapshot: state.snapshot,
              });
          } catch {
            if (observation === previousObservation)
              publish({ status: "error", snapshot: state.snapshot });
          }
          return structuredClone(state);
        })().finally(() => {
          pendingRead = null;
        });
      }
      // Every caller receives its own DTO even when sharing one native request.
      return structuredClone(await pendingRead);
    },
    subscribe(listener: (value: SubscriptionUsageState) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disposed = true;
      unsubscribe();
      listeners.clear();
    },
  };
}
