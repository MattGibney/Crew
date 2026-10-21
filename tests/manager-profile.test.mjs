import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createManagerProfile } from '../manager-profile.mjs';

test('manager voices persist per project, reject stale writes and retain corrupt evidence', async t => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'crew-profile-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const first = createManagerProfile({ stateDir, projectId: 'first' });
  const second = createManagerProfile({ stateDir, projectId: 'second' });
  const initial = await first.read();
  assert.equal(initial.voice, null); assert.equal(initial.configured, false);
  const saves = await Promise.allSettled(['cove', 'maple'].map(voice => first.save({ voice, expectedVersion: initial.version })));
  assert.equal(saves.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await first.read()).voice, 'cove'); assert.equal((await first.read()).configured, true);
  assert.equal((await second.read()).voice, null);
  assert.equal((await createManagerProfile({ stateDir, projectId: 'first' }).read()).voice, 'cove');
  await assert.rejects(first.save({ voice: '../unsafe', expectedVersion: (await first.read()).version }));
  const file = path.join(stateDir, 'manager-profiles/first.json');
  await writeFile(file, '{broken');
  await assert.rejects(first.save({ voice: 'maple', expectedVersion: initial.version }));
  assert.equal(await readFile(file, 'utf8'), '{broken');
});
