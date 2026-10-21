// AI-017: read-only update safety observations. Never reconcile or signal runners.
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { snapshotProcesses } from './process-ownership.mjs';

const taskId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const identity = value => value && Number.isSafeInteger(value.pid) && value.pid > 1 && typeof value.start === 'string' && value.start.length > 0 && value.start.length < 160 && /^[a-f0-9]{64}$/i.test(value.commandHash || '');
const live = row => row && typeof row.state === 'string' && !row.state.includes('Z');

function observed(records, processes) {
  if (!Array.isArray(records) || records.length > 4096) return 'unknown';
  let uncertain = false;
  for (const expected of records) {
    if (!identity(expected)) { uncertain = true; continue; }
    const current = processes.get(expected.pid);
    if (!current) continue;
    if (!identity(current) || typeof current.state !== 'string') { uncertain = true; continue; }
    if (!live(current)) continue;
    if (current.start !== expected.start) continue; // PID reuse proves this recorded process is gone.
    if (current.commandHash === expected.commandHash) return 'live';
    uncertain = true; // Same-start executable changes are not verified ownership.
  }
  return uncertain ? 'unknown' : 'absent';
}
function verdict({ records, terminal, processes, contradictory = false }) {
  if (!(processes instanceof Map)) return 'unknown';
  const current = observed(records, processes);
  if (current === 'live') return 'live';
  if (current === 'unknown' || contradictory) return 'unknown';
  return terminal ? 'stopped' : 'unknown';
}
function sameDirectory(saved, expected) { return saved === undefined || saved === null || typeof saved === 'string' && path.resolve(saved) === expected; }

export async function inspectUpdateEvidence({ stateDir, view, processes } = {}) {
  const cloned = structuredClone(view);
  if (!cloned || !Array.isArray(cloned.tasks)) return cloned;
  let root, rows;
  try { root = await realpath(path.resolve(stateDir)); rows = processes === undefined ? await snapshotProcesses() : typeof processes === 'function' ? await processes() : processes; }
  catch { rows = null; }
  let reads = 0;
  async function json(...parts) {
    if (!root || ++reads > 4096) throw new Error('Evidence unavailable');
    const target = path.join(root, ...parts);
    let file;
    try {
      // Derive every path; reject linked parent directories and final files.
      if (await realpath(path.dirname(target)) !== path.dirname(target)) throw new Error('Linked evidence directory');
      file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 262144) throw new Error('Unbounded evidence');
      const bytes = await file.readFile();
      if (bytes.length > 262144) throw new Error('Unbounded evidence');
      const value = JSON.parse(bytes.toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed evidence');
      return value;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    finally { await file?.close(); }
  }
  async function worker(task) {
    if (!(rows instanceof Map)) return 'unknown';
    const unstarted = !task.harnessStarted && !task.spawnIntentAt;
    if (!uuid(task.runId)) return unstarted && !task.runDir && task.execution?.live !== true ? 'absent' : 'unknown';
    const expected = path.resolve(stateDir, 'runs', task.id, task.runId);
    if (!sameDirectory(task.runDir, expected)) return 'unknown';
    const location = ['runs', task.id, task.runId];
    const [owner, started, ownership, exit] = await Promise.all(['owner.json', 'started.json', 'ownership.json', 'exit.json'].map(name => json(...location, name)));
    if ([owner, started, ownership, exit].some(item => item && item.runId !== task.runId)) return 'unknown';
    if (unstarted && !owner && !started && !ownership && !exit && task.execution?.live !== true) return 'absent';
    const records = [...(ownership?.records || []), ...(exit?.ownership?.tracked || [])];
    if (owner?.supervisorIdentity) records.push(owner.supervisorIdentity);
    else if (started?.identity) records.push(started.identity);
    // Legacy started.json has only a PID: a live process with no captured
    // identity is uncertain, never grounds for claiming it stopped.
    const pid = owner?.supervisorPid || started?.pid || task.runnerPid;
    const uncaptured = Number.isSafeInteger(pid) && live(rows.get(pid)) && !records.some(record => record.pid === pid);
    return verdict({ records, terminal: exit?.stopConfirmed === true, processes: rows, contradictory: uncaptured || Boolean(exit?.ownership?.remaining?.length) });
  }
  async function environment(task) {
    const disk = await json('runs', task.id, 'environment.json');
    if (!disk && !task.environment) return { hooks: [], runtime: 'absent' };
    if (!disk || !task.environment || disk.taskId !== task.id || disk.id !== task.environment.id || disk.kind !== task.environment.kind || typeof disk.worktree !== 'string' || !path.isAbsolute(disk.worktree) || disk.worktree !== task.worktree || disk.worktree !== task.environment.worktree) throw new Error('Environment identity mismatch');
    const project = disk.kind === 'project-execution';
    if (project ? !/^crew-[a-f0-9]{32}$/.test(disk.id || '') : disk.kind !== undefined || typeof disk.id !== 'string' || !disk.id.startsWith(`crew-${task.id}-`) || !/^[a-f0-9]{8}$/.test(disk.id.slice(`crew-${task.id}-`.length))) throw new Error('Environment identity mismatch');
    if (!Array.isArray(disk.hooks) || disk.hooks.length > 128) throw new Error('Environment evidence exceeds limits');
    const hooks = [];
    for (const hook of disk.hooks) {
      const entry = { id: hook?.id ?? null, phase: hook?.phase ?? null, state: 'unknown' };
      hooks.push(entry);
      if (!uuid(hook?.id) || typeof hook.phase !== 'string' || hook.phase.length > 80) continue;
      const expected = path.resolve(stateDir, 'runs', task.id, 'environment', hook.id);
      if (!sameDirectory(hook.runDir, expected)) continue;
      const location = ['runs', task.id, 'environment', hook.id];
      try {
        const [started, ownership, exit] = await Promise.all(['started.json', 'ownership.json', 'exit.json'].map(name => json(...location, name)));
        if ([started, ownership, exit].some(item => item && item.id !== hook.id)) continue;
        const records = [...(ownership?.records || [])];
        if (started?.supervisorIdentity) records.push(started.supervisorIdentity);
        const pid = started?.supervisorPid || hook.supervisorPid;
        const uncaptured = Number.isSafeInteger(pid) && live(rows?.get?.(pid)) && !records.some(record => record.pid === pid);
        entry.state = verdict({ records, terminal: exit?.confirmed === true, processes: rows, contradictory: uncaptured || Boolean(exit?.remaining?.length) });
        if (!started && !ownership && !exit && hook.status === 'pending') entry.state = 'pending';
      } catch { /* This hook remains unknown; inspect independent hooks too. */ }
    }
    if (!disk.runtime) return { hooks, runtime: 'absent' };
    const runtime = disk.runtime;
    if (!project || !uuid(runtime.id) || !sameDirectory(runtime.runDir, path.resolve(stateDir, 'runs', task.id, 'project-runtime', runtime.id))) return { hooks, runtime: 'unknown' };
    const location = ['runs', task.id, 'project-runtime', runtime.id];
    const [started, ownership, exit] = await Promise.all(['started.json', 'ownership.json', 'exit.json'].map(name => json(...location, name)));
    if ([started, ownership, exit].some(item => item && item.id !== runtime.id) || [started, exit].some(item => item && item.environmentId !== disk.id)) return { hooks, runtime: 'unknown' };
    const records = [...(ownership?.records || [])];
    if (started?.identity) records.push(started.identity);
    const uncaptured = Number.isSafeInteger(started?.pid) && live(rows?.get?.(started.pid)) && !records.some(record => record.pid === started.pid);
    return { hooks, runtime: verdict({ records, terminal: exit?.stopConfirmed === true, processes: rows, contradictory: uncaptured || Boolean(exit?.remaining?.length) }) };
  }
  for (const [index, task] of cloned.tasks.entries()) {
    task.updateEvidence = { worker: 'unknown', hooks: [], runtime: 'unknown' };
    if (index >= 256 || !taskId(task.id)) continue;
    try { task.updateEvidence.worker = await worker(task); } catch { /* Fail closed. */ }
    try { Object.assign(task.updateEvidence, await environment(task)); } catch { /* Fail closed. */ }
  }
  return cloned;
}
