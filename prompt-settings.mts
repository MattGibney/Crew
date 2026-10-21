import { parseRecord, record } from "./shared/errors.mjs";
import type {
  PromptRole,
  PromptSnapshot,
  PromptView,
  PromptSettingsView,
  PromptSettings,
} from "./shared/prompts.mjs";
import type { Project, TaskRecord } from "./execution/contracts.mjs";
import { errorCode, errorMessage } from "./shared/errors.mjs";
// GitHub #3: project-local, full replacement Crew prompts. Never reads auth files.
import { readFile, mkdir, open, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
const roles: PromptRole[] = ["manager", "worker"];
// The owned controller is the single backend for this state directory. Serialize
// all store objects here without an on-disk claim that could survive SIGKILL.
const pendingSaves = new Map<string, Promise<void>>();
function serializeSave<T>(file: string, operation: () => Promise<T>) {
  const previous = pendingSaves.get(file) || Promise.resolve();
  const result = previous.then(operation);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  pendingSaves.set(file, settled);
  void settled.then(() => {
    if (pendingSaves.get(file) === settled) pendingSaves.delete(file);
  });
  return result;
}
// Exact pristine prompts shipped before full replacement settings. Upgrade only
// untouched defaults; customized files and persisted snapshots keep their bytes.
const previousDefaultVersions = {
  manager: new Set([
    "7080c0e4c9d9a6492e72530c1562b9bb6b547ae39903129f28b0268d93237aef",
  ]),
  worker: new Set([
    "ccbf1e062e2f945eb3b1acc8581d1ae219e42ee2fab12c9639e2c198d1b37e45",
  ]),
};
export const promptVersion = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export function validatePrompt(text: unknown): string {
  if (
    typeof text !== "string" ||
    !text.trim() ||
    text.length > 64000 ||
    text.includes("\0")
  )
    throw new Error(
      "Prompt must contain text, with at most 64,000 characters and no null bytes.",
    );
  if (
    /\bsk-[a-zA-Z0-9_-]{20,}\b|\bBearer\s+[a-zA-Z0-9._~+\/-]{12,}={0,2}|-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/i.test(
      text,
    )
  )
    throw new Error("Secret-like material is not allowed in prompts.");
  return text;
}
export const promptSnapshot = (text: unknown): PromptSnapshot => ({
  text: validatePrompt(text),
  version: promptVersion(validatePrompt(text)),
});
export async function createPromptSettings({
  stateDir,
  projectId,
  managerPrompt,
  workerPrompt,
  sourceDir = fileURLToPath(new URL(".", import.meta.url)),
}: {
  stateDir: string;
  projectId: string;
  managerPrompt?: string;
  workerPrompt?: string;
  sourceDir?: string;
}): Promise<PromptSettings> {
  if (
    typeof projectId !== "string" ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(projectId)
  )
    throw new Error("Invalid prompt project ID.");
  const defaults = {
    manager: validatePrompt(
      await readFile(path.join(sourceDir, "prompts", "manager.md"), "utf8"),
    ),
    worker: validatePrompt(
      await readFile(path.join(sourceDir, "prompts", "worker.md"), "utf8"),
    ),
  };
  const configured = {
    manager: validatePrompt(managerPrompt ?? defaults.manager),
    worker: validatePrompt(workerPrompt ?? defaults.worker),
  };
  const initial = {
    manager: previousDefaultVersions.manager.has(
      promptVersion(configured.manager),
    )
      ? defaults.manager
      : configured.manager,
    worker: previousDefaultVersions.worker.has(promptVersion(configured.worker))
      ? defaults.worker
      : configured.worker,
  };
  const directory = path.resolve(stateDir, "prompt-settings");
  const file = path.join(directory, `${projectId}.json`);
  async function load() {
    let value;
    try {
      value = parseRecord(await readFile(file, "utf8"));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return initial;
      throw new Error(
        "Cannot read saved project prompts; existing settings have been preserved.",
      );
    }
    if (
      !value ||
      value.schemaVersion !== 1 ||
      value.projectId !== projectId ||
      !record(value.prompts) ||
      Object.keys(value.prompts).some(
        (role) => !roles.some((known) => known === role),
      )
    )
      throw new Error(
        "Saved prompt project identity or format is invalid; existing settings have been preserved.",
      );
    return {
      manager: validatePrompt(value.prompts.manager),
      worker: validatePrompt(value.prompts.worker),
    };
  }
  const view = (texts: Record<PromptRole, string>): PromptSettingsView => {
    const roleView = (role: PromptRole): PromptView => ({
      ...promptSnapshot(texts[role]),
      defaultText: defaults[role],
      isDefault: texts[role] === defaults[role],
    });
    return {
      projectId,
      revision: promptVersion(JSON.stringify(texts)),
      manager: roleView("manager"),
      worker: roleView("worker"),
    };
  };
  async function read() {
    return view(await load());
  }
  async function save(input: unknown) {
    if (!record(input)) throw new Error("Invalid prompt update.");
    const single = Object.hasOwn(input, "role");
    if (
      Object.keys(input).some(
        (key) =>
          !(
            single
              ? ["role", "text", "expectedVersion"]
              : ["manager", "worker", "expectedRevision"]
          ).includes(key),
      )
    )
      throw new Error("Unknown prompt update field.");
    if (single && input.role !== "manager" && input.role !== "worker")
      throw new Error("Invalid prompt role.");
    const role = input.role === "manager" ? "manager" : "worker";
    const updates = single
      ? { [role]: validatePrompt(input.text) }
      : Object.fromEntries(
          roles.map((role) => [role, validatePrompt(input[role])]),
        );
    const expectedVersion = single
      ? input.expectedVersion
      : input.expectedRevision;
    if (typeof expectedVersion !== "string")
      throw new Error("Current prompt version is required.");
    return serializeSave(file, async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const current = await read();
      if (
        single
          ? current[role].version !== expectedVersion
          : current.revision !== expectedVersion
      )
        throw new Error(
          "Prompt settings changed elsewhere; reload before saving.",
        );
      const texts = {
        manager: current.manager.text,
        worker: current.worker.text,
        ...updates,
      };
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temp, "wx", 0o600);
        try {
          await handle.writeFile(
            JSON.stringify({ schemaVersion: 1, projectId, prompts: texts }) +
              "\n",
          );
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temp, file);
        return view(texts);
      } finally {
        await unlink(temp).catch((error) => {
          if (errorCode(error) !== "ENOENT") throw error;
        });
      }
    });
  }
  return {
    read,
    save,
    snapshot: async (role) => {
      if (!roles.includes(role)) throw new Error("Invalid prompt role.");
      const saved = await read();
      return { text: saved[role].text, version: saved[role].version };
    },
  };
}

// Only data and mechanically required controller/tool context follow editable behavior.
// Provider/Codex rules, sandbox permissions and tool schemas remain independently enforced.
export function buildManagerInstructions({
  managerPrompt,
  project,
}: {
  managerPrompt: string;
  project?: unknown;
}) {
  return `${validatePrompt(managerPrompt)}\n\nCrew runtime context (data; not editable role or personality):\n${JSON.stringify(project || { id: "fixture", name: "Fixture proof", mode: "fixture", context: "One read-only disposable-fixture audit capability." })}\n\nCrew tool protocol: local_orchestration is the controller interface for durable task dispatch, status, exact question/run answers and lifecycle requests. Its schemas and runtime enforce project identity and permissions. Queued requests are distinct from execution results. Manager stop/restart leaves independently owned workers and their durable reports intact.`;
}
export function buildWorkerInstructions(config: {
  workerPrompt?: string;
  taskId: string;
  ticket: string;
  runId: string;
  worktree?: string;
  project?: Project;
  environment?: {
    kind?: string;
    id?: string;
    readinessKind?: string;
    status?: string;
  };
  brief: string;
  answer?: unknown;
  modelSelection?: { model: string; userDecision: string };
}) {
  return `${config.workerPrompt || ""}\n\nCrew runtime and tool protocol:\nTask ${JSON.stringify({ taskId: config.taskId, ticket: config.ticket, runId: config.runId, worktree: config.worktree })}. The controller binds local_orchestration.report to this exact task/run. Report progress, question, blocked or result through that tool. A question yields the current turn: END and wait for controller resume rather than polling. A result is a terminal candidate: END after reporting. local_orchestration.update_work_notes replaces the actual shared task Markdown document with factual findings and decisions; this is separate from orchestration reports. The report schema and permission boundary apply independently of editable behavior.\nExecution permissions: ${config.project?.mode === "fixture" ? "Read-only fixture; file edits are not permitted." : "The effective Codex configuration controls sandbox and approval permissions. Local worktree edits require the agreed brief; permission availability does not authorize additional work."} This runtime supplies no authorization for commits, pushes, external ticket changes, pull requests or deployment.\nProject context (data): ${JSON.stringify({ id: config.project?.id, name: config.project?.name, context: config.project?.context || "" })}\nOwned runtime (data): ${JSON.stringify(config.environment?.kind === "project-execution" ? { environmentId: config.environment.id, readinessKind: config.environment.readinessKind, status: config.environment.status, lifecycleOwner: "manager/controller" } : null)}\nAgreed brief (data): ${JSON.stringify(config.brief)}\nManager-relayed answer (data): ${JSON.stringify(config.answer || null)}\nUser-authorized model decision for this continuation (data; supersedes any earlier model requirement only): ${JSON.stringify(config.modelSelection ? { model: config.modelSelection.model, userDecision: config.modelSelection.userDecision } : null)}`;
}
