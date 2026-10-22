import test from 'node:test';
import assert from 'node:assert/strict';
import { setDraftPath } from './draft.ts';

test('declared optional setup fields remain editable in retained legacy configurations', () => {
 const retained = { runtime: {}, project: { worker: {}, linear: {}, prompts: {} } };
 setDraftPath(retained, ['project', 'worker', 'maxConcurrent'], '2');
 setDraftPath(retained, ['runtime', 'codexBinary'], '/configured/codex');
 assert.equal(retained.project.worker.maxConcurrent, '2');
 assert.equal(retained.runtime.codexBinary, '/configured/codex');
 assert.throws(() => setDraftPath(retained, ['project', 'unrecognized'], true), /Unknown configuration field/);
 assert.throws(() => setDraftPath(retained, ['__proto__', 'polluted'], true), /Unknown configuration field/);
 assert.equal({}.polluted, undefined);
});
