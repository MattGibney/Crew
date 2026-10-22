import { readFile, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { parseObservedPreparation } from "../preparation/observed.mjs";
function parsePurpose(value: unknown): "update" | "quit" {
  if (value !== "update" && value !== "quit")
    throw new Error("Invalid preparation purpose.");
  return value;
}
import {
  record,
  parseJSON,
  string,
  errorCode,
  isString,
} from "./validation.mjs";
import type { PauseTarget } from "./update-contracts.mjs";
export interface SavedProject {
  preparation?: import("../preparation/coordinator.mjs").ObservedPreparation;
  id: string;
  name: string;
  configPath: string;
  childPlanId: string | null;
  previousPlanId: string | null;
  beginRequested: boolean;
  phase: string | null;
  targets: PauseTarget[];
  managerInterrupted?: boolean;
  reasons?: string[];
}
export interface PauseJournal {
  purpose?: "update" | "quit";
  schema: number;
  kind: string;
  consent: boolean;
  id: string;
  fromVersion: string;
  targetVersion: string;
  phase: string;
  createdAt: string;
  updatedAt: string;
  captureComplete: boolean;
  projects: SavedProject[];
  reasons: string[];
  resumeMode?: string;
}
const PHASES = new Set([
  "draining",
  "ready",
  "marking",
  "installing",
  "resuming",
  "canceled",
  "blocked",
  "complete",
]);
export const ID = /^[a-zA-Z0-9_-]{1,100}$/,
  VERSION = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;

/** Persisted grouped-update identity and fsync durability live outside lifecycle decisions. */
export async function writeWorkspacePauseJournal(
  path: string,
  journal: PauseJournal,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(JSON.stringify(journal) + "\n");
    await file.sync();
    await file.close();
    file = null;
    await rename(temporary, path);
    const folder = await open(dirname(path), "r");
    try {
      await folder.sync();
    } finally {
      await folder.close();
    }
  } finally {
    await file?.close();
    await unlink(temporary).catch((error) => {
      if (errorCode(error) !== "ENOENT") throw error;
    });
  }
}
export async function readWorkspacePauseJournal(
  path: string,
): Promise<PauseJournal | null> {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (Buffer.byteLength(raw) > 1048576)
    throw new Error("Journal exceeds bound.");
  const value = decodeJournal(parseJSON(raw));
  if (
    !value ||
    value.schema !== 1 ||
    !ID.test(value.id || "") ||
    value.kind !== "pause-update" ||
    value.consent !== true ||
    !PHASES.has(value.phase) ||
    !VERSION.test(value.targetVersion || "") ||
    !VERSION.test(value.fromVersion || "") ||
    !Array.isArray(value.projects) ||
    value.projects.length > 64 ||
    !Array.isArray(value.reasons) ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.captureComplete !== "boolean" ||
    (value.resumeMode !== undefined &&
      !["explicit", "installed"].includes(value.resumeMode)) ||
    value.projects.some(
      (project) =>
        !project ||
        !ID.test(project.id || "") ||
        !isAbsolute(project.configPath || "") ||
        typeof project.name !== "string" ||
        (project.childPlanId !== null && !ID.test(project.childPlanId || "")) ||
        !Array.isArray(project.targets),
    )
  )
    throw new Error("Invalid journal.");
  if (
    new Set(value.projects.map((project) => project.id)).size !==
      value.projects.length ||
    new Set(value.projects.map((project) => project.configPath)).size !==
      value.projects.length
  )
    throw new Error("Duplicate identity.");
  return value;
}

function decodeJournal(input: unknown): PauseJournal {
  const value = record(input);
  if (
    typeof value.schema !== "number" ||
    typeof value.consent !== "boolean" ||
    typeof value.captureComplete !== "boolean" ||
    !Array.isArray(value.projects) ||
    !Array.isArray(value.reasons) ||
    !value.reasons.every(isString)
  )
    throw new Error("Invalid grouped update journal.");
  const projects = value.projects.map((input) => {
    const project = record(input);
    if (
      typeof project.beginRequested !== "boolean" ||
      !Array.isArray(project.targets) ||
      (project.reasons !== undefined &&
        (!Array.isArray(project.reasons) || !project.reasons.every(isString)))
    )
      throw new Error("Invalid grouped project.");
    return {
      id: string(project.id, "Project ID"),
      name: string(project.name, "Project name"),
      configPath: string(project.configPath, "Project configuration"),
      childPlanId:
        project.childPlanId === null
          ? null
          : string(project.childPlanId, "Child plan ID"),
      previousPlanId:
        project.previousPlanId === null
          ? null
          : string(project.previousPlanId, "Previous plan ID"),
      beginRequested: project.beginRequested,
      phase:
        project.phase === null ? null : string(project.phase, "Project phase"),
      targets: project.targets.map((input) => {
        const target = record(input);
        return {
          taskId: string(target.taskId, "Target task"),
          ...(target.progress === undefined
            ? {}
            : { progress: string(target.progress, "Target progress") }),
        };
      }),
      managerInterrupted: project.managerInterrupted === true,
      ...(project.reasons === undefined ? {} : { reasons: project.reasons }),
      ...(project.preparation === undefined
        ? {}
        : { preparation: parseObservedPreparation(project.preparation) }),
    };
  });
  return {
    schema: value.schema,
    ...(value.purpose === undefined
      ? {}
      : { purpose: parsePurpose(value.purpose) }),
    kind: string(value.kind, "Plan kind"),
    consent: value.consent,
    id: string(value.id, "Plan ID"),
    fromVersion: string(value.fromVersion, "Previous version"),
    targetVersion: string(value.targetVersion, "Target version"),
    phase: string(value.phase, "Plan phase"),
    createdAt: string(value.createdAt, "Creation time"),
    updatedAt: string(value.updatedAt, "Update time"),
    captureComplete: value.captureComplete,
    projects,
    reasons: value.reasons,
    ...(value.resumeMode === undefined
      ? {}
      : { resumeMode: string(value.resumeMode, "Resume mode") }),
  };
}
