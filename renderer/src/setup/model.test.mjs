import test from 'node:test';
import assert from 'node:assert/strict';
import { collectConfig, environmentChoices } from './model.ts';

function fixture() {
  const source = { path: '.codex/environments/environment.toml', sha256: 'a'.repeat(64) };
  const action = command => ({ command, source, timeoutMs: 600000 });
  const discovered = { schemaVersion: 1, sources: [source], setup: action('./tools/dev up --skip-tests'), start: action('EXACT=1 project start\n'), resume: action('EXACT=1 project start\n'), ready: null, stop: null, teardown: null, networkAccess: true, permissionsSource: { path: '/canonical/project/.codex/config.toml', sha256: 'b'.repeat(64) } };
  const saved = { ...structuredClone(discovered), setup: { ...action('old setup'), timeoutMs: 200000 }, env: { PATH: '/pinned/npm:/pinned/node:/usr/bin' }, ready: action('existing local readiness'), stop: action('existing graceful stop'), teardown: action('./tools/dev down'), customSetting: { preserve: true } };
  const config = { runtime: { codexBinary: null, port: 4330, dataDir: '.data', extra: 'retain' }, project: { id: 'set1', name: 'Example Product', context: 'Existing project scope.', mode: 'repository', repositories: [{ id: 'product', name: 'SampleApp', path: '/canonical/project', baseRef: 'refs/heads/main', components: ['api'] }], linear: { teamKey: null, teamId: null, projectId: null }, prompts: { manager: 'prompts/manager.md', worker: 'prompts/worker.md' }, worker: { maxConcurrent: 2, sandbox: 'read-only', environment: { executionPlan: saved } } } };
  const snapshot = { config: structuredClone(config), workerEnvironmentOptions: [{ status: 'available', plan: discovered, actions: [{ name: 'Start', ...discovered.start }, { name: 'Alternative', ...action('alternative command --literal') }] }] };
  return { config, snapshot, discovered, saved, action };
}

test('saving discovered execution preserves exact source commands and local runtime choices', () => {
  const { config, snapshot, discovered, saved } = fixture();
  const original = structuredClone(config);
  const next = collectConfig(config, snapshot, 'project');
  const plan = next.project.worker.environment.executionPlan;
  assert.equal(plan.setup.command, discovered.setup.command);
  assert.equal(plan.start.command, discovered.start.command);
  assert.deepEqual(plan.setup.source, discovered.setup.source);
  assert.deepEqual(plan.sources, discovered.sources);
  assert.deepEqual(plan.permissionsSource, discovered.permissionsSource);
  assert.equal(plan.networkAccess, true);
  assert.equal(plan.setup.timeoutMs, saved.setup.timeoutMs);
  for (const key of ['env', 'ready', 'stop', 'teardown', 'customSetting']) assert.deepEqual(plan[key], saved[key]);
  assert.equal(next.project.worker.sandbox, 'read-only');
  assert.equal(next.runtime.extra, 'retain');
  assert.deepEqual(next.project.repositories, original.project.repositories);
  assert.deepEqual(config, original, 'collecting does not mutate the editable draft');
});

test('a selected declared action keeps its provenance and resumes that exact command', () => {
  const { config, snapshot } = fixture();
  const plan = collectConfig(config, snapshot, 'action:1').project.worker.environment.executionPlan;
  const selected = snapshot.workerEnvironmentOptions[0].actions[1];
  assert.equal(plan.start.command, selected.command);
  assert.deepEqual(plan.start.source, selected.source);
  assert.equal(plan.resume.command, selected.command);
  assert.deepEqual(plan.teardown, config.project.worker.environment.executionPlan.teardown);
});

test('independently customized resume instructions survive refreshing project sources', () => {
  const { config, snapshot, action } = fixture();
  const resume = action('existing explicit resume --without-reseed');
  config.project.worker.environment.executionPlan.resume = resume;
  snapshot.config = structuredClone(config);
  assert.deepEqual(collectConfig(config, snapshot, 'project').project.worker.environment.executionPlan.resume, resume);
});

test('custom environment hooks and unavailable saved execution settings stay untouched', () => {
  const { config, snapshot } = fixture();
  config.project.worker.environment = { hooks: { start: { command: 'existing hook', args: ['literal argument'] } }, extra: true };
  snapshot.config = structuredClone(config);
  assert.equal(environmentChoices(snapshot).selected, 'custom');
  assert.deepEqual(collectConfig(config, snapshot, 'custom').project.worker.environment, config.project.worker.environment);
  const saved = fixture();
  saved.snapshot.workerEnvironmentOptions = [{ status: 'unavailable', detail: 'Instructions unavailable.' }];
  assert.equal(environmentChoices(saved.snapshot).selected, 'custom');
  assert.deepEqual(collectConfig(saved.config, saved.snapshot, 'custom').project.worker.environment, saved.config.project.worker.environment);
});

test('missing execution action is rejected rather than saving guessed startup instructions', () => {
  const { config, snapshot } = fixture();
  for (const selection of ['action:9', 'action:NaN', 'action:-1']) assert.throws(() => collectConfig(config, snapshot, selection), /options changed/);
  snapshot.workerEnvironmentOptions = [];
  assert.throws(() => collectConfig(config, snapshot, 'project'), /options changed/);
});

test('deferred Linear remains null and separate-worktree/fixture choices are explicit', () => {
  const { config, snapshot } = fixture();
  assert.deepEqual(collectConfig(config, snapshot, 'project').project.linear, { teamKey: null, teamId: null, projectId: null });
  config.project.linear = { teamKey: ' ', teamId: '', projectId: null };
  assert.deepEqual(collectConfig(config, snapshot, 'none').project.linear, { teamKey: null, teamId: null, projectId: null });
  assert.deepEqual(collectConfig(config, snapshot, 'none').project.worker.environment, {});
  config.project.mode = 'fixture';
  assert.deepEqual(collectConfig(config, snapshot, 'none').project.repositories, []);
});

test('an emptied worker limit remains an invalid user value for backend validation', () => {
  const { config, snapshot } = fixture();
  config.project.worker.maxConcurrent = '';
  assert.equal(collectConfig(config, snapshot, 'none').project.worker.maxConcurrent, 0);
});
