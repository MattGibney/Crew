import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ProjectSkillStore } from '../src/skills/index.mts';

const markdown = (body, name = 'project-review') =>
  `---\nname: ${name}\ndescription: Review the agreed project work.\n---\n\n${body}\n`;

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'crew-project-skills-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, 'repository');
  const personal = join(root, 'personal-codex');
  await Promise.all([
    mkdir(join(repository, '.git'), { recursive: true }),
    mkdir(personal),
  ]);
  const options = projectId => ({
    projectId,
    directory: join(root, 'crew', projectId, 'skills'),
    forbiddenRoots: [repository, personal],
  });
  return { root, repository, personal, options, open: projectId => ProjectSkillStore.open(options(projectId)) };
}

test('selected native skill and resources retain their exact revision after a later save and reopen', async t => {
  const f = await fixture(t);
  const store = await f.open('project-a');
  const original = await store.create({
    markdown: markdown('Use the original review instructions.'),
    resources: [{ path: 'references/checklist.md', content: 'Original checklist.\n' }],
  });
  const selected = await store.resolveSelected([original.skill]);
  const originalPath = (await store.resolve(original.skill.id, original.skill.revision)).nativePath;
  assert.equal(selected.skills[0].nativePath, originalPath);

  const updated = await store.update({
    skillId: original.skill.id,
    expectedRevision: original.skill.revision,
    markdown: markdown('Use the updated review instructions.'),
    resources: [{ path: 'references/checklist.md', content: 'Updated checklist.\n' }],
  });
  const reopened = await f.open('project-a');
  assert.deepEqual(await reopened.list(), [updated.skill]);
  assert.deepEqual(await reopened.read(original.skill.id), updated);
  assert.deepEqual(await reopened.resolveSelected([original.skill]), selected);
  assert.equal((await reopened.resolve(original.skill.id, original.skill.revision)).nativePath, originalPath);
  assert.equal(await readFile(originalPath, 'utf8'), original.markdown);
  assert.equal(await readFile(join(dirname(originalPath), 'references/checklist.md'), 'utf8'), 'Original checklist.\n');
  const currentPath = (await reopened.resolve(updated.skill.id, updated.skill.revision)).nativePath;
  assert.notEqual(currentPath, originalPath);
  assert.equal(await readFile(currentPath, 'utf8'), updated.markdown);
  assert.equal(await readFile(join(dirname(currentPath), 'references/checklist.md'), 'utf8'), 'Updated checklist.\n');
});

test('concurrent editors cannot overwrite the winner with a stale revision', async t => {
  const f = await fixture(t);
  const first = await f.open('project-a');
  const original = await first.create({
    markdown: markdown('Initial instructions.'),
    resources: [{ path: 'references/checklist.md', content: 'Retain this resource.\n' }],
  });
  const second = await f.open('project-a');
  const results = await Promise.allSettled([first, second].map((store, index) => store.update({
    skillId: original.skill.id,
    expectedRevision: original.skill.revision,
    markdown: markdown(`Editor ${index + 1} instructions.`),
  })));
  const winners = results.filter(result => result.status === 'fulfilled');
  const conflicts = results.filter(result => result.status === 'rejected');
  assert.equal(winners.length, 1);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reason.code, 'conflict');
  const saved = winners[0].value;
  assert.equal(saved.skill.revision, original.skill.revision + 1);
  assert.deepEqual(saved.resources, original.resources);
  await assert.rejects(second.update({
    skillId: original.skill.id,
    expectedRevision: original.skill.revision,
    markdown: markdown('A late stale save must not win.'),
  }), { code: 'conflict' });
  assert.deepEqual(await first.read(original.skill.id), saved);
  assert.deepEqual(await second.read(original.skill.id), saved);
});

test('project identities isolate stores and reject foreign selected skill roots', async t => {
  const f = await fixture(t);
  const first = await f.open('project-a');
  const second = await f.open('project-b');
  const a = await first.create({ markdown: markdown('Project A instructions.') });
  const b = await second.create({ markdown: markdown('Project B instructions.') });
  assert.notEqual(a.skill.id, b.skill.id);
  assert.deepEqual(await first.list(), [a.skill]);
  assert.deepEqual(await second.list(), [b.skill]);
  await assert.rejects(ProjectSkillStore.open({ ...f.options('project-a'), projectId: 'project-b' }), { code: 'unsafe_store' });
  await assert.rejects(first.read(b.skill.id), { code: 'missing' });
  await assert.rejects(first.resolve(b.skill.id, b.skill.revision), { code: 'missing' });
  await assert.rejects(first.resolveSelected([b.skill]), { code: 'unsafe_store' });
  await assert.rejects(second.resolveSelected([a.skill]), { code: 'unsafe_store' });
  assert.deepEqual(await first.read(a.skill.id), a);
  assert.deepEqual(await second.read(b.skill.id), b);
});

test('repository and supplied personal roots cannot become Crew skill stores, including aliases', async t => {
  const f = await fixture(t);
  const marker = join(f.personal, 'untouched.txt');
  await writeFile(marker, 'Personal fixture remains unchanged.\n');
  await assert.rejects(ProjectSkillStore.open({
    ...f.options('project-a'), directory: join(f.repository, 'skills'), forbiddenRoots: [],
  }), { code: 'unsafe_store' });
  await assert.rejects(ProjectSkillStore.open({
    ...f.options('project-a'), directory: join(f.personal, 'skills'),
  }), { code: 'unsafe_store' });
  const alias = join(f.root, 'personal-alias');
  await symlink(f.personal, alias, 'dir');
  await assert.rejects(ProjectSkillStore.open({
    ...f.options('project-a'), directory: join(alias, 'skills'),
  }), { code: 'unsafe_store' });
  assert.equal(await readFile(marker, 'utf8'), 'Personal fixture remains unchanged.\n');
});

test('unsafe resource paths and a substituted resource symlink fail without exposing or modifying its target', async t => {
  const f = await fixture(t);
  const store = await f.open('project-a');
  for (const path of ['../escape.md', '/absolute.md', 'references/../../escape.md', 'references\\escape.md']) {
    await assert.rejects(store.create({
      markdown: markdown('Invalid resources must not be saved.'),
      resources: [{ path, content: 'Must not escape the skill.' }],
    }), { code: 'invalid' });
  }
  assert.deepEqual(await store.list(), []);
  const original = await store.create({
    markdown: markdown('Keep resources within this skill.'),
    resources: [{ path: 'references/checklist.md', content: 'Original resource.\n' }],
  });
  const { nativePath } = await store.resolve(original.skill.id, original.skill.revision);
  const outside = join(f.root, 'outside.txt');
  await writeFile(outside, 'Outside data must remain untouched.\n');
  const resource = join(dirname(nativePath), 'references/checklist.md');
  await unlink(resource);
  await symlink(outside, resource, 'file');
  await assert.rejects(store.read(original.skill.id), { code: 'unsafe_store' });
  await assert.rejects(store.resolve(original.skill.id, original.skill.revision), { code: 'unsafe_store' });
  await assert.rejects(store.update({
    skillId: original.skill.id,
    expectedRevision: original.skill.revision,
    markdown: markdown('Do not retain the substituted resource.'),
  }), { code: 'unsafe_store' });
  assert.deepEqual(await store.list(), [original.skill]);
  assert.equal(await readFile(outside, 'utf8'), 'Outside data must remain untouched.\n');
});
