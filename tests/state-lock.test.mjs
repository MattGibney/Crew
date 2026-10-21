import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { withStateLock } from '../orchestration-store.mjs';

const moduleUrl = new URL('../orchestration-store.mjs', import.meta.url).href;
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crew-lock-race-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function holder(t, dir) {
  const script = `import {withStateLock} from ${JSON.stringify(moduleUrl)};
    const release = new Promise(resolve => process.stdin.once('data', resolve));
    await withStateLock(${JSON.stringify(dir)}, '.proof.lock', async () => {
      console.log('LOCKED'); await release;
    });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => stderr += chunk);
  const exited = new Promise(resolve => child.once('exit', code => resolve({ code, stderr })));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('LOCKED')) resolve(); });
    child.once('error', reject);
    exited.then(result => reject(new Error(`Holder exited before locking: ${JSON.stringify(result)}`)));
  });
  return { child, release: async () => { child.stdin.end('release'); assert.deepEqual(await exited, { code: 0, stderr: '' }); } };
}

test('delayed dead-owner observation cannot recover a live successor after ordinary owner release', { timeout: 15000 }, async t => {
  const dir = await fixture(t), lock = path.join(dir, '.proof.lock');
  const first = await holder(t, dir);
  const observed = Promise.withResolvers(), returnObservation = Promise.withResolvers(), attemptedRecovery = Promise.withResolvers();
  const originalRead = fs.readFile, originalRename = fs.rename;
  let delayed = false, retiredToken;
  t.mock.method(fs, 'readFile', async (...args) => {
    const result = await originalRead(...args);
    if (!delayed && args[0] === path.join(lock, 'owner.json')) {
      delayed = true; retiredToken = JSON.parse(result).token;
      observed.resolve(); await returnObservation.promise;
    }
    return result;
  });
  t.mock.method(fs, 'rename', async (...args) => {
    if (args[0] === lock && args[1] === `${lock}.stale-${retiredToken}` && first.child.exitCode === 0) {
      try { return await originalRename(...args); } finally { attemptedRecovery.resolve(); }
    }
    return originalRename(...args);
  });
  let entered = false;
  const contender = withStateLock(dir, '.proof.lock', async () => { entered = true; });
  // Keep a rejection handler installed even if an assertion below fails.
  contender.catch(() => {});
  await observed.promise;
  await first.release();
  const second = await holder(t, dir);
  returnObservation.resolve();
  await attemptedRecovery.promise;
  assert.equal(entered, false, 'stale observer must not enter the live successor critical section');
  const successor = await originalRead(path.join(lock, 'owner.json'), 'utf8').then(JSON.parse).catch(() => null);
  assert.equal(successor?.pid, second.child.pid, 'recovery must preserve the successor owner directory');
  assert.ok((await fs.readdir(dir)).includes(`.proof.lock.stale-${retiredToken}`), 'observer candidate retains the released owner barrier');
  await second.release();
  await contender;
  assert.equal(entered, true);
  assert.deepEqual(await fs.readdir(dir), [], 'last uncontended release reclaims retired barriers');
});

test('ordinary uncontended acquisitions do not accumulate release barriers', async t => {
  const dir = await fixture(t);
  for (let i = 0; i < 12; i++) await withStateLock(dir, '.proof.lock', async () => {});
  assert.deepEqual(await fs.readdir(dir), []);
});


test('incomplete observer evidence is retained and blocks further barrier growth', { timeout: 9000 }, async t => {
  const dir = await fixture(t), candidate = path.join(dir, '.proof.lock.candidate-abandoned');
  await withStateLock(dir, '.proof.lock', async () => { await fs.mkdir(candidate); });
  const before = await fs.readdir(dir);
  assert.equal(before.filter(name => name.startsWith('.proof.lock.stale-')).length, 1);
  await assert.rejects(withStateLock(dir, '.proof.lock', async () => assert.fail('unknown observer must block admission')), /observer ownership unknown/);
  assert.deepEqual(await fs.readdir(dir), before, 'unknown evidence and existing barriers remain unchanged');
});

async function waitFor(fn) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Timed out waiting for observer candidate');
}

test('verified-dead real contender candidates are reclaimed without growing future barriers', { timeout: 12000 }, async t => {
  const dir = await fixture(t), first = await holder(t, dir);
  const script = `import {withStateLock} from ${JSON.stringify(moduleUrl)}; await withStateLock(${JSON.stringify(dir)}, '.proof.lock', async () => {});`;
  const observer = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' });
  const exited = new Promise(resolve => observer.once('exit', resolve));
  t.after(async () => { if (observer.exitCode === null && observer.signalCode === null) observer.kill('SIGKILL'); await exited; });
  const candidate = await waitFor(async () => {
    for (const name of await fs.readdir(dir)) if (name.startsWith('.proof.lock.candidate-')) {
      const owner = await fs.readFile(path.join(dir, name, 'owner.json'), 'utf8').then(JSON.parse).catch(() => null);
      if (owner?.pid === observer.pid) return name;
    }
  });
  observer.kill('SIGKILL'); await exited;
  assert.ok((await fs.readdir(dir)).includes(candidate));
  await first.release();
  for (let i = 0; i < 12; i++) await withStateLock(dir, '.proof.lock', async () => {});
  assert.deepEqual(await fs.readdir(dir), [], 'verified-dead observer and all retired barriers are reclaimed');
});

test('a live owner omitted by a successful ps snapshot remains protected', { timeout: 10000 }, async t => {
  const dir = await fixture(t), first = await holder(t, dir);
  const ownerBefore = await fs.readFile(path.join(dir, '.proof.lock', 'owner.json'), 'utf8');
  const script = `import cp from 'node:child_process'; import {promisify} from 'node:util'; import {syncBuiltinESMExports} from 'node:module';
    const original=cp.execFile, run=promisify(original); let omit=false;
    function wrapped(...args){ return original(...args); }
    wrapped[promisify.custom]=(...args)=>omit&&args[0]==='ps'?Promise.resolve({stdout:'',stderr:''}):run(...args);
    cp.execFile=wrapped; syncBuiltinESMExports();
    const {withStateLock}=await import(${JSON.stringify(moduleUrl)});
    await withStateLock(${JSON.stringify(dir)}, '.warmup.lock', async()=>{}); omit=true;
    try { await withStateLock(${JSON.stringify(dir)}, '.proof.lock', async()=>{console.log('ENTERED');}); process.exitCode=2; }
    catch(error){ if(!/State lock busy/.test(error.message))throw error; console.log('PROTECTED'); }`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  assert.equal(await exited, 0, stderr);
  assert.equal(stdout.trim(), 'PROTECTED');
  assert.equal(await fs.readFile(path.join(dir, '.proof.lock', 'owner.json'), 'utf8'), ownerBefore);
  await first.release();
});


test('an overdue live observer blocks new admission without deleting its evidence', { timeout: 12000 }, async t => {
  const dir = await fixture(t), liveDir = path.join(dir, 'live-owner'), live = await holder(t, liveDir);
  const owner = JSON.parse(await fs.readFile(path.join(liveDir, '.proof.lock', 'owner.json'), 'utf8'));
  owner.at = new Date(Date.now() - 6000).toISOString();
  const candidate = path.join(dir, `.proof.lock.candidate-${owner.token}`);
  await withStateLock(dir, '.proof.lock', async () => {
    await fs.mkdir(candidate); await fs.writeFile(path.join(candidate, 'owner.json'), JSON.stringify(owner));
  });
  const before = await fs.readdir(dir), evidence = await fs.readFile(path.join(candidate, 'owner.json'), 'utf8');
  await assert.rejects(withStateLock(dir, '.proof.lock', async () => assert.fail('overdue live observer must block')), /observer ownership unknown/);
  assert.deepEqual(await fs.readdir(dir), before);
  assert.equal(await fs.readFile(path.join(candidate, 'owner.json'), 'utf8'), evidence);
  assert.doesNotThrow(() => process.kill(live.child.pid, 0));
  await live.release();
  await withStateLock(dir, '.proof.lock', async () => {});
  assert.deepEqual(await fs.readdir(dir), ['live-owner'], 'only verified process exit permits observer cleanup');
});
