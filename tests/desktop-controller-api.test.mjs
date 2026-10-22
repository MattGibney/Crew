import test from 'node:test';
import assert from 'node:assert/strict';
import { parseControllerReply } from '../runtime/desktop/controller-api.mjs';

test('native controller decoding preserves unavailable error and live attention correlation', () => {
  const tasks = [{id:'task-one', runId:'run-one', status:'awaiting_answer', question:{id:'q-one',runId:'run-one'}, attention:[{id:'question'}]}];
  const result = parseControllerReply({error:null, tasks, requests:[], voiceActive:false});
  assert.equal(result.error, null);
  assert.equal(result.tasks[0].id, 'task-one');
  assert.deepEqual(result.tasks[0].question, tasks[0].question);
  assert.equal(result.tasks[0].attention[0].ackedAt, null);
  assert.equal(result.voiceActive, false);
});

test('native lifecycle decoder rejects malformed controller fields before update or attention consumers', () => {
  for (const value of [null, [], {error:12}, {tasks:{}}, {tasks:[{status:null}]}, {requests:{}}, {voiceActive:'yes'}, {reserved:'yes'}, {notices:['ok',12]}, {plan:{id:'plan',consent:true}}]) {
    assert.throws(() => parseControllerReply(value));
  }
  const reply = parseControllerReply({plan:{id:'plan',kind:'pause-update',consent:true,phase:'ready',targetVersion:'0.14.0'},reserved:true});
  assert.equal(reply.plan.phase, 'ready');
  assert.equal(reply.reserved,true);
});
