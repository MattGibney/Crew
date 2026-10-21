import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPromptSettings, promptVersion, buildManagerInstructions, buildWorkerInstructions } from '../prompt-settings.mjs';
const settings = async (options = {}) => createPromptSettings({ stateDir: await mkdtemp(path.join(os.tmpdir(), 'crew-prompts-')), projectId: 'example', ...options });
test('initial editors show complete defaults and save replaces them durably without rewriting configured files', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'crew-prompts-'));
  const store = await settings({ stateDir }); const before = await store.read();
  assert.equal(before.manager.text, before.manager.defaultText);
  assert.match(before.manager.text, /sole conversational contact/);
  const saved = await store.save({ role: 'manager', text: 'Custom Crew behavior only.', expectedVersion: before.manager.version });
  assert.equal(saved.manager.text, 'Custom Crew behavior only.'); assert.equal(saved.manager.isDefault, false);
  assert.equal(saved.worker.version, before.worker.version);
  assert.deepEqual(await (await settings({ stateDir })).read(), saved);
  assert.equal((await stat(path.join(stateDir, 'prompt-settings', 'example.json'))).mode & 0o777, 0o600);
  const reset = await store.save({ role: 'manager', text: saved.manager.defaultText, expectedVersion: saved.manager.version });
  assert.equal(reset.manager.isDefault, true);
});
test('configured custom text is initially preserved, with isolated project saves and stale-save rejection', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'crew-prompts-'));
  const first = await settings({ stateDir, managerPrompt: 'Retained custom manager', workerPrompt: 'Retained custom worker' });
  const second = await settings({ stateDir, projectId: 'other' });
  const initial = await first.read(); const other = await second.read();
  assert.equal(initial.manager.text, 'Retained custom manager');
  const saved = await first.save({ role: 'worker', text: 'New workers only', expectedVersion: initial.worker.version });
  await assert.rejects(first.save({ role: 'worker', text: 'Stale edit', expectedVersion: initial.worker.version }), /changed elsewhere/);
  assert.equal((await first.read()).worker.text, 'New workers only');
  assert.deepEqual(await second.read(), other);
  assert.equal((await first.snapshot('worker')).version, saved.worker.version);
});
test('invalid and secret-like saves preserve previous settings; malformed saved identity fails closed', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'crew-prompts-')); const store = await settings({ stateDir }); const initial = await store.read();
  for (const text of ['', ' \n', 'x'.repeat(64001), 'null\0byte', 'Bearer abcdefghijklmnopqrstuvwxyz', '-----BEGIN PRIVATE KEY-----']) await assert.rejects(store.save({ role: 'manager', text, expectedVersion: initial.manager.version }));
  await assert.rejects(store.save({ role: 'manager', text: 'Allowed' }), /version/);
  await assert.rejects(store.save({ role: '../other', text: 'Allowed', expectedVersion: initial.manager.version }), /role/);
  assert.deepEqual(await store.read(), initial);
  await store.save({ role: 'manager', text: 'Saved', expectedVersion: initial.manager.version });
  const file = path.join(stateDir, 'prompt-settings', 'example.json');
  const content = JSON.parse(await readFile(file, 'utf8')); content.projectId = 'other'; await writeFile(file, JSON.stringify(content));
  await assert.rejects(store.read(), /identity/);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).projectId, 'other');
});
test('custom behavior fully replaces Crew defaults in actual instruction builders', () => {
  const manager = buildManagerInstructions({ managerPrompt: 'MANAGER_REPLACEMENT', project: { id: 'example', context: 'Fact' } });
  assert.ok(manager.startsWith('MANAGER_REPLACEMENT\n'));
  assert.doesNotMatch(manager, /technical lead|Be concise|spoken progress|Invariant manager role|Never choose backlog/);
  assert.match(manager, /Crew runtime context/); assert.match(manager, /exact question\/run/);
  const worker = buildWorkerInstructions({ workerPrompt: 'WORKER_REPLACEMENT', project: { id: 'example' }, taskId: 'example-task', runId: 'run', worktree:'/retained/worktree', sandbox: 'workspace-write', brief: 'Implement agreed scope' });
  assert.ok(worker.startsWith('WORKER_REPLACEMENT\n'));
  assert.doesNotMatch(worker, /You are the ONE|Give one useful progress|Investigate whether|Inspect actual files|technical lead/);
  assert.match(worker, /local_orchestration.report/); assert.match(worker, /workspace|worktree/);
  assert.match(worker,/effective native Codex configuration and its normal sandbox and approval/);
  assert.doesNotMatch(worker,/Read-only sandbox/);
  assert.match(buildWorkerInstructions({project:{mode:'fixture'},sandbox:'workspace-write'}),/native read-only sandbox/);
  assert.equal(promptVersion('same'), promptVersion('same'));
});

test('only exact pristine shipped prompts upgrade to complete defaults; customized bytes and saved histories remain unchanged', async () => {
  const old = JSON.parse(await readFile(new URL('./fixtures/prompts-before-settings.json', import.meta.url), 'utf8'));
  const store = await settings({ managerPrompt: old.manager, workerPrompt: old.worker });
  const upgraded = await store.read();
  assert.equal(upgraded.manager.text, upgraded.manager.defaultText);
  assert.equal(upgraded.worker.text, upgraded.worker.defaultText);
  assert.match(upgraded.manager.text, /greet once in English/);
  const customized = await (await settings({ managerPrompt: old.manager + '\nCustom preference.', workerPrompt: old.worker + '\nCustom preference.' })).read();
  assert.equal(customized.manager.text, old.manager + '\nCustom preference.');
  assert.equal(customized.worker.text, old.worker + '\nCustom preference.');
  const saved = await store.save({ role: 'manager', text: old.manager, expectedVersion: upgraded.manager.version });
  assert.equal(saved.manager.text, old.manager);
  assert.equal((await store.read()).manager.text, old.manager);
});

test('concurrent store saves serialize version checks and abandoned atomic files cannot block restart', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'crew-prompts-'));
  const first = await settings({ stateDir }), second = await settings({ stateDir });
  const initial = await first.read();
  const attempts = await Promise.allSettled([
    first.save({ role: 'manager', text: 'First concurrent edit', expectedVersion: initial.manager.version }),
    second.save({ role: 'manager', text: 'Second concurrent edit', expectedVersion: initial.manager.version })
  ]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = attempts.find(result => result.status === 'rejected');
  assert.match(rejected.reason.message, /changed elsewhere/);
  const saved = await first.read();
  assert.equal(saved.manager.text, attempts.find(result => result.status === 'fulfilled').value.manager.text);
  const directory = path.join(stateDir, 'prompt-settings');
  const abandoned = path.join(directory, 'example.json.00000000-abandoned.tmp');
  await writeFile(abandoned, '{"incomplete"', { mode: 0o600 });
  // An old-version empty claim is inert too; never delete an unexplained file.
  await writeFile(path.join(directory, 'example.json.lock'), '', { mode: 0o600 });
  const restarted = await settings({ stateDir });
  const updated = await restarted.save({ role: 'manager', text: 'Saved after restart', expectedVersion: saved.manager.version });
  assert.equal(updated.manager.text, 'Saved after restart');
  assert.equal(await readFile(abandoned, 'utf8'), '{"incomplete"');
  assert.deepEqual((await readdir(directory)).sort(), ['example.json', 'example.json.00000000-abandoned.tmp', 'example.json.lock']);
});

test('runtime protocol names explicit workflow and environment context without forcing report termination',()=>{
 const worker=buildWorkerInstructions({workerPrompt:'Project behavior',project:{id:'example'},taskId:'worker-test',runId:'run-test',brief:'Continue implementation'});
 assert.match(worker,/set_workflow_state/);assert.match(worker,/get_project_environment/);assert.match(worker,/Reports are messages/);assert.doesNotMatch(worker,/END after reporting|END and wait|must.*commit|never.*pull request/i);
 const manager=buildManagerInstructions({managerPrompt:'Project manager behavior',project:{id:'example'}});assert.match(manager,/set_workflow_state/);assert.match(manager,/does not run setup, Start or readiness/);
});

test('default manager owns ordinary delegation and supervision while cleanup and native approvals remain explicit',async()=>{
 const manager=await readFile(new URL('../prompts/manager.md',import.meta.url),'utf8'),worker=await readFile(new URL('../prompts/worker.md',import.meta.url),'utf8');
 assert.match(manager,/Own delegation, supervision/);assert.match(manager,/ordinary delegation, start and resume do not need a separate human lifecycle instruction/);assert.match(manager,/Destructive teardown, archive cleanup/);
 assert.doesNotMatch(manager,/only for the user's requested lifecycle action|Before repository dispatch.*verify|If project readiness is false/);
 assert.doesNotMatch(worker,/even if the brief requests|do not commit, push|end your turn; resume only/);assert.match(worker,/set_workflow_state/);assert.match(worker,/normal native tools and approvals/);
});
