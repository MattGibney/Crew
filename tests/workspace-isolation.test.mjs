import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertWorkspaceIsolation } from '../runtime/desktop/workspace-isolation.mjs';
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'crew-isolation-')));
  t.after(() => rm(root, { recursive:true, force:true }));
  const projects = [], configs = [];
  for (const [id, port] of [['a', 4320], ['b', 4321]]) {
    const dir = join(root, id); await mkdir(dir);
    const configPath = join(dir, 'project.json');
    const config = { runtime:{ port, dataDir:'state' }, project:{ prompts:{ manager:'prompts/manager.md', worker:'prompts/worker.md' } } };
    await writeFile(configPath, JSON.stringify(config)); projects.push({ id, configPath }); configs.push(config);
  }
  return { root, projects, configs, makeCandidate:config => ({ ...projects[1], config }) };
}

test('isolated templates with missing state and instruction folders pass without creating files', async t => {
  const f = await fixture(t), bytes = await readFile(f.projects[0].configPath);
  const result = await assertWorkspaceIsolation(f);
  assert.equal(result.length, 2); assert.equal(result[0].dataDir, join(f.root, 'a/state'));
  assert.equal(result[1].promptPaths.worker, join(f.root, 'b/prompts/worker.md'));
  assert.deepEqual(await readFile(f.projects[0].configPath), bytes);
});

test('proposed config is checked before writing and matching project is substituted', async t => {
  const f = await fixture(t), bytes = await readFile(f.projects[1].configPath);
  const config = structuredClone(f.configs[1]); config.runtime.port = 4320;
  await assert.rejects(assertWorkspaceIsolation({ ...f, candidate:f.makeCandidate(config) }), /share port/);
  assert.deepEqual(await readFile(f.projects[1].configPath), bytes);
  config.runtime.port = 5000;
  const result = await assertWorkspaceIsolation({ ...f, candidate:f.makeCandidate(config) });
  assert.equal(result[1].port, 5000);
  await assert.rejects(assertWorkspaceIsolation({ ...f, candidate:{ ...f.makeCandidate(config), id:'unknown' } }), /Candidate must match/);
});

test('same and nested state paths fail in both directions, including symlink aliases and absent children', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'a/state')); await symlink(join(f.root, 'a/state'), join(f.root, 'state-alias'));
  for (const path of ['../a/state', '../a/state/nested', '../state-alias', '../state-alias/new/nested', '..']) {
    const config = structuredClone(f.configs[1]); config.runtime.dataDir = path;
    await assert.rejects(assertWorkspaceIsolation({ ...f, candidate:f.makeCandidate(config) }), /share or nest state folders/);
  }
});

test('shared instruction files and instruction aliases fail across roles and projects', async t => {
  const f = await fixture(t), config = structuredClone(f.configs[1]);
  config.project.prompts.worker = '../a/prompts/manager.md';
  await assert.rejects(assertWorkspaceIsolation({ ...f, candidate:f.makeCandidate(config) }), /share instruction files/);
  await mkdir(join(f.root, 'a/prompts')); await symlink(join(f.root, 'a/prompts'), join(f.root, 'prompts-alias'));
  config.project.prompts.worker = '../prompts-alias/manager.md';
  await assert.rejects(assertWorkspaceIsolation({ ...f, candidate:f.makeCandidate(config) }), /share instruction files/);
  config.project.prompts.worker = '../a/state/custom.md';
  await assert.rejects(assertWorkspaceIsolation({ ...f, candidate:f.makeCandidate(config) }), /instructions inside/);
});

test('configuration aliases and configuration inside another state folder fail', async t => {
  const f = await fixture(t), alias = join(f.root, 'config-alias.json');
  await symlink(f.projects[0].configPath, alias);
  const projects = [f.projects[0], { id:'alias', configPath:alias }];
  const config = structuredClone(f.configs[1]); config.runtime.dataDir = join(f.root, 'elsewhere');
  await assert.rejects(assertWorkspaceIsolation({ projects, candidate:{ id:'alias', configPath:alias, config } }), /share a configuration file/);
  const second = join(f.root, 'a/state/b.json'); await mkdir(join(f.root, 'a/state')); await writeFile(second, JSON.stringify(config));
  await assert.rejects(assertWorkspaceIsolation({ projects:[f.projects[0], { id:'b', configPath:second }] }), /configuration inside/);
});

test('missing, malformed, invalid or unverifiable configurations fail closed', async t => {
  const f = await fixture(t);
  for (const port of [0, 65536, '4321', 4321.5, null]) {
    const config = structuredClone(f.configs[1]); config.runtime.port = port;
    await assert.rejects(assertWorkspaceIsolation({ ...f, candidate:f.makeCandidate(config) }), /needs a port/);
  }
  for (const bytes of ['{bad json', '{}']) {
    await writeFile(f.projects[1].configPath, bytes);
    await assert.rejects(assertWorkspaceIsolation(f), /Workspace isolation:/);
  }
  await rm(f.projects[1].configPath);
  await assert.rejects(assertWorkspaceIsolation(f), /Cannot read configuration/);
  await assert.rejects(assertWorkspaceIsolation({ projects:[] }), /project list/);
  await assert.rejects(assertWorkspaceIsolation({ projects:[...f.projects, f.projects[0]] }), /identities/);
});
