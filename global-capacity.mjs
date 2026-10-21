// Issue #2: one durable admission ledger for all local project controllers.
import { readFile, open, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadTasks, withStateLock } from './orchestration-store.mjs';
const now = () => new Date().toISOString();
async function json(file) { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
const limitValue = value => { if (!Number.isInteger(value) || value < 1 || value > 64) throw new Error('Global worker limit must be an integer between 1 and 64.'); return value; };
async function transaction(dir, fn) {
  if (!path.isAbsolute(dir)) throw new Error('Global capacity directory must be absolute.');
  return withStateLock(dir, '.capacity.lock', async () => {
    const file = path.join(dir, 'capacity.json');
    const state = await json(file) || { version: 1, limit: 2, admissionPaused: false, stateDirs: [], claims: [] };
    if (state.version !== 1 || !Array.isArray(state.claims) || !Array.isArray(state.stateDirs)) throw new Error('Global capacity state is invalid; preserve it for recovery.');
    if(state.stateDirs.some(value=>typeof value!=='string'||!path.isAbsolute(value))||state.claims.some(claim=>!claim||typeof claim.stateDir!=='string'||!path.isAbsolute(claim.stateDir)||typeof claim.taskId!=='string'||(claim.runId!==null&&typeof claim.runId!=='string')))throw new Error('Global capacity claims are invalid; preserve them for recovery.');
    limitValue(state.limit);
    if(state.admissionPaused!==undefined&&typeof state.admissionPaused!=='boolean')throw new Error('Global admission pause state is invalid; preserve it for recovery.');
    const result = await fn(state);
    const temp = `${file}.${randomUUID()}.tmp`;
    const handle=await open(temp,'wx',0o600);try{await handle.writeFile(JSON.stringify(state,null,2)+'\n');await handle.sync();}finally{await handle.close();}await rename(temp,file);
    return result;
  });
}
function register(state, stateDir) {
  if (!path.isAbsolute(stateDir)) throw new Error('Project orchestration state directory must be absolute.');
  stateDir = path.resolve(stateDir);
  if (!state.stateDirs.includes(stateDir)) state.stateDirs.push(stateDir);
}
export async function configureGlobalCapacity({ dir, limit, stateDirs = [], admissionPaused }) {
  return transaction(dir, state => { if (limit !== undefined) state.limit = limitValue(limit); if(admissionPaused!==undefined){if(typeof admissionPaused!=='boolean')throw new Error('Global admissionPaused must be boolean.');state.admissionPaused=admissionPaused;} stateDirs.forEach(value => register(state, value)); return { limit: state.limit, admissionPaused: state.admissionPaused===true, stateDirs: [...state.stateDirs] }; });
}
async function reconcile(state) {
  const tasks = new Map();
  // Scan every registered project before any admission. Missing/invalid task state
  // or unconfirmed process evidence never turns an occupied claim into free space.
  for (const stateDir of state.stateDirs) for (const task of await loadTasks(stateDir)) {
    const key = `${stateDir}\0${task.id}`; tasks.set(key, task);
    const exit = task.runDir ? await json(path.join(task.runDir, 'exit.json')) : null;
    const terminal = Boolean(exit && exit.runId === task.runId && exit.stopConfirmed === true);
    const active = task.harnessStarted && !terminal || task.status === 'launching';
    if (active && !state.claims.some(claim => claim.stateDir === stateDir && claim.taskId === task.id && claim.runId === task.runId)) state.claims.push({ stateDir, taskId: task.id, runId: task.runId || null, at: now(), recovered: true });
  }
  const retained = [];
  for (const claim of state.claims) {
    const task = tasks.get(`${claim.stateDir}\0${claim.taskId}`);
    if (!task) { retained.push(claim); continue; }
    if (task.runId !== claim.runId) { retained.push(claim); continue; }
    const exit = task.runDir ? await json(path.join(task.runDir, 'exit.json')) : null;
    if (exit?.runId === claim.runId && exit.stopConfirmed === true) continue;
    // Explicit controller release handles preparation that never spawned a worker.
    retained.push(claim);
  }
  state.claims = retained;
}
export async function createGlobalCapacity({ dir, stateDir, limit }) {
  await configureGlobalCapacity({ dir, limit, stateDirs: [stateDir] });
  return {
    acquire: ({ taskId, runId }) => transaction(dir, async state => {
      await reconcile(state);
      const existing = state.claims.find(claim => claim.stateDir === stateDir && claim.taskId === taskId);
      if (existing) return { admitted: existing.runId === runId, limit: state.limit, occupied: state.claims.length };
      if(state.admissionPaused===true)return {admitted:false,limit:state.limit,occupied:state.claims.length,admissionPaused:true};
      if (state.claims.length >= state.limit) return { admitted: false, limit: state.limit, occupied: state.claims.length };
      state.claims.push({ stateDir, taskId, runId, at: now() });
      return { admitted: true, limit: state.limit, occupied: state.claims.length };
    }),
    // Caller may release ONLY after proving its preparation ended without a
    // spawned harness; normal worker slots are released by matching terminal data.
    releasePreparation: ({ taskId, runId }) => transaction(dir, state => { state.claims = state.claims.filter(claim => !(claim.stateDir === stateDir && claim.taskId === taskId && claim.runId === runId)); }),
    view: () => transaction(dir, async state => { await reconcile(state); return { limit: state.limit, occupied: state.claims.length, admissionPaused:state.admissionPaused===true }; })
  };
}
