// AI-008: optional discovery proposes files only; no live model or repository scripts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, chmod, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverProject, inventoryProject, runDiscoveryWorker } from '../runtime/projects/discovery.mjs';
import { loadAppConfig } from '../runtime/config/index.mjs';
const roots = [];
test.after(async () => { await Promise.all(roots.map(p => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'relay-discovery-test-')); roots.push(root);
  const repo = join(root, 'shop'), binary = join(root, 'codex');
  await mkdir(repo);
  await writeFile(join(repo, 'AGENTS.md'), 'Read documentation before implementation. Do not deploy.');
  await writeFile(join(repo, 'README.md'), '# Shop\nA local inventory app.\n');
  await mkdir(join(repo, 'src')); await writeFile(join(repo, 'src', 'index.ts'), 'export const count = items => items.length;');
  await writeFile(binary, '#!/bin/sh\necho "codex-cli test"\n'); await chmod(binary, 0o700);
  const env = { ...process.env, AI_MANAGER_CODEX_BINARY: binary, CODEX_BINARY: '', AI_MANAGER_PORT: '', VOICE_PORT: '' };
  const analysis = () => ({ name: 'Shop', summary: 'The README describes a local inventory app.', components: ['src: inventory code'], managerContext: 'Clarify inventory goals with the owner.', workerContext: 'Inspect src and relevant docs for each task.', findings: [{ statement: 'Inventory application', status: 'inferred', sources: ['README.md'] }, { statement: 'Production environment is unknown.', status: 'unknown', sources: [] }], questions: ['What business outcome is intended?'] });
  return { root, repo, binary, env, analysis, options: { repositoryRoot: repo, env, runner: async () => analysis() } };
}
test('discovery returns loader-compatible settings, leaves mappings/ref unknown, never changes selected repository', async () => {
  const f = await fixture(), draftDir = join(f.root, 'draft');
  const original = await readFile(join(f.repo, 'README.md'), 'utf8');
  const proposal = await discoverProject({ ...f.options, draftDir });
  assert.equal(proposal.status, 'ready-to-apply'); assert.equal(proposal.activated, false);
  assert.deepEqual(proposal.config.project.linear, { teamId: null, projectId: null, teamKey: null });
  assert.equal(proposal.config.project.repositories[0].baseRef, null);
  assert.equal(proposal.config.project.worker.sandbox, 'read-only');
  assert.match(proposal.managerDraft, /never as permission/); assert.match(proposal.managerDraft, /Tracking is optional/); assert.match(proposal.managerDraft, /observed head commit/); assert.match(proposal.workerDraft, /optional confirmed external issue/); assert.match(proposal.workerDraft, /Do not create other workers/);
  const loaded = await loadAppConfig({ root: f.root, configPath: join(draftDir, 'config.proposal.json'), env: f.env, checkRuntime: false });
  assert.equal(loaded.project.readiness.ready, false);
  assert.equal(loaded.project.repositories[0].path, await realpath(f.repo));
  assert.ok(proposal.evidence.sources.includes('AGENTS.md'));
  assert.equal(await readFile(join(f.repo, 'README.md'), 'utf8'), original);
  assert.deepEqual((await readdir(f.repo)).sort(), ['AGENTS.md', 'README.md', 'src']);
  assert.deepEqual((await readdir(draftDir)).sort(), ['config.proposal.json', 'manager.md', 'proposal.json', 'worker.md']);
});
test('canonical selected folder owns repository identity; model setup placeholders never become effective context', async () => {
  const f = await fixture();
  const alias = join(f.root, 'selected-link'); await symlink(f.repo, alias);
  const analysis = f.analysis();
  analysis.name = 'DRAFT — confirm this with the user';
  analysis.summary = 'DRAFT — human review required.\nConfirm this with the user.\nThe README describes a local inventory app.\nConfirm Linear team ID before applying configuration.';
  analysis.managerContext = 'Review the prompts with the user.\nUse inventory documentation as project context.';
  analysis.workerContext = 'Confirm the base ref with the user.\nInspect src for inventory calculations.';
  analysis.questions = ['Choose a repository base ref.', 'Confirm Linear team ID with the user.', 'Review the complete draft configuration.', 'What business outcome is intended?', 'Should inventory include reserved stock?'];
  const p = await discoverProject({ ...f.options, repositoryRoot: alias, runner: async () => analysis });
  assert.equal(p.config.project.name, 'shop');
  assert.equal(p.config.project.repositories[0].name, 'shop');
  assert.equal(p.config.project.repositories[0].path, await realpath(f.repo));
  assert.equal(p.evidence.repositoryRoot, await realpath(f.repo));
  assert.equal(p.config.project.context, 'The README describes a local inventory app.');
  assert.doesNotMatch(p.managerDraft + p.workerDraft, /human review|required\.\n|confirm this|draft for|Confirm the base ref|Review the prompts/i);
  assert.match(p.managerDraft, /Use inventory documentation/);
  assert.match(p.workerDraft, /Inspect src/);
  assert.deepEqual(p.confirmations, ['Should inventory include reserved stock?']);
  assert.equal(p.config.project.repositories[0].baseRef, null);
  assert.equal(p.findings[1].status, 'unknown');
});
test('actual legacy AI-008 output does not leak task-coded identity or activation disclaimers', async () => {
  const f = await fixture(), analysis = f.analysis();
  analysis.name = 'AI-008 — Set1 / Big Picture discovery draft';
  analysis.summary = 'The project is an inventory application. This proposal is inferred and does not authorize activation/work.';
  analysis.managerContext = 'Human review should resolve these before any work is activated.';
  const p = await discoverProject({ ...f.options, runner: async () => analysis });
  assert.equal(p.config.project.name, 'shop');
  assert.equal(p.config.project.context, 'The project is an inventory application.');
  assert.doesNotMatch(p.managerDraft, /This proposal|Human review should|activation\/work/);
});
test('sensible model product name is separate from canonical repository basename', async () => {
  const f = await fixture(), analysis = f.analysis();
  analysis.name = 'Stockroom (draft)';
  const p = await discoverProject({ ...f.options, runner: async () => analysis });
  assert.equal(p.config.project.name, 'Stockroom');
  assert.equal(p.config.project.repositories[0].name, 'shop');
  assert.doesNotMatch(p.config.project.context, /DRAFT|human review/);
});
test('bounded inventory excludes credentials, symlinks, binary, generated code and redacts embedded credential values', async () => {
  const f = await fixture();
  for (const dir of ['node_modules', '.git', 'build', 'vendor']) { await mkdir(join(f.repo, dir)); await writeFile(join(f.repo, dir, 'README.md'), 'HIDDEN'); }
  for (const name of ['.env', 'credentials.json', 'secret.json', 'private.key', 'auth.json']) await writeFile(join(f.repo, name), 'HIDDEN');
  await writeFile(join(f.root, 'outside.md'), 'HIDDEN'); await symlink(join(f.root, 'outside.md'), join(f.repo, 'link.md'));
  await writeFile(join(f.repo, 'binary.md'), Buffer.from([0, 1, 2]));
  await writeFile(join(f.repo, 'config.ts'), 'const api_key = "HIDDEN";\nconst token = "ghp_123456789012345678901";\nexport const good = 3;');
  const snapshot = await inventoryProject(f.repo);
  assert.equal(JSON.stringify(snapshot).includes('HIDDEN'), false);
  assert.equal(JSON.stringify(snapshot).includes('ghp_123456789012345678901'), false);
  assert.match(snapshot.sources.find(s => s.path === 'config.ts').content, /export const good/);
  assert.equal(snapshot.entries.some(e => /node_modules|\.git|credentials|private|auth\.json|link\.md/.test(e.path)), false);
  assert.equal(snapshot.sources.some(s => s.path === 'binary.md'), false);
});
test('source budget is explicit and AGENTS/README precede ordinary code', async () => {
  const f = await fixture();
  for (let i = 0; i < 40; i++) await writeFile(join(f.repo, 'src', `file${i}.ts`), 'x'.repeat(10000));
  const snapshot = await inventoryProject(f.repo);
  assert.equal(snapshot.sources[0].path, 'AGENTS.md'); assert.equal(snapshot.sources[1].path, 'README.md');
  assert.ok(snapshot.sources.length <= 24); assert.ok(snapshot.sources.reduce((n, s) => n + Buffer.byteLength(s.content), 0) <= 131072);
  assert.equal(snapshot.truncated, true);
});
test('rejects invented schema fields, confirmed assertions and unsupplied/path-traversal evidence', async () => {
  const f = await fixture();
  for (const mutate of [a => { a.linear = { teamId: 'invented' }; }, a => { a.findings[0].status = 'confirmed'; }, a => { a.findings[0].sources = ['../outside.md']; }, a => { a.findings[0].sources = ['missing.md']; }, a => { a.findings[0].sources = []; }]) {
    const a = f.analysis(); mutate(a);
    const destination = join(f.root, 'bad-draft');
    await assert.rejects(discoverProject({ ...f.options, draftDir: destination, runner: async () => a }), /invalid proposal/);
    await assert.rejects(readdir(destination), { code: 'ENOENT' });
  }
});
test('refuses output inside project, symlinked output parent into project, and pre-existing destination', async () => {
  const f = await fixture(); let calls = 0;
  const runner = async () => { calls++; return f.analysis(); };
  await assert.rejects(discoverProject({ ...f.options, runner, draftDir: join(f.repo, 'draft') }), /outside/);
  await symlink(f.repo, join(f.root, 'alias'));
  await assert.rejects(discoverProject({ ...f.options, runner, draftDir: join(f.root, 'alias', 'draft') }), /outside/);
  const draftDir = join(f.root, 'existing'); await mkdir(draftDir); await writeFile(join(draftDir, 'keep'), 'original');
  await assert.rejects(discoverProject({ ...f.options, runner, draftDir }), /already exists/);
  assert.equal(await readFile(join(draftDir, 'keep'), 'utf8'), 'original'); assert.equal(calls, 0);
});
test('pre-cancel never launches, cancellation after model never publishes, failed worker leaves no output/temp files', async () => {
  const f = await fixture(), controller = new AbortController(); controller.abort();
  let calls = 0;
  await assert.rejects(discoverProject({ ...f.options, signal: controller.signal, runner: async () => { calls++; } }), { name: 'AbortError' });
  assert.equal(calls, 0);
  let cwd;
  const next = new AbortController(), draftDir = join(f.root, 'cancelled');
  await assert.rejects(discoverProject({ ...f.options, draftDir, signal: next.signal, runner: async args => { cwd = args.cwd; next.abort(); return f.analysis(); } }), { name: 'AbortError' });
  await assert.rejects(readdir(cwd), { code: 'ENOENT' }); await assert.rejects(readdir(draftDir), { code: 'ENOENT' });
  await assert.rejects(discoverProject({ ...f.options, draftDir, runner: async args => { cwd = args.cwd; throw new Error('Fixture worker failure'); } }), /Fixture worker failure/);
  await assert.rejects(readdir(cwd), { code: 'ENOENT' });
});
test('model output redaction preserves valid JSON and ordinary context', async () => {
  const f = await fixture(), a = f.analysis(); a.summary = 'api_key = "fake-secret-value"\nInventory app';
  const p = await discoverProject({ ...f.options, runner: async () => a });
  assert.equal(JSON.stringify(p).includes('fake-secret-value'), false); assert.match(p.config.project.context, /Inventory app/);
});
async function fakeWorker(f, code) {
  const executable = join(f.root, 'worker.cjs');
  await writeFile(executable, `#!${process.execPath}\n${code}`); await chmod(executable, 0o700);
  return executable;
}
test('real child transport uses forced ChatGPT, read-only, no shell/apps and schema; strips API env and passes bounded snapshot on stdin', async () => {
  const f = await fixture();
  const executable = await fakeWorker(f, `const fs=require('fs');const args=process.argv.slice(2);let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{fs.writeFileSync(args[args.indexOf('-o')+1],JSON.stringify({args,input,api:process.env.OPENAI_API_KEY??null}));console.log(JSON.stringify({type:'turn.completed'}));});`);
  const result = await runDiscoveryWorker({ executable, prompt: 'bounded snapshot', cwd: f.root, schemaPath: join(f.root, 'schema.json'), outputPath: join(f.root, 'output.json'), env: { ...f.env, OPENAI_API_KEY: 'must-be-removed' } });
  assert.equal(result.api, null); assert.equal(result.input, 'bounded snapshot');
  for (const required of ['--ignore-user-config', '--ephemeral', 'forced_login_method="chatgpt"', 'read-only', 'shell_tool', 'apps', 'plugins', '--output-schema']) assert.ok(result.args.includes(required));
});
test('transport cancellation and timeout terminate child and reject without accepting partial output', async () => {
  const f = await fixture(), executable = await fakeWorker(f, 'setInterval(()=>{},1000);');
  const options = { executable, prompt: 'snapshot', cwd: f.root, schemaPath: join(f.root, 'schema'), outputPath: join(f.root, 'output'), env: f.env };
  const controller = new AbortController(); setTimeout(() => controller.abort(), 40);
  await assert.rejects(runDiscoveryWorker({ ...options, signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(runDiscoveryWorker({ ...options, timeoutMs: 40 }), /bounded time/);
});
test('transport rejects model failure and symlink output, without exposing raw errors', async () => {
  const f = await fixture(), options = { prompt: 'snapshot', cwd: f.root, schemaPath: join(f.root, 'schema'), outputPath: join(f.root, 'output'), env: f.env };
  let executable = await fakeWorker(f, `console.log(JSON.stringify({type:'error',message:'private diagnostic'}));`);
  await assert.rejects(runDiscoveryWorker({ ...options, executable }), error => /did not complete/.test(error.message) && !error.message.includes('private diagnostic'));
  executable = await fakeWorker(f, `require('fs').symlinkSync(${JSON.stringify(join(f.repo, 'README.md'))},${JSON.stringify(options.outputPath)});console.log(JSON.stringify({type:'turn.completed'}));`);
  await assert.rejects(runDiscoveryWorker({ ...options, executable }), /output limit/);
});
