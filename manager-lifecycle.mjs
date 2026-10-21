// Project-local manager intent and active instructions. This never controls workers.
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { promptSnapshot } from './prompt-settings.mjs';

export async function createManagerLifecycle({ stateDir, projectId, bridge, prompts, onChange = () => {} }) {
  const file = join(stateDir, 'manager-lifecycle.json');
  let retained;
  try {
    retained = JSON.parse(await readFile(file, 'utf8'));
    if (retained.projectId !== projectId || !['running', 'stopped'].includes(retained.intent) || typeof retained.active?.text !== 'string' || typeof retained.active?.version !== 'string') throw new Error('Invalid manager lifecycle record. Preserve it and inspect this project’s settings.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (retained && promptSnapshot(retained.active.text).version !== retained.active.version) throw new Error('Manager instructions snapshot does not match its version. Preserve it and inspect this project’s settings.');
  retained ||= { projectId, intent: 'running', active: await prompts.snapshot('manager') };
  let state = retained.intent, error = null, transition = null, inFlight = 0, activated = false;
  bridge.setManagerPrompt(retained.active.text);
  const view = () => ({ state, error, activeVersion: activated && bridge.state().managerConnected !== false ? retained.active.version : null, retainedVersion: retained.active.version });
  const publish = () => onChange(view());
  const persist = async next => {
    await writeFile(`${file}.tmp`, JSON.stringify(next) + '\n', { mode: 0o600 });
    await rename(`${file}.tmp`, file); retained = next;
  };
  // Establish a durable snapshot before the first provider request.
  await persist(retained);
  async function run(work) {
    if (state !== 'running') throw new Error(state === 'stopped' ? 'Manager is stopped. Use Start manager to resume this conversation.' : 'Manager is unavailable while its lifecycle changes. Review Settings and retry.');
    inFlight++;
    try { const result = await work(); if (bridge.state().managerConnected) { activated = true; publish(); } return result; } finally { inFlight--; }
  }
  async function prepare() {
    return run(async () => {
      const account = await bridge.prepare();
      try { await bridge.ensureThread(); } catch (failure) { throw Object.assign(failure, { account }); }
      activated = true; publish();
      return { ...account, state: bridge.state(), managerLifecycle: view() };
    });
  }
  function request(action) {
    if (!['start', 'stop', 'restart'].includes(action)) return Promise.reject(new Error('Choose Start, Stop or Restart manager.'));
    if (transition) {
      if (transition.action === action) return transition.promise;
      return Promise.reject(new Error('A manager lifecycle action is already in progress. Wait for its result.'));
    }
    if (action === 'start' && state === 'running') return Promise.resolve({ managerLifecycle: view() });
    if (action === 'stop' && state === 'stopped') return Promise.resolve({ managerLifecycle: view() });
    state = action === 'start' ? 'starting' : action === 'restart' ? 'restarting' : 'stopping'; error = null; publish();
    const promise = (async () => {
      try {
        // A crash during transition leaves the manager held, never auto-resumed.
        await persist({ ...retained, intent: 'stopped' });
        await bridge.stopVoice({ preserveWork: true });
        const deadline = Date.now() + 12000;
        while (inFlight) {
          if (Date.now() > deadline) throw new Error('A manager request is still settling. Wait, then retry Stop or Restart manager.');
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        await bridge.stopManager();
        activated = false;
        if (action === 'stop') { state = 'stopped'; publish(); return { managerLifecycle: view() }; }
        const active = await prompts.snapshot('manager');
        bridge.setManagerPrompt(active.text);
        await bridge.prepare(); await bridge.ensureThread();
        // Only confirmed native thread activation advances the active version.
        await persist({ projectId, intent: 'running', active });
        activated = true; state = 'running'; publish();
        return { managerLifecycle: view(), state: bridge.state() };
      } catch (failure) {
        state = 'error'; error = String(failure.message || failure); publish(); throw failure;
      } finally { transition = null; }
    })();
    transition = { action, promise };
    return promise;
  }
  return { view, run, prepare, request };
}
