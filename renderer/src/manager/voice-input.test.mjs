import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceInput, isTalkShortcut, voiceActivityEvent } from './voice-input.ts';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(acquireOverride) {
  const track = { enabled: true, stopped: 0, stop() { this.stopped++; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const changes = [], errors = [], attachments = []; let captures = 0;
  const input = createVoiceInput({ acquire: () => { captures++; return acquireOverride?.() || Promise.resolve(stream); }, onChange: value => changes.push(value), onError: error => errors.push(error) });
  const sender = { replaceTrack: async value => { attachments.push(value); } };
  return { input, sender, track, stream, changes, errors, attachments, captures: () => captures };
}
test('no capture until explicit input start; holding only acquires once and release stops immediately', async () => {
  const f = fixture(); assert.equal(f.captures(), 0);
  await f.input.start(f.sender); await f.input.start(f.sender);
  assert.equal(f.captures(), 1); assert.equal(f.track.enabled, true);
  f.input.stop(); assert.equal(f.track.enabled, false); assert.equal(f.track.stopped, 1);
  assert.equal(f.changes.at(-1).transmitting, false); assert.equal(f.input.stream, null);
});
test('release while microphone permission is pending discards the late stream', async () => {
  const permission = deferred(), f = fixture(() => permission.promise);
  const start = f.input.start(f.sender); f.input.stop(); permission.resolve(f.stream); await start;
  assert.equal(f.track.enabled, false); assert.equal(f.track.stopped, 1);
  assert.ok(!f.attachments.includes(f.track)); assert.ok(!f.changes.some(value => value.transmitting));
});
test('release during sender replacement never enables stale microphone', async () => {
  const attachment = deferred(), f = fixture(); f.sender.replaceTrack = () => attachment.promise;
  const start = f.input.start(f.sender); await new Promise(resolve => setImmediate(resolve));
  f.input.stop(); attachment.resolve(); await start;
  assert.equal(f.track.enabled, false); assert.ok(!f.changes.some(value => value.transmitting));
});
test('new hold cannot be overwritten by the previous pending permission result', async () => {
  const first = deferred(), second = deferred(); let calls = 0;
  const f = fixture(() => ++calls === 1 ? first.promise : second.promise);
  const oldTrack = { enabled: true, stop() { this.enabled = false; } };
  const oldStream = { getTracks: () => [oldTrack], getAudioTracks: () => [oldTrack] };
  const old = f.input.start(f.sender); f.input.stop(); const current = f.input.start(f.sender);
  second.resolve(f.stream); await current; first.resolve(oldStream); await old;
  assert.equal(f.input.stream, f.stream); assert.equal(f.track.enabled, true); assert.equal(oldTrack.enabled, false);
});
test('permission denial reports an actionable error and permits retry', async () => {
  let deny = true; const f = fixture(() => { if (deny) return Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })); });
  await f.input.start(f.sender); assert.equal(f.errors[0].name, 'NotAllowedError'); assert.equal(f.input.pending, false);
  deny = false; await f.input.start(f.sender); assert.equal(f.track.enabled, true); f.input.reset(); assert.equal(f.input.stream, null);
});
test('keyboard hold ignores editable contexts, composition, repeat and modified keys', () => {
  const basic = { code: 'Space', target: { closest: selector => selector.includes('input') ? {} : null } };
  assert.equal(isTalkShortcut(basic), false);
  const body = { code: 'Space', target: { closest: () => null } }; assert.equal(isTalkShortcut(body), true);
  for (const option of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { code: 'Enter' }]) assert.equal(isTalkShortcut({ ...body, ...option }), false);
});
test('activity labels require observed transport events and do not infer audio from transcripts', () => {
  assert.equal(voiceActivityEvent('output_audio_buffer.started'), 'speaking');
  assert.equal(voiceActivityEvent('output_audio_buffer.stopped'), 'ready');
  assert.equal(voiceActivityEvent('input_audio_buffer.speech_stopped'), 'processing');
  assert.equal(voiceActivityEvent('response.audio_transcript.delta'), null);
});
test('device disconnection stops input and reports the loss without automatic recapture', async () => {
  const f = fixture(); await f.input.start(f.sender); f.track.onended();
  assert.equal(f.input.stream, null); assert.equal(f.track.enabled, false);
  assert.match(f.errors[0].message, /Microphone disconnected/); assert.equal(f.captures(), 1);
});
test('failed attachment releases the acquired track and a later explicit start can retry', async () => {
  const f = fixture(); let attempts = 0;
  f.sender.replaceTrack = async track => { if (track && ++attempts === 1) throw new Error('attachment failed'); };
  await f.input.start(f.sender); assert.equal(f.track.enabled, false); assert.equal(f.input.stream, null);
  assert.match(f.errors[0].message, /attachment failed/); await f.input.start(f.sender); assert.equal(f.track.enabled, true);
  f.input.reset();
});
test('input release restores synthetic silence while stopping the microphone; session reset detaches transport', async () => {
  const microphone = { enabled: true, readyState: 'live', stop() { this.readyState = 'ended'; } };
  const silence = { readyState: 'live' }, attachments = [];
  const sender = { replaceTrack: async track => attachments.push(track) };
  const input = createVoiceInput({ acquire: async () => ({ getTracks: () => [microphone], getAudioTracks: () => [microphone] }), idleTrack: () => silence, onChange: () => {}, onError: error => { throw error; } });
  await input.start(sender); input.stop(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(microphone.enabled, false); assert.equal(microphone.readyState, 'ended'); assert.equal(attachments.at(-1), silence);
  input.reset(); await new Promise(resolve => setImmediate(resolve)); assert.equal(attachments.at(-1), null);
});
