import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createManagerProfile } from '../runtime/manager-profile.mjs';

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

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7WQAAAAASUVORK5CYII=';
test('profile patches preserve voice, isolate projects, migrate legacy voice and reject unsafe inputs without mutation', async t => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'crew-profile-details-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const store = createManagerProfile({ stateDir, projectId: 'first' });
  let profile = await store.save({ voice: 'cove', expectedVersion: (await store.read()).version });
  const file = path.join(stateDir, 'manager-profiles/first.json');
  await writeFile(file, JSON.stringify({ schemaVersion: 1, projectId: 'first', voice: 'maple' }));
  profile = await store.read();
  assert.equal(profile.name, ''); assert.equal(profile.personality, ''); assert.equal(profile.voice, 'maple');
  profile = await store.save({ name: '  Ada  ', personality: 'Be warm and direct.\nAsk one question.', picture: png, expectedVersion: profile.version });
  assert.equal(profile.name, 'Ada'); assert.equal(profile.voice, 'maple');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).schemaVersion, 2);
  profile = await store.save({ voice: null, expectedVersion: profile.version });
  assert.equal(profile.picture, png); assert.equal(profile.name, 'Ada');
  assert.deepEqual(await createManagerProfile({ stateDir, projectId: 'first' }).read(), profile);
  assert.equal((await createManagerProfile({ stateDir, projectId: 'second' }).read()).picture, null);
  const before = await readFile(file, 'utf8');
  for (const patch of [{ name: 'x'.repeat(81) }, { name: 'bad\nname' }, { personality: 'x'.repeat(8001) }, { personality: 'bad\0' }, { personality: 'sk-abcdefghijklmnopqrstuvwxyz12345' }, { picture: 'file:///tmp/picture.png' }, { picture: 'data:image/svg+xml;base64,PHN2Zz4=' }, { picture: 'data:image/png;base64,AAAA' }, { picture: png.replace('image/png', 'image/jpeg') }, { unexpected: true }]) {
    await assert.rejects(store.save({ ...patch, expectedVersion: profile.version }));
    assert.equal(await readFile(file, 'utf8'), before);
  }
  await assert.rejects(store.save({ name: 'Blocked', expectedVersion: profile.version }, () => { throw Error('combined instruction limit'); }), /combined instruction limit/);
  assert.equal(await readFile(file, 'utf8'), before);
  profile = await store.save({ name: '', personality: '', picture: null, expectedVersion: profile.version });
  assert.equal(profile.name, ''); assert.equal(profile.personality, ''); assert.equal(profile.picture, null);
});

test('only explicit name/personality change the native instruction snapshot; picture/voice never enter instructions', async () => {
  const { managerProfileSnapshot } = await import('../runtime/manager-profile.mjs');
  const { promptSnapshot } = await import('../runtime/prompt-settings.mjs');
  const original = 'CUSTOM complete replacement instructions';
  assert.deepEqual(managerProfileSnapshot(original), promptSnapshot(original));
  assert.deepEqual(managerProfileSnapshot(original, { voice: 'maple', picture: png }), promptSnapshot(original));
  const snapshot = managerProfileSnapshot(original, { name: 'Ada', personality: 'Use short clear replies.', picture: png, voice: 'maple' });
  assert.ok(snapshot.text.startsWith(original + '\n\n'));
  assert.match(snapshot.text, /Manager name: "Ada"/); assert.match(snapshot.text, /Use short clear replies/);
  assert.doesNotMatch(snapshot.text, /base64|maple/);
});


test('identity-only save preserves pending legacy voice migration; explicit Codex default stays authoritative', async t => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'crew-profile-voice-migration-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const store = createManagerProfile({ stateDir, projectId: 'migration' });
  let profile = await store.save({ name: 'Ada', expectedVersion: (await store.read()).version });
  assert.equal(profile.configured, false);
  assert.equal((await createManagerProfile({ stateDir, projectId: 'migration' }).read()).configured, false);
  profile = await store.save({ voice: 'maple', expectedVersion: profile.version });
  assert.equal(profile.name, 'Ada'); assert.equal(profile.configured, true);
  profile = await store.save({ voice: null, expectedVersion: profile.version });
  assert.equal(profile.configured, true);
  assert.equal((await store.read()).configured, true);
});
