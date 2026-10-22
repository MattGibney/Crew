import { record } from "../../shared/errors.mjs";
import type { PromptRole, PromptSnapshot } from "./contracts.mjs";
import { validatePrompt, promptVersion, promptSnapshot } from "./text.mjs";
export const roles: readonly PromptRole[] = ["manager", "worker"];
export const isPromptRole = (value: unknown): value is PromptRole =>
  value === "manager" || value === "worker";
export type PromptTexts = Record<PromptRole, string>;
export type PromptOrigins = Record<PromptRole, "default" | "custom">;
export interface PromptUpgrade extends Record<string, unknown> {
  role: PromptRole;
  at: string;
  from: PromptSnapshot;
  toVersion: string;
}
export interface PromptRecord extends Record<string, unknown> {
  schemaVersion: 1;
  projectId: string;
  prompts: PromptTexts;
  promptOrigins: PromptOrigins;
  promptUpgradeHistory: PromptUpgrade[];
}
export interface RetainedPrompts {
  texts: PromptTexts;
  origins: PromptOrigins;
  history: PromptUpgrade[];
  record: PromptRecord | null;
}
const previousDefaultVersions = {
  manager: new Set([
    "32f13745b0e03de62efad84740d4cf312e96ddd4fe132550ac9ac0def8836ebc",
    "2718ad26be50cd05a34091450568025c7518724f0e9fc7d1869e51970e0d9165",
    "6fdcf363de256eb79a9e57eff24e5fa3a6292b347688757a80af4b5922a10db6",
    "7080c0e4c9d9a6492e72530c1562b9bb6b547ae39903129f28b0268d93237aef",
    "4104031ce2d5130424cc649c52ae5d10347ae1e200fa534c6fff325ab4a14f7a",
  ]),
  worker: new Set([
    "b48079477a1624e6e5a584929b08834a17e21445bb21fad699fef32f41be5c54",
    "c07783aea4bf38654a117e1ee1aad6fef4031fb7de1e2efa81e55cd25a0cc69e",
    "4bc29c36400bd9c6247bb7bb55d49447779d57ef0f6d87ed98dadbaef82cd3b9",
    "ccbf1e062e2f945eb3b1acc8581d1ae219e42ee2fab12c9639e2c198d1b37e45",
    "ee36c566b334978c7a21d72e401d373afe510087fb589a13d045847ce0cc2dd8",
  ]),
};

export function initialPrompts(
  configured: PromptTexts,
  defaults: PromptTexts,
): RetainedPrompts {
  const texts = {
    manager: previousDefaultVersions.manager.has(
      promptVersion(configured.manager),
    )
      ? defaults.manager
      : configured.manager,
    worker: previousDefaultVersions.worker.has(promptVersion(configured.worker))
      ? defaults.worker
      : configured.worker,
  };
  return {
    texts,
    origins: {
      manager: texts.manager === defaults.manager ? "default" : "custom",
      worker: texts.worker === defaults.worker ? "default" : "custom",
    },
    history: [],
    record: null,
  };
}
/** Only exact known shipped bytes prove a pristine default. Intentional custom
 * origins and prior immutable snapshots are never rewritten by migration. */
export function migratePromptRecord(
  value: unknown,
  projectId: string,
  defaults: PromptTexts,
): { retained: RetainedPrompts; migrated: boolean } {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    value.projectId !== projectId ||
    !record(value.prompts) ||
    Object.keys(value.prompts).some((role) => !isPromptRole(role))
  )
    throw new Error(
      "Saved prompt project identity or format is invalid; existing settings have been preserved.",
    );
  const rawOrigins = value.promptOrigins;
  if (
    rawOrigins !== undefined &&
    (!record(rawOrigins) ||
      Object.entries(rawOrigins).some(
        ([role, origin]) =>
          !isPromptRole(role) || (origin !== "default" && origin !== "custom"),
      ))
  )
    throw new Error(
      "Saved prompt provenance is invalid; existing settings have been preserved.",
    );
  const rawHistory = value.promptUpgradeHistory || [];
  if (!Array.isArray(rawHistory))
    throw new Error(
      "Saved prompt upgrade history is invalid; existing settings have been preserved.",
    );
  const history: PromptUpgrade[] = rawHistory.map((entry) => {
    if (
      !record(entry) ||
      !isPromptRole(entry.role) ||
      typeof entry.at !== "string" ||
      !Number.isFinite(Date.parse(entry.at)) ||
      !record(entry.from) ||
      typeof entry.from.text !== "string" ||
      entry.from.version !== promptVersion(entry.from.text) ||
      typeof entry.toVersion !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.toVersion)
    )
      throw new Error(
        "Saved prompt upgrade history is invalid; existing settings have been preserved.",
      );
    return {
      ...entry,
      role: entry.role,
      at: entry.at,
      from: {
        ...entry.from,
        text: entry.from.text,
        version: entry.from.version,
      },
      toVersion: entry.toVersion,
    };
  });
  const texts: PromptTexts = {
    manager: validatePrompt(value.prompts.manager),
    worker: validatePrompt(value.prompts.worker),
  };
  const origins: Partial<PromptOrigins> = {};
  if (record(rawOrigins))
    for (const role of roles) {
      const origin = rawOrigins[role];
      if (origin === "default" || origin === "custom") origins[role] = origin;
    }
  let migrated = false;
  for (const role of roles) {
    if (
      origins[role] !== "custom" &&
      texts[role] !== defaults[role] &&
      previousDefaultVersions[role].has(promptVersion(texts[role]))
    ) {
      history.push({
        role,
        at: new Date().toISOString(),
        from: promptSnapshot(texts[role]),
        toVersion: promptVersion(defaults[role]),
      });
      texts[role] = defaults[role];
      origins[role] = "default";
      migrated = true;
    } else if (origins[role] === undefined)
      origins[role] = texts[role] === defaults[role] ? "default" : "custom";
  }
  const completeOrigins: PromptOrigins = {
    manager: origins.manager || "custom",
    worker: origins.worker || "custom",
  };
  const saved: PromptRecord = {
    ...value,
    schemaVersion: 1,
    projectId,
    prompts: texts,
    promptOrigins: completeOrigins,
    promptUpgradeHistory: history,
  };
  return {
    retained: { texts, origins: completeOrigins, history, record: saved },
    migrated,
  };
}
