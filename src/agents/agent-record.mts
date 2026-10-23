import type { Agent } from "./contracts.mjs";

/** Disk format versions are independent of the project index and native runtime. */
export const agentRecordVersion = 1;
export function agentRecord(agent: Agent): Record<string, unknown> {
  return { schemaVersion: agentRecordVersion, ...agent };
}

/** Version zero is the previous unversioned core. Full agent validation follows
 * assembly in FoundationStore; unknown future versions must never be rewritten. */
export function readAgentRecord(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid agent core record.");
  const record = value as Record<string, unknown>;
  if (!Object.hasOwn(record, "schemaVersion")) return record;
  if (record.schemaVersion !== agentRecordVersion)
    throw new Error(
      "Unsupported agent core schema version; upgrade Crew before opening this project.",
    );
  const { schemaVersion: _, ...agent } = record;
  return agent;
}
