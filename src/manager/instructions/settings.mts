import { runtimeRoot } from "../../shared/paths.mjs";
// Project-local full replacement prompts, with serialized provenance migration.
import { readFile, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRecord, record, errorCode } from "../../shared/errors.mjs";
import type {
  PromptRole,
  PromptView,
  PromptSettingsView,
  PromptSettings,
} from "./contracts.mjs";
import type { Project } from "../../workers/contracts.mjs";
import { validatePrompt, promptSnapshot, promptVersion } from "./text.mjs";
export { validatePrompt, promptSnapshot, promptVersion } from "./text.mjs";
import {
  roles,
  isPromptRole,
  initialPrompts,
  migratePromptRecord,
  type PromptTexts,
  type PromptRecord,
  type RetainedPrompts,
} from "./provenance.mjs";
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

export async function createPromptSettings({
  stateDir,
  projectId,
  managerPrompt,
  workerPrompt,
  sourceDir = runtimeRoot,
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
  const defaults: PromptTexts = {
    manager: validatePrompt(
      await readFile(path.join(sourceDir, "prompts", "manager.md"), "utf8"),
    ),
    worker: validatePrompt(
      await readFile(path.join(sourceDir, "prompts", "worker.md"), "utf8"),
    ),
  };
  const configured: PromptTexts = {
    manager: validatePrompt(managerPrompt ?? defaults.manager),
    worker: validatePrompt(workerPrompt ?? defaults.worker),
  };
  const initial = initialPrompts(configured, defaults),
    directory = path.resolve(stateDir, "prompt-settings"),
    file = path.join(directory, `${projectId}.json`);
  async function persist(saved: PromptRecord): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(saved) + "\n");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, file);
    } finally {
      await unlink(temporary).catch((error) => {
        if (errorCode(error) !== "ENOENT") throw error;
      });
    }
  }
  async function load(): Promise<RetainedPrompts> {
    let value: unknown;
    try {
      value = parseRecord(await readFile(file, "utf8"));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return initial;
      throw new Error(
        "Cannot read saved project prompts; existing settings have been preserved.",
      );
    }
    const { retained, migrated } = migratePromptRecord(
      value,
      projectId,
      defaults,
    );
    if (migrated && retained.record) await persist(retained.record);
    return retained;
  }
  const view = (texts: PromptTexts): PromptSettingsView => {
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
  async function read(): Promise<PromptSettingsView> {
    return serializeSave(file, async () => view((await load()).texts));
  }
  async function save(input: unknown): Promise<PromptSettingsView> {
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
    if (single && !isPromptRole(input.role))
      throw new Error("Invalid prompt role.");
    const role = isPromptRole(input.role) ? input.role : "manager";
    const updates: Partial<PromptTexts> = single
      ? { [role]: validatePrompt(input.text) }
      : {
          manager: validatePrompt(input.manager),
          worker: validatePrompt(input.worker),
        };
    const expectedVersion = single
      ? input.expectedVersion
      : input.expectedRevision;
    if (typeof expectedVersion !== "string")
      throw new Error("Current prompt version is required.");
    return serializeSave(file, async () => {
      const retained = await load(),
        current = view(retained.texts);
      if (
        single
          ? current[role].version !== expectedVersion
          : current.revision !== expectedVersion
      )
        throw new Error(
          "Prompt settings changed elsewhere; reload before saving.",
        );
      const texts: PromptTexts = { ...retained.texts, ...updates },
        origins = { ...retained.origins };
      for (const updated of roles)
        if (Object.hasOwn(updates, updated))
          origins[updated] =
            texts[updated] === defaults[updated] ? "default" : "custom";
      await persist({
        ...retained.record,
        schemaVersion: 1,
        projectId,
        prompts: texts,
        promptOrigins: origins,
        promptUpgradeHistory: retained.history,
      });
      return view(texts);
    });
  }
  return {
    read,
    save,
    snapshot: async (role) => {
      if (!isPromptRole(role)) throw new Error("Invalid prompt role.");
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
  return `${validatePrompt(managerPrompt)}\n\nCrew runtime context (data; not editable role or personality):\n${JSON.stringify(project || { id: "fixture", name: "Fixture proof", mode: "fixture", context: "One read-only disposable-fixture audit capability." })}\n\nCrew tool protocol: local_orchestration is the controller interface for durable task dispatch, status, exact question/run answers and lifecycle requests. Its schemas enforce project and message identity; native Codex supplies execution policy and approvals. Queued requests are distinct from execution results. Manager stop/restart leaves independently owned workers and their durable reports intact. set_workflow_state records explicit project workflow labels separately from native execution. get_project_environment supplies project commands and instructions as context; agents execute commands through native tools. Crew does not run setup, Start or readiness commands as a dispatch precondition.`;
}
export function buildWorkerInstructions(config: {
  workerPrompt?: string;
  assignmentId?: string;
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
  return `${config.workerPrompt || ""}\n\nCrew runtime and tool protocol:\nTask ${JSON.stringify({ taskId: config.taskId, ticket: config.ticket, assignmentId: config.assignmentId || "initial", runId: config.runId, worktree: config.worktree })}. The controller binds local_orchestration.report to this exact task/run. Reports are messages: a question, blocker or result does not end a native turn or set project workflow. set_workflow_state stores agent-reported labels and optional progressPercent estimates; omission retains the estimate and null clears it. Native turn and process evidence describe execution separately. get_project_environment supplies configured commands and instructions as context for normal native tools and approvals. Crew does not automatically run setup, Start or readiness before delivering directions. local_orchestration.update_work_notes replaces the actual shared task Markdown document with factual findings and decisions; this is separate from orchestration reports. The report schema and permission boundary apply independently of editable behavior.\nExecution permissions: ${config.project?.mode === "fixture" ? "This disposable fixture uses its native read-only sandbox." : "Follow the manager direction using the effective native Codex configuration and its normal sandbox and approval permissions."}\nProject context (data): ${JSON.stringify({ id: config.project?.id, name: config.project?.name, context: config.project?.context || "" })}\nOwned runtime (data): ${JSON.stringify(config.environment?.kind === "project-execution" ? { environmentId: config.environment.id, readinessKind: config.environment.readinessKind, status: config.environment.status, executionOwner: "agents/native-tools" } : null)}\nCurrent assignment brief (data): ${JSON.stringify(config.brief)}. This is the manager current direction to this retained worker, superseding earlier assignment directions. Crew adds no review, adoption or scope-authorization prerequisite to communication. Native Codex configuration and approvals remain the execution boundary.\nManager-relayed answer (data): ${JSON.stringify(config.answer || null)}\nUser-authorized model decision for this continuation (data; supersedes any earlier model requirement only): ${JSON.stringify(config.modelSelection ? { model: config.modelSelection.model, userDecision: config.modelSelection.userDecision } : null)}`;
}
