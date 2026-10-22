import { record } from "../shared/errors.mjs";
import type { UpdateStatus } from "./contracts.mjs";
export function unavailableUpdateStatus(version: string): UpdateStatus {
  return {
    phase: "unavailable",
    currentVersion: version,
    availableVersion: null,
    downloadPercent: null,
    error: null,
    installBlocked: true,
    reasons: ["Open the installed desktop app to manage updates."],
    supported: false,
    releaseUrl: "https://github.com/MattGibney/crew/releases/latest",
  };
}
export function acceptUpdateStatus(value: unknown): UpdateStatus {
  if (
    !record(value) ||
    typeof value.phase !== "string" ||
    typeof value.supported !== "boolean" ||
    typeof value.currentVersion !== "string" ||
    !Array.isArray(value.reasons)
  )
    throw new Error("Desktop update status is unavailable.");
  const boundedStrings = (items: unknown[]): string[] =>
    items
      .filter((item): item is string => typeof item === "string")
      .slice(0, 12)
      .map((item) => item.slice(0, 600));
  return {
    phase: value.phase.slice(0, 40),
    currentVersion: value.currentVersion.slice(0, 60),
    availableVersion:
      typeof value.availableVersion === "string"
        ? value.availableVersion.slice(0, 60)
        : null,
    downloadPercent:
      typeof value.downloadPercent === "number" &&
      Number.isFinite(value.downloadPercent)
        ? Math.max(0, Math.min(100, value.downloadPercent))
        : null,
    error: typeof value.error === "string" ? value.error.slice(0, 1000) : null,
    installBlocked: value.installBlocked !== false,
    reasons: boundedStrings(value.reasons),
    notices: Array.isArray(value.notices) ? boundedStrings(value.notices) : [],
    workspacePlan:
      value.workspacePlan &&
      typeof value.workspacePlan === "object" &&
      Buffer.byteLength(JSON.stringify(value.workspacePlan)) <= 131072
        ? structuredClone(value.workspacePlan)
        : null,
    supported: value.supported,
    releaseUrl: "https://github.com/MattGibney/crew/releases/latest",
  };
}
