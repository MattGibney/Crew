import test from 'node:test';
import assert from 'node:assert/strict';
import { readDraft, writeDraft } from './draft-storage.js';
const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
};
test('drafts survive reload and remain isolated to each project storage partition', () => {
  const first = storage(), second = storage();
  writeDraft(first, 'An unfinished first-project task');
  writeDraft(second, 'A different project');
  assert.equal(readDraft(first), 'An unfinished first-project task');
  assert.equal(readDraft(second), 'A different project');
  writeDraft(first, '');
  assert.equal(readDraft(first), '');
  assert.equal(readDraft(second), 'A different project');
});
test('unavailable storage keeps the composer usable and oversized drafts are bounded', () => {
  const blocked = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); }, removeItem() { throw Error('blocked'); } };
  assert.equal(readDraft(blocked), '');
  assert.doesNotThrow(() => writeDraft(blocked, 'draft'));
  assert.doesNotThrow(() => writeDraft(blocked, ''));
  const project = storage(); writeDraft(project, 'x'.repeat(9000)); assert.equal(readDraft(project).length, 8000);
});
