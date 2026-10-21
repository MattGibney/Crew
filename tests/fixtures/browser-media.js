// Test-only synthetic media. Loaded before the genuine renderer by browser-fixture.mjs.
// Never requests physical microphone permission or connects to a remote service.
(() => {
  const nativeFetch = window.fetch.bind(window);
  const proof = window.__crewMedia = { calls: 0, stopped: 0, tracks: [], peers: [], pending: [], delayed: false, denyNext: false, silentTracks: [], contexts: [] };
  const report = () => void nativeFetch('/__telemetry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ calls: proof.calls, stopped: proof.stopped, tracks: proof.tracks.map(({ enabled, readyState }) => ({ enabled, readyState })), silentTracks: proof.silentTracks.map(({ readyState }) => ({ readyState })), contexts: proof.contexts.map(context => ({ state: context.state })), peers: proof.peers.map(peer => ({ state: peer.connectionState, attached: Boolean(peer.sender.track), source: peer.sender.track?.source || null, enabled: peer.sender.track?.enabled ?? null })) }) });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => {
    proof.calls++;
    if (proof.denyNext) { proof.denyNext = false; report(); throw new DOMException('Synthetic permission denied', 'NotAllowedError'); }
    const track = { source: 'microphone', kind: 'audio', enabled: true, readyState: 'live', stop() { if (this.readyState !== 'ended') proof.stopped++; this.readyState = 'ended'; report(); } };
    proof.tracks.push(track);
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
    report();
    if (proof.delayed) return new Promise(resolve => proof.pending.push(() => resolve(stream)));
    return stream;
  } } });
  window.AudioContext = class {
    constructor() { this.state = 'suspended'; proof.contexts.push(this); report(); }
    createMediaStreamDestination() {
      const track = { source: 'generated-silence', kind: 'audio', enabled: true, readyState: 'live', stop() { this.readyState = 'ended'; report(); } };
      proof.silentTracks.push(track);
      return { stream: { getTracks: () => [track], getAudioTracks: () => [track] } };
    }
    createConstantSource() { return { offset: { value: 0 }, connect() {}, start() {}, stop() {}, disconnect() {} }; }
    async resume() { this.state = 'running'; report(); }
    async close() { this.state = 'closed'; report(); }
  };
  window.RTCPeerConnection = class {
    constructor() { this.connectionState = 'new'; this.iceConnectionState = 'new'; this.sender = { track: null, replaceTrack: async track => { this.sender.track = track; setTimeout(report, 0); } }; proof.peers.push(this); report(); }
    addTransceiver(track) { this.sender.track = typeof track === 'object' ? track : null; report(); return { sender: this.sender }; }
    createDataChannel() { return this.channel = { readyState: 'open' }; }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\nsynthetic-offer' }; }
    async setLocalDescription(value) { this.localDescription = value; }
    async setRemoteDescription() { this.connectionState = this.iceConnectionState = 'connected'; queueMicrotask(() => { this.onconnectionstatechange?.(); report(); }); }
    async getStats() { return new Map(); }
    close() { this.connectionState = 'closed'; report(); }
  };
  const commands = new EventSource('/__media-events');
  commands.onmessage = event => {
    const command = JSON.parse(event.data);
    if ('delayed' in command) proof.delayed = command.delayed;
    if (command.denyNext) proof.denyNext = true;
    if (command.resolve) { proof.pending.splice(0).forEach(resolve => resolve()); }
    if (command.voiceEvent) proof.peers.at(-1)?.channel?.onmessage?.({ data: JSON.stringify({ type: command.voiceEvent }) });
    if (command.reconnectEvent) proof.peers.at(-1)?.onconnectionstatechange?.();
    report();
  };
  window.addEventListener('pagehide', () => commands.close());
  report();
})();
