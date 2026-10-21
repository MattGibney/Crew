// Original, locally synthesized earcons. No network, media input or model work.
export const CUES = {
  connected: [[523, 0, .09], [784, .11, .14]],
  ended: [[659, 0, .09], [440, .11, .14]],
  muted: [[440, 0, .07], [330, .09, .09]],
  unmuted: [[330, 0, .07], [440, .09, .09]],
  attention: [[880, 0, .12], [1175, .17, .18]],
};

export function createSounds({ context = () => new AudioContext(), onUnavailable = () => {} } = {}) {
  let audio, disposed = false;
  const nodes = new Set();
  function unlock() {
    if (disposed) return;
    try {
      audio ||= context();
      void audio.resume().then(() => onUnavailable(audio.state !== 'running')).catch(() => onUnavailable(true));
    } catch { onUnavailable(true); }
  }
  function play(kind) {
    if (disposed || !CUES[kind]) return;
    try {
      audio ||= context();
      // Never queue stale sounds behind browser autoplay permission.
      if (audio.state !== 'running') { onUnavailable(true); return; }
      onUnavailable(false);
      const now = audio.currentTime;
      for (const [frequency, offset, duration] of CUES[kind]) {
        const oscillator = audio.createOscillator(), gain = audio.createGain();
        nodes.add(oscillator); nodes.add(gain);
        oscillator.type = 'sine'; oscillator.frequency.value = frequency;
        const start = now + offset;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(.075, start + .012);
        gain.gain.exponentialRampToValueAtTime(.001, start + duration);
        oscillator.connect(gain); gain.connect(audio.destination);
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); nodes.delete(oscillator); nodes.delete(gain); };
        oscillator.start(start); oscillator.stop(start + duration + .01);
      }
    } catch { onUnavailable(true); }
  }
  return { unlock, play, dispose() {
    disposed = true;
    for (const node of nodes) { try { node.stop?.(); node.disconnect(); } catch { /* Already ended. */ } }
    nodes.clear();
    if (audio) void audio.close().catch(() => {});
  } };
}

// Per-call state, independent of repeated WebRTC and input callbacks.
export function createCallCues(play) {
  let active = false, transmitting = false, requested = false;
  return {
    connected() { if (!active) { active = true; play('connected'); } },
    ended() { if (active) { active = false; play('ended'); } transmitting = requested = false; },
    requestInput() { requested = true; },
    input(value, pending = false) {
      if (pending) return;
      if (active && value !== transmitting && requested) play(value ? 'unmuted' : 'muted');
      transmitting = value;
      requested = false;
    },
    cancelInput() { requested = false; },
  };
}
