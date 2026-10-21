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


test('an abandoned candidate retains release barriers until observer absence is verified', async t => {
  const dir = await fixture(t), candidate = path.join(dir, '.proof.lock.candidate-abandoned');
  await fs.mkdir(candidate);
  await withStateLock(dir, '.proof.lock', async () => {});
  assert.equal((await fs.readdir(dir)).filter(name => name.startsWith('.proof.lock.stale-')).length, 1);
  await fs.rm(candidate, { recursive: true });
  await withStateLock(dir, '.proof.lock', async () => {});
  assert.deepEqual(await fs.readdir(dir), []);
});
