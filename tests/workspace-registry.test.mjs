import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorkspaceRegistry } from '../desktop/workspace-registry.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'crew-workspaces-'));
  t.after(() => rm(dir, { recursive:true, force:true }));
  const crewRoot = join(dir, 'Crew');
  const input = async (key, name = 'Project name') => {
    const folder = join(dir, key); await mkdir(folder, { recursive:true });
    const configPath = join(folder, 'project.json');
    await writeFile(configPath, JSON.stringify({ project:{ name }, retained:{ history:'keep', prompt:'custom' } }, null, 4));
    return { configPath, key, desktopData:join(dir, 'desktop', key) };
  };
  const initial = await input('retained');
  return { dir, crewRoot, initial, input, path:join(crewRoot, 'workspaces.json') };
}

test('first registration preserves all existing config, profile and worker evidence bytes and identity', async t => {
  const f = await fixture(t);
  await mkdir(f.initial.desktopData, { recursive:true });
  const evidence = join(f.initial.desktopData, 'voice-choice.json');
  await writeFile(evidence, '{"voice":"retained"}\n');
  const before = await readFile(f.initial.configPath);
  const registry = await openWorkspaceRegistry(f);
  const snapshot = registry.snapshot();
  assert.equal(snapshot.version, 1); assert.equal(snapshot.workerLimit, 2);
  assert.equal(snapshot.projects.length, 1); assert.equal(snapshot.selectedId, snapshot.projects[0].id);
  assert.deepEqual(snapshot.projects[0], { ...f.initial, id:snapshot.selectedId, name:'Project name' });
  assert.deepEqual(await readFile(f.initial.configPath), before);
  assert.equal(await readFile(evidence, 'utf8'), '{"voice":"retained"}\n');
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  assert.equal((await stat(f.crewRoot)).mode & 0o777, 0o700);
  snapshot.projects[0].name = 'mutated copy';
  assert.equal(registry.snapshot().projects[0].name, 'Project name');
});

test('add, rename, selected workspace and one worker limit survive reload; default launch does not add or select initial', async t => {
  const f = await fixture(t), registry = await openWorkspaceRegistry(f);
  const first = registry.snapshot().selectedId;
  const next = await registry.add(await f.input('second', 'Second'));
  const second = next.selectedId;
  await registry.rename(second, '  Renamed project  '); await registry.setWorkerLimit(4);
  const unrelated = await f.input('not-registered');
  let restored = await openWorkspaceRegistry({ ...f, initial:unrelated });
  assert.equal(restored.snapshot().selectedId, second);
  assert.equal(restored.snapshot().projects.length, 2);
  assert.equal(restored.snapshot().workerLimit, 4);
  assert.equal(restored.snapshot().projects[1].name, 'Renamed project');
  await restored.select(first);
  restored = await openWorkspaceRegistry(f);
  assert.equal(restored.snapshot().selectedId, first);
});

test('explicit config registers and selects it; existing config alias retains original path and profile identity', async t => {
  const f = await fixture(t), registry = await openWorkspaceRegistry(f);
  const initialId = registry.snapshot().selectedId;
  const second = await f.input('second');
  let opened = await openWorkspaceRegistry({ ...f, initial:second, explicitConfig:true });
  assert.equal(opened.snapshot().projects.length, 2);
  assert.equal(opened.snapshot().projects[1].key, 'second');
  const alias = join(f.dir, 'config-alias.json'); await symlink(f.initial.configPath, alias);
  opened = await openWorkspaceRegistry({ ...f, initial:{ ...f.initial, configPath:alias, key:'other-alias-key' }, explicitConfig:true });
  assert.equal(opened.snapshot().selectedId, initialId);
  assert.equal(opened.snapshot().projects.length, 2);
  assert.equal(opened.snapshot().projects[0].configPath, f.initial.configPath);
  assert.equal(opened.snapshot().projects[0].key, 'retained');
});

test('missing or unreadable config name uses safe fallback and registration never initializes config', async t => {
  const f = await fixture(t);
  await rm(f.initial.configPath);
  const registry = await openWorkspaceRegistry(f);
  assert.equal(registry.snapshot().projects[0].name, 'Your project');
  await assert.rejects(readFile(f.initial.configPath), { code:'ENOENT' });
});

test('failed mutations leave saved and in-memory state intact and later mutations still run', async t => {
  const f = await fixture(t), registry = await openWorkspaceRegistry(f);
  const initial = registry.snapshot(), bytes = await readFile(f.path);
  const other = await f.input('second');
  const alias = join(f.dir, 'profile-alias');
  await mkdir(f.initial.desktopData, { recursive:true }); await symlink(f.initial.desktopData, alias);
  const invalidAdds = [
    { ...other, configPath:'relative.json' }, { ...other, configPath:'/tmp/x\0y' },
    { ...other, key:'bad/key' }, { ...other, desktopData:alias },
    { ...other, key:f.initial.key }, { ...other, configPath:f.initial.configPath },
    { ...other, name:'\n' }, { ...other, desktopData:'/' }, { ...other, id:'injected' }
  ];
  for (const input of invalidAdds) await assert.rejects(registry.add(input), /Workspace registry:/);
  for (const limit of [0, -1, 65, 1.5, '2', null]) await assert.rejects(registry.setWorkerLimit(limit), /Worker limit/);
  await assert.rejects(registry.select('unknown'), /not found/);
  await assert.rejects(registry.rename(initial.selectedId, 'bad\nname'), /Project name/);
  await assert.rejects(registry.rename('unknown', 'Valid'), /not found/);
  assert.deepEqual(registry.snapshot(), initial); assert.deepEqual(await readFile(f.path), bytes);
  await registry.rename(initial.selectedId, 'Still usable');
  assert.equal(registry.snapshot().projects[0].name, 'Still usable');
});

test('concurrent mutations serialize without losing projects, names, selection or worker limit', async t => {
  const f = await fixture(t), registry = await openWorkspaceRegistry(f);
  const first = registry.snapshot().selectedId;
  const inputs = await Promise.all(Array.from({ length:12 }, (_, i) => f.input(`p${i}`)));
  await Promise.all([
    ...inputs.map(input => registry.add(input)),
    registry.rename(first, 'First retained'), registry.setWorkerLimit(7), registry.select(first)
  ]);
  const snapshot = registry.snapshot();
  assert.equal(snapshot.projects.length, 13); assert.equal(snapshot.selectedId, first);
  assert.equal(snapshot.projects[0].name, 'First retained'); assert.equal(snapshot.workerLimit, 7);
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), snapshot);
  assert.ok(!(await readdir(f.crewRoot)).some(name => name.endsWith('.tmp')));
});

test('corrupted registry fails closed, preserves bytes and never replaces it with initial configuration', async t => {
  const f = await fixture(t), registry = await openWorkspaceRegistry(f), valid = registry.snapshot();
  const cases = [
    '{invalid', JSON.stringify({ ...valid, version:2 }), JSON.stringify({ ...valid, selectedId:'missing' }),
    JSON.stringify({ ...valid, workerLimit:0 }), JSON.stringify({ ...valid, projects:[] }),
    JSON.stringify({ ...valid, projects:[...valid.projects, { ...valid.projects[0], id:'duplicate-config' }] }),
    JSON.stringify({ ...valid, projects:[{ ...valid.projects[0], id:'../unsafe' }] }),
    JSON.stringify({ ...valid, projects:[{ ...valid.projects[0], configPath:'relative.json' }] })
  ];
  for (const bytes of cases) {
    await writeFile(f.path, bytes);
    await assert.rejects(openWorkspaceRegistry({ ...f, explicitConfig:true }), /Cannot open workspaces.json/);
    assert.equal(await readFile(f.path, 'utf8'), bytes);
  }
});


test('an explicitly empty registry registers initial project and retains configured capacity', async t => {
  const f = await fixture(t);
  await mkdir(f.crewRoot, { recursive:true });
  await writeFile(f.path, JSON.stringify({ version:1, selectedId:null, workerLimit:5, projects:[] }));
  const registry = await openWorkspaceRegistry(f);
  assert.equal(registry.snapshot().projects.length, 1);
  assert.equal(registry.snapshot().projects[0].configPath, f.initial.configPath);
  assert.equal(registry.snapshot().selectedId, registry.snapshot().projects[0].id);
  assert.equal(registry.snapshot().workerLimit, 5);
});
