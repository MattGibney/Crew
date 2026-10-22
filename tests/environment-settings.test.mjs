import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm, symlink, rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createEnvironmentSettings} from '../runtime/projects/environment-settings.mjs';
import {validateWorkerEnvironment} from '../runtime/config/index.mjs';
import {decodeApi} from '../renderer/src/contracts/decode.ts';

const source = {path: 'AGENTS.md', sha256: 'a'.repeat(64)};
const hook = {command: '/usr/bin/printf', args: ['a b', '"quoted"', '$(never-execute)', ''], timeoutMs: 1234};
test('settings decoder accepts backend-validated absent lifecycle phases without losing edits', async t => {
  const phases = ['setup','start','resume','ready','stop','teardown'];
  const plan = {schemaVersion:1, sources:[source], ...Object.fromEntries(phases.map(phase => [phase,null]))};
  plan.start = {command:'printf retained', source, timeoutMs:1000};
  const f = await fixture(t, {executionPlan:plan});
  const response = workerEnvironment => ({managerProfile:{voice:null,version:'profile'}, managerLifecycle:{state:'running'}, manager:{saved:{text:'Manager',version:'m1'}}, worker:{saved:{text:'Worker',version:'w1'}}, workerEnvironment});
  const before = await f.store.read();
  for (const phase of phases) {
    const payload = response(structuredClone(before));
    payload.workerEnvironment.environment.executionPlan[phase] = null;
    payload.workerEnvironment.environment = validateWorkerEnvironment(payload.workerEnvironment.environment);
    assert.equal(decodeApi('settings', payload), payload);
  }
  for (const endpoint of ['settings','settings/worker-environment']) {
    const payload = response(before);
    assert.equal(decodeApi(endpoint, payload), payload);
  }
  const edited = structuredClone(before.environment);
  edited.executionPlan.start.command = 'printf updated';
  const saved = await f.store.save({expectedRevision:before.revision, environment:edited});
  assert.equal(decodeApi('settings/worker-environment', response(saved)).workerEnvironment.environment.executionPlan.ready, null);
  const restarted = await createEnvironmentSettings({configuration:f.configuration});
  const restored = await restarted.read();
  assert.deepEqual(decodeApi('settings', response(restored)).workerEnvironment.environment, edited);
  for (const phase of phases) {
    for (const invalid of [false, 'not a hook', [], {command:'missing source and timeout'}]) {
      const malformed = response(structuredClone(restored));
      malformed.workerEnvironment.environment.executionPlan[phase] = invalid;
      assert.throws(() => decodeApi('settings', malformed), /Invalid settings response/);
    }
  }
});
async function fixture(t, environment = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'crew-environment-settings-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const configPath = join(directory, 'config.json');
  const raw = {schemaVersion:1, runtime:{custom:'preserve'}, custom:{nested:[1,2]}, project:{id:'example', mode:'repository', custom:'preserve', worker:{sandbox:'read-only', timeoutMs:99999, custom:{a:1}, environment}}};
  await writeFile(configPath, JSON.stringify(raw));
  const configuration = {configPath, project:{id:'example', mode:'repository'}};
  return {configPath, raw, configuration, store:await createEnvironmentSettings({configuration})};
}
test('every direct hook preserves literal argv and unrelated configuration across restart', async t => {
  const f = await fixture(t), before = await f.store.read();
  const environment = Object.fromEntries(['bootstrap','start','ready','resume','cleanup'].map(name=>[name,hook]));
  const saved = await f.store.save({expectedRevision:before.revision, environment});
  assert.deepEqual(saved.environment, environment);
  const disk = JSON.parse(await readFile(f.configPath,'utf8'));
  assert.deepEqual({...disk.project.worker, environment:{}}, f.raw.project.worker);
  assert.deepEqual(disk.runtime, f.raw.runtime);
  assert.deepEqual(disk.custom, f.raw.custom);
  const restarted = await createEnvironmentSettings({configuration:f.configuration});
  assert.deepEqual((await restarted.read()).environment, environment);
  assert.match(saved.provenance.description, /Crew overrides/);
});
test('all source-backed phases are editable; legacy PATH, provenance and permissions stay pinned', async t => {
  const plan = {schemaVersion:1, sources:[source], env:{PATH:'/usr/bin'}, networkAccess:false, permissionsSource:{path:'/private/project/.codex/config.toml',sha256:'b'.repeat(64)}};
  const f = await fixture(t,{executionPlan:plan}), before = await f.store.read();
  const executionPlan = structuredClone(plan);
  for (const name of ['setup','start','resume','ready','stop','teardown']) executionPlan[name] = {command:`printf '${name} $literal'`,source,timeoutMs:1000};
  const saved = await f.store.save({expectedRevision:before.revision, environment:{executionPlan}});
  assert.deepEqual(saved.environment.executionPlan, executionPlan);
  for (const change of [{env:{PATH:'/chosen/bin:/usr/bin'}},{networkAccess:true},{sources:[{...source,sha256:'c'.repeat(64)}]},{permissionsSource:undefined}]) {
    await assert.rejects(f.store.save({expectedRevision:saved.revision, environment:{executionPlan:{...executionPlan,...change}}}));
    assert.equal((await f.store.read()).revision,saved.revision);
  }
  const modifiedPhase = {...executionPlan, start:{...executionPlan.start, source:{...source,sha256:'d'.repeat(64)}}};
  await assert.rejects(f.store.save({expectedRevision:saved.revision,environment:{executionPlan:modifiedPhase}}), /present in plan sources/);
});
test('invalid, canceled and stale edits preserve exact bytes, including external custom changes', async t => {
  const f = await fixture(t), before = await f.store.read();
  const original = await readFile(f.configPath,'utf8');
  await assert.rejects(f.store.save({expectedRevision:before.revision,environment:{start:{...hook,timeoutMs:1}}}));
  assert.equal(await readFile(f.configPath,'utf8'), original);
  assert.equal((await f.store.read()).revision,before.revision); // cancel only reads
  const changed = JSON.stringify({...f.raw,custom:{new:'external edit'}});
  await writeFile(f.configPath, changed);
  await assert.rejects(f.store.save({expectedRevision:before.revision,environment:{start:hook}}), /changed elsewhere/);
  assert.equal(await readFile(f.configPath,'utf8'), changed);
});
test('concurrent writers serialize whole-document revisions', async t => {
  const f=await fixture(t), other=await createEnvironmentSettings({configuration:f.configuration});
  const before=await f.store.read();
  const results=await Promise.allSettled([f.store.save({expectedRevision:before.revision,environment:{start:hook}}),other.save({expectedRevision:before.revision,environment:{ready:hook}})]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(results.filter(result=>result.status==='rejected').length,1);
});
test('missing, symlinked, replaced and wrong-project configuration fail without modifying targets', async t => {
  const f=await fixture(t), before=await f.store.read();
  const bytes=await readFile(f.configPath,'utf8');
  const replacement=f.configPath+'.replacement';
  await writeFile(replacement,bytes); await rename(replacement,f.configPath);
  await assert.rejects(f.store.save({expectedRevision:before.revision,environment:{start:hook}}), /replaced/);
  await rm(f.configPath); await assert.rejects(f.store.read());
  const target=f.configPath+'.target'; await writeFile(target,bytes); await symlink(target,f.configPath);
  await assert.rejects(f.store.read(), /symbolic link/);
  assert.equal(await readFile(target,'utf8'),bytes);
  await rm(f.configPath); await writeFile(f.configPath,JSON.stringify({...f.raw,project:{...f.raw.project,id:'different'}}));
  await assert.rejects(f.store.read(), /identity changed/);
});
test('validator rejects invented events, shell-shaped argv and unsupported options', () => {
  assert.throws(()=>validateWorkerEnvironment({stop:hook}));
  assert.throws(()=>validateWorkerEnvironment({start:{...hook,args:'--quoted args'}}));
  assert.throws(()=>validateWorkerEnvironment({start:{...hook,cwd:'/somewhere'}}));
  assert.throws(()=>validateWorkerEnvironment({executionPlan:{schemaVersion:1,sources:[source],env:{SECRET:'not-supported'}}}));
});

test('default fixture without a saved config remains readable and refuses edits', async () => {
  const store = await createEnvironmentSettings({configuration:{configPath:null,project:{id:'fixture',mode:'fixture',worker:{environment:{}}}}});
  const current = await store.read();
  assert.equal(current.available,false);
  assert.equal(current.revision,null);
  assert.equal(current.configPath,null);
  assert.deepEqual(current.environment,{});
  await assert.rejects(store.save({expectedRevision:null,environment:{}}), /Save project setup/);
});


test('external repository or state directory drift fails closed after reload and preserves all bytes', async t => {
  const f=await fixture(t);
  const raw={...f.raw,runtime:{...f.raw.runtime,dataDir:'state'},project:{...f.raw.project,repositories:[{id:'repo',path:'repo',baseRef:'main',custom:'preserve'}]}};
  await writeFile(f.configPath,JSON.stringify(raw));
  const configuration={...f.configuration,dataDir:join(f.configPath,'..','state'),project:{...f.configuration.project,repositories:[{id:'repo',path:join(f.configPath,'..','repo'),baseRef:'main'}]}};
  const store=await createEnvironmentSettings({configuration});
  const initial=await store.read();
  for (const drift of [
    {...raw,runtime:{...raw.runtime,dataDir:'different-state'}},
    {...raw,project:{...raw.project,repositories:[{...raw.project.repositories[0],path:'different-repo'}]}},
    {...raw,project:{...raw.project,repositories:[{...raw.project.repositories[0],baseRef:'different-branch'}]}},
    {...raw,project:{...raw.project,repositories:[{...raw.project.repositories[0],id:'different-id'}]}}
  ]) {
    const bytes=JSON.stringify(drift);await writeFile(f.configPath,bytes);
    await assert.rejects(store.read(), /state directory changed|repository identity changed/);
    await assert.rejects(store.save({expectedRevision:initial.revision,environment:{start:hook}}), /state directory changed|repository identity changed/);
    assert.equal(await readFile(f.configPath,'utf8'),bytes);
  }
  // Presentation and unrelated custom fields do not change execution identity.
  await writeFile(f.configPath,JSON.stringify({...raw,project:{...raw.project,name:'New name',context:'Updated context'}}));
  const current=await store.read();
  await store.save({expectedRevision:current.revision,environment:{start:hook}});
  const saved=JSON.parse(await readFile(f.configPath,'utf8'));
  assert.equal(saved.project.name,'New name');
  assert.equal(saved.project.repositories[0].custom,'preserve');
});
