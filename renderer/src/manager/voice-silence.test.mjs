import test from 'node:test';
import assert from 'node:assert/strict';
import { createSilentAudio } from './voice-silence.js';
function fixture({ failResume = false, failStart = false } = {}) {
  const calls = []; const track = { readyState: 'live', stop() { calls.push('track.stop'); this.readyState = 'ended'; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const destination = { stream }, source = { offset: { value: 1 }, connect(target) { assert.equal(target, destination); calls.push('source.connect'); }, start() { calls.push('source.start'); if (failStart) throw Error('start failed'); }, stop() { calls.push('source.stop'); }, disconnect() { calls.push('source.disconnect'); } };
  class Context {
    state = 'suspended';
    constructor(options) { assert.equal(options.sampleRate, 48000); calls.push('context.new'); }
    createMediaStreamDestination() { return destination; }
    createConstantSource() { return source; }
    async resume() { calls.push('context.resume'); if (failResume) throw Error('resume failed'); this.state = 'running'; }
    async close() { calls.push('context.close'); this.state = 'closed'; }
  }
  return { Context, calls, track, stream, source };
}
test('explicit silent transport generates only zeros, routes only to stream and disposes every resource once', async () => {
  const f = fixture(); const audio = createSilentAudio(f.Context); await audio.ready;
  assert.equal(f.source.offset.value, 0); assert.equal(audio.track, f.track); assert.equal(audio.stream, f.stream);
  audio.dispose(); audio.dispose();
  for (const event of ['source.stop', 'source.disconnect', 'track.stop', 'context.close']) assert.equal(f.calls.filter(value => value === event).length, 1);
});
test('partial silent graph initialization failure disposes context and created track', () => {
  const f = fixture({ failStart: true }); assert.throws(() => createSilentAudio(f.Context), /start failed/);
  assert.equal(f.track.readyState, 'ended'); assert.ok(f.calls.includes('context.close'));
});
test('audio resume rejection remains observable and caller can release resources', async () => {
  const f = fixture({ failResume: true }); const audio = createSilentAudio(f.Context);
  await assert.rejects(audio.ready, /resume failed/); audio.dispose(); assert.equal(f.track.readyState, 'ended');
});
test('missing Web Audio support fails clearly without microphone fallback', () => {
  assert.throws(() => createSilentAudio(null), /does not support the audio transport/);
});
