import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type {
  SubscriptionUsageClient,
  SubscriptionUsageSnapshot,
  SubscriptionUsageState,
  SubscriptionUsageWindow,
} from "../../../src/application/subscription-usage-contracts.mjs";

interface Props {
  client: SubscriptionUsageClient;
  visible: boolean;
}

const statuses = ["available", "disconnected", "unsupported", "error"];
const resetStatuses = ["available", "redeeming", "redeemed", "unknown"];
const percentFormat = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
});
const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const localTimezone = dateFormat.resolvedOptions().timeZone;
const clampPercent = (value: number) => Math.max(0, Math.min(100, value));
const percent = (value: number) => `${percentFormat.format(value)}%`;
const date = (value: string) => dateFormat.format(new Date(value));

function validUnixTime(value: unknown) {
  return (
    value === null ||
    (typeof value === "number" &&
      value >= 0 &&
      Number.isFinite(new Date(value * 1000).getTime()))
  );
}
function unixDate(value: number) {
  return new Date(value * 1000).toISOString();
}
function validDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value))
  );
}
function nullableNumber(value: unknown) {
  return (
    value === null || (typeof value === "number" && Number.isFinite(value))
  );
}
function label(value: unknown) {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}
function validWindow(value: unknown): value is SubscriptionUsageWindow {
  if (!value || typeof value !== "object") return false;
  const row = value as SubscriptionUsageWindow;
  return (
    nullableNumber(row.usedPercent) &&
    (row.usedPercent === null || row.usedPercent >= 0) &&
    nullableNumber(row.windowDurationMins) &&
    (row.windowDurationMins === null || row.windowDurationMins >= 0) &&
    validUnixTime(row.resetsAt)
  );
}

/** Validate the bounded display DTO, never a raw native response. */
export function validSubscriptionUsageState(
  value: unknown,
): value is SubscriptionUsageState {
  if (!value || typeof value !== "object") return false;
  const state = value as SubscriptionUsageState;
  if (!statuses.includes(state.status)) return false;
  if (state.snapshot === null) return state.status !== "available";
  const snapshot = state.snapshot;
  if (
    !snapshot ||
    !validDate(snapshot.observedAt) ||
    !Array.isArray(snapshot.limits) ||
    snapshot.limits.length > 100 ||
    !snapshot.limits.every(
      (limit) =>
        limit &&
        (limit.limitName === null || label(limit.limitName)) &&
        [limit.primary, limit.secondary].every(
          (window) => window === null || validWindow(window),
        ),
    )
  )
    return false;
  const resets = snapshot.resetCredits;
  return (
    resets === null ||
    Boolean(
      resets &&
      (resets.availableCount === null ||
        (Number.isSafeInteger(resets.availableCount) &&
          resets.availableCount >= 0)) &&
      (resets.credits === null ||
        (Array.isArray(resets.credits) &&
          resets.credits.length <= 1000 &&
          resets.credits.every(
            (detail) =>
              detail &&
              resetStatuses.includes(detail.status) &&
              validUnixTime(detail.expiresAt),
          ))),
    )
  );
}

export function SubscriptionUsagePanel({ client, visible }: Props) {
  const [state, setState] = useState<SubscriptionUsageState | null>(null);
  const [busy, setBusy] = useState(false);
  const lastSnapshot = useRef<SubscriptionUsageSnapshot | null>(null);
  const alive = useRef(true),
    sequence = useRef(0);
  const accept = useCallback((next: SubscriptionUsageState) => {
    if (!validSubscriptionUsageState(next))
      throw new Error("Invalid usage projection");
    if (next.snapshot) lastSnapshot.current = next.snapshot;
    setState({ ...next, snapshot: next.snapshot ?? lastSnapshot.current });
  }, []);
  const reload = useCallback(async () => {
    const request = ++sequence.current;
    setBusy(true);
    try {
      const next = await client.read();
      if (alive.current && request === sequence.current) accept(next);
    } catch {
      if (alive.current && request === sequence.current)
        setState({ status: "error", snapshot: lastSnapshot.current });
    } finally {
      if (alive.current && request === sequence.current) setBusy(false);
    }
  }, [client, accept]);
  useEffect(() => {
    alive.current = true;
    lastSnapshot.current = null;
    setState(null);
    setBusy(false);
    return () => {
      alive.current = false;
      sequence.current++;
    };
  }, [client]);
  useEffect(() => {
    if (visible) void reload();
  }, [visible, reload]);
  useEffect(
    () =>
      client.subscribe?.((next) => {
        if (!alive.current) return;
        sequence.current++;
        setBusy(false);
        try {
          accept(next);
        } catch {
          setState({ status: "error", snapshot: lastSnapshot.current });
        }
      }),
    [client, accept],
  );

  const snapshot = state?.snapshot;
  const stale = Boolean(snapshot && state?.status !== "available");
  return (
    <section aria-label="Codex allowance" className="space-y-5 py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold tracking-tight">Codex allowance</h2>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
            Account-wide allowance shared with other Codex clients, projects and
            agents. These figures do not measure Crew alone.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void reload()}
        >
          <RefreshCw className={busy ? "animate-spin" : undefined} />
          {busy ? "Refreshing…" : "Refresh allowance"}
        </Button>
      </div>
      <div aria-live="polite" className="space-y-2 text-sm">
        {(!state || (busy && !snapshot)) && (
          <p className="text-muted-foreground">Checking account allowance…</p>
        )}
        {state?.status === "disconnected" && (
          <p className="text-muted-foreground">
            Allowance is unavailable while the native account connection is
            disconnected. Sign in or reconnect, then refresh.
          </p>
        )}
        {state?.status === "unsupported" && (
          <p className="text-muted-foreground">
            This Codex runtime does not provide account allowance information.
          </p>
        )}
        {state?.status === "error" && (
          <p role="alert" className="text-destructive">
            Allowance could not be refreshed. Try again when the native
            connection is available.
          </p>
        )}
        {snapshot && (
          <p className="text-xs text-muted-foreground">
            {stale ? "Stale · Last successful update " : "Updated "}
            <time dateTime={snapshot.observedAt}>
              {date(snapshot.observedAt)}
            </time>
            {localTimezone ? ` · ${localTimezone}` : " · local time"}
          </p>
        )}
      </div>
      {snapshot && (
        <div className={stale ? "space-y-6 opacity-75" : "space-y-6"}>
          {snapshot.limits.length ? (
            snapshot.limits.map((bucket, bucketIndex) => (
              <section
                key={bucketIndex}
                aria-label={`${bucket.limitName ?? "Codex allowance"} usage`}
                className="space-y-4 border-t pt-5"
              >
                <h3 className="text-sm font-medium">
                  {bucket.limitName ?? "Codex allowance"}
                </h3>
                {[bucket.primary, bucket.secondary].map(
                  (window, windowIndex) => (
                    <UsageWindow
                      key={windowIndex}
                      window={window}
                      index={windowIndex}
                    />
                  ),
                )}
              </section>
            ))
          ) : (
            <p className="border-t pt-5 text-sm text-muted-foreground">
              No allowance windows were returned. Usage is unavailable.
            </p>
          )}
          <FullResets snapshot={snapshot} />
        </div>
      )}
    </section>
  );
}

function UsageWindow({
  window,
  index,
}: {
  window: SubscriptionUsageWindow | null;
  index: number;
}) {
  if (!window)
    return (
      <p className="text-sm text-muted-foreground">
        Window {index + 1} unavailable.
      </p>
    );
  const windowLabel = index === 0 ? "Primary" : "Secondary";
  const remaining =
    window.usedPercent === null ? null : clampPercent(100 - window.usedPercent);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
        <p className="font-medium">
          {windowLabel}
          {window.windowDurationMins !== null &&
            window.windowDurationMins > 0 && (
              <span className="ml-2 font-normal text-muted-foreground">
                {duration(window.windowDurationMins)} window
              </span>
            )}
        </p>
        <p>
          {window.usedPercent === null || remaining === null ? (
            <span className="text-muted-foreground">Usage unavailable</span>
          ) : (
            <>
              {percent(window.usedPercent)} used
              <span className="text-muted-foreground">
                {" "}
                · {percent(remaining)} remaining
              </span>
            </>
          )}
        </p>
      </div>
      {window.usedPercent !== null && (
        <div
          role="progressbar"
          aria-label={`${windowLabel} allowance used`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={clampPercent(window.usedPercent)}
          aria-valuetext={`${percent(window.usedPercent)} used, ${percent(remaining!)} remaining`}
          className="h-2 overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full rounded-full bg-primary"
            style={{ width: `${clampPercent(window.usedPercent)}%` }}
          />
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {window.resetsAt !== null ? (
          <>
            Resets{" "}
            <time dateTime={unixDate(window.resetsAt)}>
              {date(unixDate(window.resetsAt))}
            </time>
          </>
        ) : (
          "Reset time unavailable."
        )}
      </p>
    </div>
  );
}

function FullResets({ snapshot }: { snapshot: SubscriptionUsageSnapshot }) {
  const resets = snapshot.resetCredits;
  return (
    <section className="space-y-3 border-t pt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">Earned full resets</h3>
        <p className="text-sm">
          {resets?.availableCount === null || !resets
            ? "Availability unavailable"
            : `${resets.availableCount} available`}
        </p>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        Reading allowance never uses a reset. The available count is reported by
        Codex; expiry details may cover only some resets.
      </p>
      {resets?.credits === null || !resets ? (
        <p className="text-sm text-muted-foreground">
          Reset expiry information unavailable.
        </p>
      ) : resets.credits.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Codex returned no reset details.
        </p>
      ) : (
        <ul className="space-y-2 text-xs text-muted-foreground">
          {resets.credits.map((detail, index) => {
            const expired =
              detail.expiresAt !== null &&
              detail.expiresAt * 1000 <= Date.now();
            return (
              <li key={index}>
                {expired
                  ? "Expired"
                  : detail.status === "redeemed"
                    ? "Used"
                    : detail.status === "available"
                      ? "Available"
                      : detail.status === "redeeming"
                        ? "Being redeemed"
                        : "Status unavailable"}
                {detail.expiresAt !== null ? (
                  <>
                    {expired ? " · expiry " : " · expires "}
                    <time dateTime={unixDate(detail.expiresAt)}>
                      {date(unixDate(detail.expiresAt))}
                    </time>
                  </>
                ) : (
                  " · expiry unavailable"
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function duration(minutes: number) {
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `${days} ${days === 1 ? "day" : "days"}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}
