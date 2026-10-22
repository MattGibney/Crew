/** Read-only projection of the public native account/rateLimits protocol.
 * No account identity, reset-credit identity, balance, or inferred token ceiling
 * crosses this boundary. A reset detail list can be capped by the server;
 * availableCount is authoritative even when it differs from credits.length.
 */
export interface NativeUsageWindow {
  usedPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: number | null; // Unix seconds, as reported by the native server.
}

export interface NativeUsageLimit {
  limitId: string | null;
  limitName: string | null;
  normalModelSlug: string | null;
  primary: NativeUsageWindow | null;
  secondary: NativeUsageWindow | null;
}

export interface NativeResetCredit {
  resetType: "codexRateLimits" | "unknown";
  status: "available" | "redeeming" | "redeemed" | "unknown";
  grantedAt: number | null;
  expiresAt: number | null;
  title: string | null;
  description: string | null;
}

export interface SubscriptionUsageSnapshot {
  observedAt: string; // Host receipt time; never supplied by native payload data.
  /** Backend permission, not inferred from percentages or reset timestamps. */
  ordinaryUsageAllowed: boolean | null;
  limits: NativeUsageLimit[];
  resetCredits: {
    availableCount: number | null;
    /** null: details unavailable; []: a fetched, empty detail list. */
    credits: NativeResetCredit[] | null;
  } | null;
}

export type NativeUsageSnapshot = SubscriptionUsageSnapshot;

/** Fixed, value-free errors are safe to map to a UI unavailable state. */
export class CodexUsageDecodeError extends Error {
  constructor(
    readonly code:
      | "invalid_native_usage"
      | "ambiguous_native_usage_update" = "invalid_native_usage",
  ) {
    super(
      code === "ambiguous_native_usage_update"
        ? "Native usage update needs a fresh read."
        : "Native usage response is invalid.",
    );
    this.name = "CodexUsageDecodeError";
  }
}

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CodexUsageDecodeError();
  }
  return value as RecordValue;
}

function has(value: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new CodexUsageDecodeError();
  return value;
}

function nullableBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "boolean") throw new CodexUsageDecodeError();
  return value;
}

function nullableNumber(value: unknown, integer = false): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint" && integer) {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new CodexUsageDecodeError();
    }
    return Number(value);
  }
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    (integer && !Number.isSafeInteger(value))
  ) {
    throw new CodexUsageDecodeError();
  }
  return value;
}

function windowValue(
  value: unknown,
  previous: NativeUsageWindow | null = null,
): NativeUsageWindow | null {
  if (value === null || value === undefined) return null;
  const input = record(value);
  return {
    // Preserve the reported percentage, including values above 100. Do not
    // silently clamp it or derive a balance/ordinaryUsageAllowed from it.
    usedPercent: has(input, "usedPercent")
      ? nullableNumber(input.usedPercent)
      : (previous?.usedPercent ?? null),
    windowDurationMins: has(input, "windowDurationMins")
      ? nullableNumber(input.windowDurationMins, true)
      : (previous?.windowDurationMins ?? null),
    resetsAt: has(input, "resetsAt")
      ? nullableNumber(input.resetsAt, true)
      : (previous?.resetsAt ?? null),
  };
}

function limitValue(
  value: unknown,
  previous?: NativeUsageLimit,
  mapId?: string,
): NativeUsageLimit {
  const input = record(value);
  const reportedId = nullableText(input.limitId);
  if (mapId !== undefined && reportedId !== null && reportedId !== mapId) {
    throw new CodexUsageDecodeError();
  }
  return {
    // The newer map supplies bucket identity even if its snapshot omits it.
    limitId:
      mapId ??
      (has(input, "limitId") ? reportedId : (previous?.limitId ?? null)),
    limitName: has(input, "limitName")
      ? nullableText(input.limitName)
      : (previous?.limitName ?? null),
    normalModelSlug: has(input, "normalModelSlug")
      ? nullableText(input.normalModelSlug)
      : (previous?.normalModelSlug ?? null),
    primary: has(input, "primary")
      ? windowValue(input.primary, previous?.primary)
      : (previous?.primary ?? null),
    secondary: has(input, "secondary")
      ? windowValue(input.secondary, previous?.secondary)
      : (previous?.secondary ?? null),
  };
}

function resetCredit(value: unknown): NativeResetCredit {
  const input = record(value);
  const resetType = input.resetType;
  const status = input.status;
  if (
    (resetType !== "codexRateLimits" && resetType !== "unknown") ||
    (status !== "available" &&
      status !== "redeeming" &&
      status !== "redeemed" &&
      status !== "unknown")
  ) {
    throw new CodexUsageDecodeError();
  }
  return {
    resetType,
    status,
    grantedAt: nullableNumber(input.grantedAt, true),
    expiresAt: nullableNumber(input.expiresAt, true),
    title: nullableText(input.title),
    description: nullableText(input.description),
  };
}

function resetSummary(
  value: unknown,
): SubscriptionUsageSnapshot["resetCredits"] {
  if (value === null || value === undefined) return null;
  const input = record(value);
  if (
    input.credits !== null &&
    input.credits !== undefined &&
    !Array.isArray(input.credits)
  ) {
    throw new CodexUsageDecodeError();
  }
  return {
    availableCount: nullableNumber(input.availableCount, true),
    credits: Array.isArray(input.credits)
      ? input.credits.map(resetCredit)
      : null,
  };
}

/** Decode the result object of account/rateLimits/read, not its RPC envelope.
 * A present multi-bucket map takes precedence over the legacy single bucket,
 * including an explicitly empty map. Older servers can omit the map.
 */
export function projectCodexUsageRead(
  value: unknown,
): SubscriptionUsageSnapshot {
  const input = record(value);
  const multi = input.rateLimitsByLimitId;
  const limits =
    multi !== null && multi !== undefined
      ? Object.entries(record(multi)).map(([id, limit]) => {
          if (!id) throw new CodexUsageDecodeError();
          return limitValue(limit, undefined, id);
        })
      : [limitValue(input.rateLimits)];
  return {
    observedAt: new Date().toISOString(),
    ordinaryUsageAllowed: nullableBoolean(input.ordinaryUsageAllowed),
    limits,
    resetCredits: resetSummary(input.rateLimitResetCredits),
  };
}

/** Merge params from account/rateLimits/updated. This notification is sparse
 * and supplies only rateLimits; reset details and account-level permission
 * remain the last read values. Omitted fields survive; explicit null clears.
 * A multi-bucket update without identity requires a read rather than a guess.
 */
export function mergeCodexUsageUpdate(
  previous: SubscriptionUsageSnapshot,
  value: unknown,
): SubscriptionUsageSnapshot {
  const input = record(record(value).rateLimits);
  const id = nullableText(input.limitId);
  let index: number;
  if (id !== null) {
    index = previous.limits.findIndex((limit) => limit.limitId === id);
    // A legacy or explicitly cleared identity may be this same bucket. A new
    // named row cannot safely be appended until a read resolves that identity.
    if (index < 0 && previous.limits.some((limit) => limit.limitId === null)) {
      throw new CodexUsageDecodeError("ambiguous_native_usage_update");
    }
  } else if (previous.limits.length === 1) {
    index = 0;
  } else {
    throw new CodexUsageDecodeError("ambiguous_native_usage_update");
  }
  const limit = limitValue(input, previous.limits[index]);
  return {
    ...previous,
    observedAt: new Date().toISOString(),
    limits:
      index < 0
        ? [...previous.limits, limit]
        : previous.limits.map((entry, i) => (i === index ? limit : entry)),
  };
}
