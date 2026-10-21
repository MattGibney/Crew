// A held gesture owns one capture request. Ending it invalidates pending permission
// and stops tracks immediately, including while replaceTrack is still settling.
export function createVoiceInput({ acquire, onChange, onError, idleTrack = () => null }) {
  let generation = 0, stream = null, sender = null, pending = false, requested = false;
  let replacement = Promise.resolve();
  const replace = (target, track) => {
    replacement = replacement.catch(() => {}).then(() => target.replaceTrack(track));
    return replacement;
  };
  const stopTracks = value => value?.getTracks().forEach(track => { track.enabled = false; track.stop(); });
  function stop(detach = false) {
    generation++; requested = false; pending = false;
    stopTracks(stream); stream = null;
    const idle = detach === true ? null : idleTrack();
    if (sender) void replace(sender, idle?.readyState === 'ended' ? null : idle).catch(() => {});
    onChange({ transmitting: false, inputPending: false });
  }
  async function start(target) {
    if (!target || requested) return;
    const attempt = ++generation;
    sender = target; requested = true; pending = true;
    onChange({ transmitting: false, inputPending: true, inputError: '' });
    let acquired;
    try {
      acquired = await acquire();
      if (attempt !== generation || !requested) { stopTracks(acquired); return; }
      const track = acquired.getAudioTracks()[0];
      if (!track) throw new Error('No microphone was found.');
      // Never transmit while attachment is pending or after the gesture ended.
      track.enabled = false; stream = acquired;
      await replace(target, track);
      if (attempt !== generation || !requested) { stopTracks(acquired); return; }
      pending = false; track.enabled = true;
      track.onended = () => {
        if (attempt !== generation) return;
        stop(); onError(new Error('Microphone disconnected. Choose Start microphone or hold to talk again.'));
      };
      onChange({ transmitting: true, inputPending: false });
    } catch (error) {
      stopTracks(acquired);
      if (attempt !== generation) return;
      stop(); onError(error);
    }
  }
  return { start, stop, reset() { stop(true); sender = null; }, get stream() { return stream; }, get pending() { return pending; } };
}

export function isTalkShortcut(event) {
  if (event.code !== 'Space' || event.repeat || event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  const target = event.target;
  if (target?.closest?.('[data-push-to-talk]')) return true;
  return !target?.closest?.('input, textarea, select, button, summary, a, audio, video, [role="button"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="slider"], [role="dialog"], [role="menu"]');
}

// Observe transport events only; never send invented user or handoff messages.
export function voiceActivityEvent(type) {
  if (type === 'output_audio_buffer.started') return 'speaking';
  if (['output_audio_buffer.stopped', 'output_audio_buffer.cleared', 'response.done', 'response.cancelled'].includes(type)) return 'ready';
  if (type === 'input_audio_buffer.speech_started') return 'listening';
  if (type === 'input_audio_buffer.speech_stopped' || type === 'response.created') return 'processing';
  return null;
}
