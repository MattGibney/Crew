import type { ProcessSnapshot } from "../process-ownership.mjs";
import type { ProcessVerdict } from "../shared/update.mjs";
import { record as isRecord } from "../shared/errors.mjs";
interface ProcessIdentity {
  pid: number;
  start: string;
  commandHash: string;
  state?: string;
}
function identity(value: unknown): value is ProcessIdentity {
  return (
    isRecord(value) &&
    typeof value.pid === "number" &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 1 &&
    typeof value.start === "string" &&
    value.start.length > 0 &&
    value.start.length < 160 &&
    typeof value.commandHash === "string" &&
    /^[a-f0-9]{64}$/i.test(value.commandHash)
  );
}
export function processLive(row: unknown): boolean {
  return (
    isRecord(row) && typeof row.state === "string" && !row.state.includes("Z")
  );
}
function observed(
  records: unknown,
  processes: ProcessSnapshot,
): ProcessVerdict {
  if (!Array.isArray(records) || records.length > 4096) return "unknown";
  let uncertain = false;
  for (const expected of records) {
    if (!identity(expected)) {
      uncertain = true;
      continue;
    }
    const current = processes.get(expected.pid);
    if (!current) continue;
    if (!identity(current) || typeof current.state !== "string") {
      uncertain = true;
      continue;
    }
    if (!processLive(current) || current.start !== expected.start) continue;
    if (current.commandHash === expected.commandHash) return "live";
    uncertain = true;
  }
  return uncertain ? "unknown" : "absent";
}
export function processVerdict({
  records,
  terminal,
  processes,
  contradictory = false,
}: {
  records: unknown;
  terminal: boolean;
  processes: ProcessSnapshot | null;
  contradictory?: boolean;
}): ProcessVerdict {
  if (!(processes instanceof Map)) return "unknown";
  const current = observed(records, processes);
  if (current === "live") return "live";
  if (current === "unknown" || contradictory) return "unknown";
  return terminal ? "stopped" : "unknown";
}
