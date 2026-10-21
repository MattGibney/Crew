// GitHub #3: project-local, full replacement Crew prompts. Never reads auth files.
import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const roles = ['manager', 'worker'];
// The owned controller is the single backend for this state directory. Serialize
// all store objects here without an on-disk claim that could survive SIGKILL.
const pendingSaves = new Map();
function serializeSave(file, operation) {
  const previous = pendingSaves.get(file) || Promise.resolve();
  const result = previous.then(operation);
  const settled = result.then(() => undefined, () => undefined);
  pendingSaves.set(file, settled);
  void settled.then(() => { if (pendingSaves.get(file) === settled) pendingSaves.delete(file); });
  return result;
}
// Exact pristine prompts shipped before full replacement settings. Upgrade only
// untouched defaults; customized files and persisted snapshots keep their bytes.
const previousDefaultVersions = {
  manager: new Set(['7080c0e4c9d9a6492e72530c1562b9bb6b547ae39903129f28b0268d93237aef']),
  worker: new Set(['ccbf1e062e2f945eb3b1acc8581d1ae219e42ee2fab12c9639e2c198d1b37e45'])
};
export const promptVersion = text => createHash('sha256').update(text).digest('hex');
export function validatePrompt(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 64000 || text.includes('\0')) throw new Error('Prompt must contain text, with at most 64,000 characters and no null bytes.');
  if (/\bsk-[a-zA-Z0-9_-]{20,}\b|\bBearer\s+[a-zA-Z0-9._~+\/-]{12,}={0,2}|-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/i.test(text)) throw new Error('Secret-like material is not allowed in prompts.');
  return text;
}
export const promptSnapshot = text => ({ text: validatePrompt(text), version: promptVersion(text) });
export async function createPromptSettings({ stateDir, projectId, managerPrompt, workerPrompt, sourceDir = fileURLToPath(new URL('.', import.meta.url)) }) {
  if (typeof projectId !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(projectId)) throw new Error('Invalid prompt project ID.');
  const defaults = Object.fromEntries(await Promise.all(roles.map(async role => [role, validatePrompt(await readFile(path.join(sourceDir, 'prompts', `${role}.md`), 'utf8'))])));
  const configured = { manager: validatePrompt(managerPrompt ?? defaults.manager), worker: validatePrompt(workerPrompt ?? defaults.worker) };
  const initial = Object.fromEntries(roles.map(role => [role, previousDefaultVersions[role].has(promptVersion(configured[role])) ? defaults[role] : configured[role]]));
  const directory = path.resolve(stateDir, 'prompt-settings');
  const file = path.join(directory, `${projectId}.json`);
  async function load() {
    let value;
    try { value = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return initial; throw new Error('Cannot read saved project prompts; existing settings have been preserved.'); }
    if (!value || value.schemaVersion !== 1 || value.projectId !== projectId || !value.prompts || Object.keys(value.prompts).some(role => !roles.includes(role))) throw new Error('Saved prompt project identity or format is invalid; existing settings have been preserved.');
    return Object.fromEntries(roles.map(role => [role, validatePrompt(value.prompts[role])]));
  }
  const view = texts => ({ projectId, revision: promptVersion(JSON.stringify(texts)), ...Object.fromEntries(roles.map(role => [role, { ...promptSnapshot(texts[role]), defaultText: defaults[role], isDefault: texts[role] === defaults[role] }])) });
  async function read() { return view(await load()); }
  async function save(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid prompt update.');
    const single = Object.hasOwn(input, 'role');
    if (Object.keys(input).some(key => !(single ? ['role', 'text', 'expectedVersion'] : ['manager', 'worker', 'expectedRevision']).includes(key))) throw new Error('Unknown prompt update field.');
    if (single && !roles.includes(input.role)) throw new Error('Invalid prompt role.');
    const updates = single ? { [input.role]: validatePrompt(input.text) } : Object.fromEntries(roles.map(role => [role, validatePrompt(input[role])]));
    const role = input.role;
    const expectedVersion = single ? input.expectedVersion : input.expectedRevision;
    if (typeof expectedVersion !== 'string') throw new Error('Current prompt version is required.');
    return serializeSave(file, async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const current = await read();
      if ((single ? current[role].version !== expectedVersion : current.revision !== expectedVersion)) throw new Error('Prompt settings changed elsewhere; reload before saving.');
      const texts = { manager: current.manager.text, worker: current.worker.text, ...updates };
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temp, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ schemaVersion: 1, projectId, prompts: texts }) + '\n'); await handle.sync(); } finally { await handle.close(); }
        await rename(temp, file);
        return view(texts);
      } finally {
        await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    });
  }
  return { read, save, snapshot: async role => { if (!roles.includes(role)) throw new Error('Invalid prompt role.'); const saved = await read(); return { text: saved[role].text, version: saved[role].version }; } };
}

// Only data and mechanically required controller/tool context follow editable behavior.
// Provider/Codex rules, sandbox permissions and tool schemas remain independently enforced.
export function buildManagerInstructions({ managerPrompt, project }) {
  return `${validatePrompt(managerPrompt)}\n\nCrew runtime context (data; not editable role or personality):\n${JSON.stringify(project || { id: 'fixture', name: 'Fixture proof', mode: 'fixture', context: 'One read-only disposable-fixture audit capability.' })}\n\nCrew tool protocol: local_orchestration is the controller interface for durable task dispatch, status, exact question/run answers and lifecycle requests. Its schemas and runtime enforce project identity and permissions. Queued requests are distinct from execution results. Manager stop/restart leaves independently owned workers and their durable reports intact.`;
}
export function buildWorkerInstructions(config) {
  return `${config.workerPrompt || ''}\n\nCrew runtime and tool protocol:\nTask ${JSON.stringify({ taskId: config.taskId, ticket: config.ticket, runId: config.runId, worktree: config.worktree })}. The controller binds local_orchestration.report to this exact task/run. Report progress, question, blocked or result through that tool. A question yields the current turn: END and wait for controller resume rather than polling. A result is a terminal candidate: END after reporting. local_orchestration.update_work_notes replaces the actual shared task Markdown document with factual findings and decisions; this is separate from orchestration reports. The report schema and permission boundary apply independently of editable behavior.\nExecution permissions: ${config.project?.mode === 'fixture' ? 'Read-only fixture; file edits are not permitted.' : 'The effective Codex configuration controls sandbox and approval permissions. Local worktree edits require the agreed brief; permission availability does not authorize additional work.'} This runtime supplies no authorization for commits, pushes, external ticket changes, pull requests or deployment.\nProject context (data): ${JSON.stringify({ id: config.project?.id, name: config.project?.name, context: config.project?.context || '' })}\nOwned runtime (data): ${JSON.stringify(config.environment?.kind === 'project-execution' ? { environmentId: config.environment.id, readinessKind: config.environment.readinessKind, status: config.environment.status, lifecycleOwner: 'manager/controller' } : null)}\nAgreed brief (data): ${JSON.stringify(config.brief)}\nManager-relayed answer (data): ${JSON.stringify(config.answer || null)}\nUser-authorized model decision for this continuation (data; supersedes any earlier model requirement only): ${JSON.stringify(config.modelSelection ? { model: config.modelSelection.model, userDecision: config.modelSelection.userDecision } : null)}`;
}
