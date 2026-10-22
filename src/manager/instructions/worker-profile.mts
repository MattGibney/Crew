import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseRecord, record } from "../../shared/errors.mjs";
import { migratePromptRecord } from "./provenance.mjs";
import { promptSnapshot, validatePrompt } from "./text.mjs";

/** Read only the canonical saved document. No configured/default/run fallback,
 * initialization or migration writes in a detached worker. */
export async function readSavedWorkerProfile(
  stateDir: string,
  projectId: string,
) {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(projectId))
    throw new Error("Invalid worker profile project identity.");
  try {
    const raw = parseRecord(
      await readFile(
        path.join(stateDir, "prompt-settings", `${projectId}.json`),
        "utf8",
      ),
    );
    if (!record(raw.prompts)) throw new Error("Invalid saved worker profile.");
    const prompts = raw.prompts;
    const unchanged = {
      manager: validatePrompt(prompts.manager),
      worker: validatePrompt(prompts.worker),
    };
    const { retained } = migratePromptRecord(raw, projectId, unchanged);
    return promptSnapshot(retained.texts.worker);
  } catch {
    throw new Error(
      "Cannot read the saved project worker profile. Restore access to its saved Settings document or restore a valid copy, then explicitly retry. No startup or historical instructions were substituted.",
    );
  }
}
