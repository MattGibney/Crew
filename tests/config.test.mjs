// AI-006: config validation, portable initialization and package boundaries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, chmod, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appRoot, loadAppConfig } from '../config.mjs';
const exec = promisify(execFile);
const environments = [];
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ai006-config-')); environments.push(root);
  await mkdir(join(root, 'config')); await mkdir(join(root, 'prompts')); await mkdir(join(root, 'bin'));
  for (const template of ['fixture', 'set1']) await copyFile(join(appRoot, 'config', `${template}.example.json`), join(root, 'config', `${template}.example.json`));
  for (const role of ['manager', 'worker']) await copyFile(join(appRoot, 'prompts', `${role}.md`), join(root, 'prompts', `${role}.md`));
  const fakeCodex = join(root, 'bin', 'codex');
  await writeFile(fakeCodex, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.test"; exit 0; fi\nexit 1\n'); await chmod(fakeCodex, 0o700);
  const env = { ...process.env, AI_MANAGER_CONFIG: '', AI_MANAGER_CODEX_BINARY: fakeCodex, CODEX_BINARY: '', AI_MANAGER_PORT: '', VOICE_PORT: '' };
  const config = JSON.parse(await readFile(join(root, 'config', 'fixture.example.json'), 'utf8'));
  const configPath = join(root, 'config', 'local.json');
  const save = async value => writeFile(configPath, JSON.stringify(value));
  return { root, env, config, configPath, save, load: options => loadAppConfig({ root, env, ...options }) };
}
test.after(async () => { await Promise.all(environments.map(path => rm(path, { recursive: true, force: true }))); });
test('default is one fixture project with no registry or business worker and isolated state', async () => {
  const fixture = await setup();
  const value = await fixture.load();
  assert.equal(value.project.id, 'fixture'); assert.equal(value.activeProject, value.project); assert.equal(value.projects, undefined);
  assert.equal(value.project.readiness.ready, true); assert.equal(value.projectStateDir, join(fixture.root, '.data', 'orchestration'));
  assert.equal(value.managerStatePath, join(fixture.root, '.data', 'manager-chat.json'));
  assert.equal(value.serverStatePath, join(fixture.root, '.data', 'server.json'));
  assert.equal(value.configPath, null); assert.equal(value.legacyState, false);
  assert.match(value.managerPrompt, /sole conversational contact/); assert.match(value.workerPrompt, /do not commit/i);
});
test('legacy state remains only for absent local configuration and fixture', async () => {
  const fixture = await setup();
  await mkdir(join(fixture.root, '.orchestration')); await writeFile(join(fixture.root, '.voice-chat.json'), '{}');
  const legacy = await fixture.load(); assert.equal(legacy.legacyState, true); assert.equal(legacy.projectStateDir, join(fixture.root, '.orchestration'));
  await fixture.save(fixture.config);
  const configured = await fixture.load(); assert.equal(configured.legacyState, false); assert.equal(configured.projectStateDir, join(fixture.root, '.data', 'orchestration'));
});
test('unconfigured Set1 is a reviewable template, cannot become dispatch-ready by its name', async () => {
  const fixture = await setup();
  const value = await fixture.load({ configPath: join(fixture.root, 'config/set1.example.json') });
  assert.equal(value.project.id, 'set1'); assert.equal(value.project.readiness.ready, false);
  assert.equal(value.project.repositories[0].path, null); assert.equal(value.project.linear.teamId, null);
  assert.equal(value.project.readiness.issues.length, 4); assert.match(value.project.context, /DRAFT/);
});
test('repository readiness validates actual Git path and explicit commit ref', async () => {
  const fixture = await setup(), repository = join(fixture.root, 'business');
  await mkdir(repository);
  await exec('git', ['init', '-q', '-b', 'main', repository]);
  await exec('git', ['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'Fixture baseline']);
  const config = JSON.parse(await readFile(join(fixture.root, 'config/set1.example.json'), 'utf8'));
  config.project.repositories[0].path = '../business'; config.project.repositories[0].baseRef = 'main'; config.project.linear = { teamId: 'example-team-id', teamKey: 'EX', projectId: null };
  await fixture.save(config);
  const value = await fixture.load(); assert.equal(value.project.readiness.ready, true); assert.equal(value.project.repositories[0].path, repository);
  config.project.repositories[0].baseRef = 'missing-ref'; await fixture.save(config);
  assert.equal((await fixture.load()).project.readiness.ready, false);
});
test('unknown settings and invalid overrides fail with actionable errors', async () => {
  const fixture = await setup();
  fixture.config.projects = []; await fixture.save(fixture.config);
  await assert.rejects(fixture.load(), /Unknown root setting "projects"/); delete fixture.config.projects;
  fixture.config.runtime.apiKey = 'not-allowed'; await fixture.save(fixture.config);
  await assert.rejects(fixture.load(), /Unknown runtime setting "apiKey"/); delete fixture.config.runtime.apiKey;
  await fixture.save(fixture.config);
  await assert.rejects(fixture.load({ env: { ...fixture.env, AI_MANAGER_PORT: 'bad' } }), /runtime.port/);
  await assert.rejects(fixture.load({ configPath: join(fixture.root, 'missing.json') }), /File not found/);
  await assert.rejects(fixture.load({ env: { ...fixture.env, AI_MANAGER_CODEX_BINARY: join(fixture.root, 'no-codex') } }), /Cannot run configured Codex/);
});
test('worker permissions, prompt readability and state path are bounded', async () => {
  const fixture = await setup();
  fixture.config.project.worker.sandbox = 'workspace-write'; await fixture.save(fixture.config);
  await assert.rejects(fixture.load(), /Fixture workers must remain read-only/);
  fixture.config.project.worker.sandbox = 'read-only'; fixture.config.project.worker.timeoutMs = 1; await fixture.save(fixture.config);
  await assert.rejects(fixture.load(), /timeoutMs/);
  fixture.config.project.worker.timeoutMs = 300000; fixture.config.project.prompts.worker = 'absent.md'; await fixture.save(fixture.config);
  await assert.rejects(fixture.load(), /Cannot read worker prompt/);
  fixture.config.project.prompts.worker = '../prompts/worker.md'; fixture.config.runtime.dataDir = '/'; await fixture.save(fixture.config);
  await assert.rejects(fixture.load(), /dedicated state directory/);
});
test('init copies editable single-project instance files and refuses overwrites', async () => {
  const fixture = await setup(), destination = join(fixture.root, 'instance', 'manager.json');
  const result = await exec(process.execPath, [join(appRoot, 'cli.mjs'), 'init', '--template', 'set1', '--config', destination]);
  assert.match(result.stdout, /No work was launched/);
  const value = JSON.parse(await readFile(destination, 'utf8'));
  assert.equal(value.project.id, 'set1'); assert.equal(value.projects, undefined); assert.equal(value.runtime.dataDir, '.data');
  assert.equal(value.project.prompts.manager, 'prompts/manager.md'); await access(join(fixture.root, 'instance', 'prompts', 'manager.md'));
  await assert.rejects(exec(process.execPath, [join(appRoot, 'cli.mjs'), 'init', '--config', destination]), error => /Refusing to overwrite/.test(error.stderr));
});
test('source package contains only allowlisted code/templates; excludes live state and configuration', async () => {
  const fixture = await setup(), destination = join(fixture.root, 'deliverable.tar.gz');
  await exec(process.execPath, [join(appRoot, 'cli.mjs'), 'package', '--output', destination]);
  const { stdout } = await exec('tar', ['-tzf', destination]);
  const entries = stdout.trim().split('\n');
  assert.ok(entries.includes('config/set1.example.json')); assert.ok(entries.includes('server.mjs'));
  for (const file of ['manager-profile.mjs', 'renderer/src/manager/ManagerAvatar.jsx', 'renderer/src/manager/profile.js', 'scripts/manager-profile-native-acceptance.mjs']) assert.ok(entries.includes(file), `Missing manager profile source: ${file}`);
  for(const file of ['worker-worktree-evidence.mjs','tests/worker-followup.test.mjs','tests/worker-followup-store.test.mjs','scripts/worker-followup-native-acceptance.mjs'])assert.ok(entries.includes(file),`Missing retained-worker follow-up source: ${file}`);
  for(const file of ['worker-approvals.mjs','tests/worker-app-server.test.mjs','tests/worker-approvals.test.mjs','tests/worker-app-server.test.mjs','tests/worker-bootstrap.test.mjs','tests/helpers/worker-app-server-fixture.mjs'])assert.ok(entries.includes(file),`Missing worker protocol source: ${file}`);

  assert.ok(entries.includes('config/set1.example.json')); assert.ok(entries.includes('server.mjs')); assert.ok(entries.includes('conversation-timeline.mjs')); assert.ok(entries.includes('renderer/src/manager/Message.jsx')); assert.equal(entries.includes('renderer/src/manager/Transcript.jsx'), false);
  assert.equal(entries.some(path => /(^|\/)(\.orchestration|\.data|\.git|local.json|\.voice-chat.json|server.json)(\/|$)/.test(path)), false);
  assert.ok(entries.includes('docs/MACOS.md')); assert.ok(entries.includes('tests/config.test.mjs'));
});

test('worker concurrency defaults compatibly and accepts only bounded integers', async () => {
  const fixture = await setup();
  const initial = await fixture.load();
  assert.equal(initial.project.worker.maxConcurrent, 2);
  assert.deepEqual(initial.project.worker.environment, {});
  for (const valid of [1, 8]) {
    fixture.config.project.worker.maxConcurrent = valid; await fixture.save(fixture.config);
    assert.equal((await fixture.load()).project.worker.maxConcurrent, valid);
  }
  for (const invalid of [0, 9, 1.5, '2', null]) {
    fixture.config.project.worker.maxConcurrent = invalid; await fixture.save(fixture.config);
    await assert.rejects(fixture.load(), /project.worker.maxConcurrent/);
  }
});

test('configured environment hooks retain exact argv and do not invent missing hooks', async () => {
  const fixture = await setup();
  fixture.config.project.worker.environment = {
    bootstrap: { command:'npm', args:['ci'], timeoutMs:600000 },
    ready: { command:'node', args:['scripts/ready.mjs', '', 'literal;$(not-a-shell)'], timeoutMs:1000 }
  };
  await fixture.save(fixture.config);
  const loaded = await fixture.load();
  assert.deepEqual(loaded.project.worker.environment, fixture.config.project.worker.environment);
  assert.equal('start' in loaded.project.worker.environment, false);
  assert.equal(loaded.project.readiness.ready, true); // Project dispatch configuration, not application runtime readiness.
});

test('environment hook validation rejects unknown settings, unsafe shapes and unbounded values', async () => {
  const fixture = await setup();
  const valid = () => ({ command:'node', args:['check.mjs'], timeoutMs:1000 });
  for (const environment of [null, [], { shell:valid() }, { ready:null }, { ready:{ ...valid(), env:{ TOKEN:'never-accepted' } } }, { ready:{ ...valid(), shell:true } }, { ready:{ ...valid(), command:' ' } }, { ready:{ ...valid(), command:'node\0bad' } }, { ready:{ ...valid(), command:'x'.repeat(4097) } }, { ready:{ ...valid(), args:'check.mjs' } }, { ready:{ ...valid(), args:[1] } }, { ready:{ ...valid(), args:['bad\0value'] } }, { ready:{ ...valid(), args:Array(65).fill('x') } }, { ready:{ ...valid(), args:['x'.repeat(8193)] } }, { ready:{ ...valid(), timeoutMs:999 } }, { ready:{ ...valid(), timeoutMs:600001 } }, { ready:{ ...valid(), timeoutMs:1000.1 } }, { ready:{ command:'node', args:[] } }]) {
    fixture.config.project.worker.environment = environment; await fixture.save(fixture.config);
    await assert.rejects(fixture.load(), /project.worker.environment/);
  }
});

test('project execution plans retain exact scripts and require source provenance',async()=>{
 const fixture=await setup(),source={path:'.codex/environments/environment.toml',sha256:'a'.repeat(64)},plan={schemaVersion:1,sources:[source],setup:{command:'./existing setup\n',source,timeoutMs:600000},start:null,resume:null,ready:null,stop:null,teardown:null};
 fixture.config.project.worker.environment={executionPlan:plan};await fixture.save(fixture.config);await assert.rejects(fixture.load(),/repository mode/);
 fixture.config.project.mode='repository';await fixture.save(fixture.config);assert.deepEqual((await fixture.load()).project.worker.environment,{executionPlan:plan});
 for(const invalid of [{...plan,sources:[]},{...plan,setup:{...plan.setup,source:{...source,path:'../outside'}}},{...plan,setup:{...plan.setup,timeoutMs:1}},{...plan,env:{SECRET:'not-accepted'}}]){fixture.config.project.worker.environment={executionPlan:invalid};await fixture.save(fixture.config);await assert.rejects(fixture.load());}
 fixture.config.project.worker.environment={preset:'set1'};await fixture.save(fixture.config);await assert.rejects(fixture.load(),/Unknown project.worker.environment/);
});
