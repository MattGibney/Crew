import test from 'node:test';
import assert from 'node:assert/strict';
import { instanceKey, summarizeTasks, isAppURL, isExternalHTTPS, permitsAudio, childEnvironment } from '../desktop/lifecycle.mjs';
test('desktop identity is scoped by instance config, not global project identity', () => {
  assert.equal(instanceKey('/tmp/project-a/../project-a/config.json'), instanceKey('/tmp/project-a/config.json'));
  assert.notEqual(instanceKey('/tmp/project-a/config.json'), instanceKey('/tmp/project-b/config.json'));
});
test('tray shows real unacknowledged attention and active work, including paused tasks', () => {
  assert.deepEqual(summarizeTasks({ tasks:[{ status:'awaiting_answer', attention:[{ id:'question' }] }, { status:'completed', attention:[{ id:'old', ackedAt:'now' }, { id:'result' }] }, { status:'running' }, { status:'failed' }] }), { active:2, pending:2 });
  assert.deepEqual(summarizeTasks(null), { active:null, pending:null });
  assert.deepEqual(summarizeTasks({ tasks:[], error:'Controller state unavailable' }), { active:null, pending:null });
  assert.deepEqual(summarizeTasks({tasks:[{status:'disposed',attention:[{id:'retained-result'}]},{status:'removed',attention:[{id:'legacy-result'}]},{status:'stopped',attention:[{id:'failed-cleanup'}]}]}),{active:0,pending:1});
});
test('desktop navigation and mic permission are exact-origin and audio-only', () => {
  const origin = 'http://127.0.0.1:4320';
  assert.equal(isAppURL(`${origin}/`, origin), true);
  for (const url of ['http://127.0.0.1:4321', 'http://localhost:4320', 'https://example.com', 'file:///tmp/test', 'http://user@127.0.0.1:4320']) assert.equal(isAppURL(url, origin), false);
  assert.equal(permitsAudio('media', { requestingUrl:origin, mediaTypes:['audio'] }, origin), true);
  assert.equal(permitsAudio('media', { securityOrigin:origin, mediaType:'audio' }, origin), true);
  for (const details of [{ requestingUrl:origin, mediaTypes:['audio', 'video'] }, { requestingUrl:origin, mediaTypes:[] }, { requestingUrl:origin }, { requestingUrl:'http://localhost:4320', mediaTypes:['audio'] }]) assert.equal(permitsAudio('media', details, origin), false);
  assert.equal(permitsAudio('notifications', { requestingUrl:origin, mediaTypes:['audio'] }, origin), false);
});
test('backend uses bundled runtime without an API fallback and preserves ordinary config', () => {
  const env = childEnvironment('/tmp/instance/config.json', { PATH:'/usr/bin', OPENAI_API_KEY:'fixture', CODEX_API_KEY:'fixture', OPENAI_BASE_URL:'fixture', CODEX_HOME:'/tmp/codex' });
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(env.AI_MANAGER_CONFIG, '/tmp/instance/config.json');
  assert.equal(env.CODEX_HOME, '/tmp/codex');
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL']) assert.equal(key in env, false);
  assert.ok(env.PATH.includes('/opt/homebrew/bin'));
});

test('connector links can open HTTPS in system browser without credentials or unsafe schemes', () => {
  assert.equal(isExternalHTTPS('https://example.com/verify?code=test'), true);
  for (const url of ['http://example.com', 'https://user:password@example.com', 'javascript:alert(1)', 'file:///tmp/test', 'codex://anything', 'bad url']) assert.equal(isExternalHTTPS(url), false);
});


test('native clipboard writes accept plain bounded text only', async () => {
 const {clipboardText}=await import('../desktop/clipboard.mjs');
 assert.equal(clipboardText('const value = 1;\n'),'const value = 1;\n');
 for(const value of [null,42,{},'x'.repeat(1000001)])assert.throws(()=>clipboardText(value));
});
