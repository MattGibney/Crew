import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText } from './api.js';
import { createVoiceInput, voiceActivityEvent } from './voice-input.js';
import { createSilentAudio } from './voice-silence.js';
import { createCallCues } from './sounds.js';

// Media resources belong to this hook, never to a worker or an SSE notification.
export function useVoiceSession(onError, sounds) {
  const audioRef = useRef(null);
  const cues = useRef(null);
  if (!cues.current) cues.current = createCallCues(kind => sounds.play(kind));
  const resource = useRef({ generation: 0, pc: null, stream: null, channel: null, busy: false, disconnecting: false });
  // User mute intent survives call teardown; track availability is not intent.
  const openMicWanted = useRef(true);
  const [view, setView] = useState({ busy: false, allocated: false, active: false, disconnecting: false, muted: true, transmitting: false, inputPending: false, inputError: '', playbackBlocked: false, activity: 'ready', status: 'Ready when you are. Microphone off.' });
  const onErrorRef = useRef(onError); onErrorRef.current = onError;
  const patch = useCallback(value => setView(previous => ({ ...previous, ...value })), []);
  const reportError = useCallback(error => onErrorRef.current(errorText(error)), []);
  const input = useRef(null);
  if (!input.current) input.current = createVoiceInput({
    acquire: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }),
    idleTrack: () => resource.current.silence?.track || null,
    onChange: value => { cues.current.input(value.transmitting, value.inputPending); patch({ ...value, muted: !value.transmitting }); },
    onError: error => {
      const message = error.name === 'NotAllowedError' ? 'Microphone permission was denied. Allow microphone access in system or browser settings, then try again.' : errorText(error);
      patch({ inputError: message });
    },
  });
  const stopInput = useCallback(() => input.current.stop(), []);
  const startInput = useCallback(() => {
    const state = resource.current;
    if (state.pc?.connectionState !== 'connected' || state.busy || state.disconnecting) return;
    void input.current.start(state.sender);
  }, []);
  const release = useCallback(() => {
    const state = resource.current;
    cues.current.ended();
    clearTimeout(state.timer); clearInterval(state.diagnosticsTimer);
    input.current.reset();
    state.timer = null; state.diagnosticsTimer = null;
    if (state.channel) state.channel.onmessage = null;
    if (state.pc) { state.pc.onconnectionstatechange = null; state.pc.ontrack = null; state.pc.close(); }
    state.silence?.dispose(); state.silence = null;
    state.pc = null; state.stream = null; state.channel = null; state.sender = null;
    if (audioRef.current) audioRef.current.srcObject = null;
    state.playbackError = null;
    patch({ allocated: false, active: false, muted: true, playbackBlocked: false, activity: 'ready' });
  }, [patch]);
  const dispose = useCallback(() => {
    const state = resource.current;
    state.generation++; state.busy = state.disconnecting; release(); patch({ busy: state.disconnecting });
  }, [release, patch]);
  useEffect(() => () => { dispose(); }, [dispose]);
  const disconnect = useCallback(async (message = 'Disconnected. Microphone off.') => {
    const state = resource.current;
    if (state.disconnecting) return;
    state.disconnecting = true; state.generation++; release(); state.busy = true; patch({ busy: true, disconnecting: true, status: 'Ending call. Microphone off.' });
    try { await api('disconnect'); } catch (error) { reportError(error); }
    finally { state.busy = false; state.disconnecting = false; patch({ busy: false, disconnecting: false, status: message }); }
  }, [release, patch, reportError]);
  const transportLost = useCallback(() => {
    const state = resource.current, hadVoice = Boolean(state.pc || state.busy);
    dispose();
    patch({ status: hadVoice ? 'Bridge connection lost. Microphone off.' : 'Live connection unavailable. Keep one browser tab open, then refresh. Microphone off.' });
  }, [dispose, patch]);
  const handleEvent = useCallback(message => {
    const state = resource.current;
    if(message.type==='update-plan-state'&&message.plan&&message.plan.phase!=='complete'){dispose();patch({status:'Voice disconnected for the update. Microphone off.'});return;}
    if (state.disconnecting || (!state.pc && !state.busy)) return;
    if (message.type === 'error') { reportError(message.message); void disconnect('Voice error. Microphone off.'); }
    if (message.type === 'closed') void disconnect('Voice session ended. Microphone off.');
  }, [disconnect, reportError, dispose, patch]);
  const resumePlayback = useCallback(async () => {
    const state = resource.current, generation = state.generation, audio = audioRef.current;
    if (!state.pc || !audio) return;
    try {
      await audio.play();
      if (state.generation !== generation || !state.pc) return;
      state.playbackError = null; patch({ playbackBlocked: false });
    } catch (error) {
      if (state.generation !== generation || !state.pc) return;
      state.playbackError = error.name || 'Playback failed'; patch({ playbackBlocked: true });
    }
  }, [patch]);
  const connect = useCallback(async selectedVoice => {
    const state = resource.current;
    if (state.busy || state.disconnecting || state.pc || !selectedVoice) return;
    sounds.unlock();
    state.busy = true; state.playbackError = null;
    const attempt = ++state.generation;
    patch({ busy: true, inputError: '', status: openMicWanted.current ? 'Connecting voice and microphone…' : 'Connecting voice. Microphone muted…' });
    try {
      // Start a real audio transport with locally generated silence, not a mic.
      // A trackless offer connects but native voice may wait for incoming RTP.
      // Connect authorizes open-mic capture after connection unless explicitly muted.
      const connection = new RTCPeerConnection(); state.pc = connection;
      state.silence = createSilentAudio();
      state.sender = connection.addTransceiver(state.silence.track, { direction: 'sendrecv', streams: [state.silence.stream] }).sender;
      patch({ allocated: true });
      await state.silence.ready;
      if (attempt !== state.generation || state.pc !== connection) return;
      let sessionToken, greetingRequested = false, inputAttempted = false;
      const current = () => state.pc === connection && state.generation === attempt;
      const reportAudioStatus = async () => {
        if (!current() || !sessionToken) return;
        try {
          const stats = await connection.getStats();
          if (!current()) return;
          const local = input.current.stream?.getAudioTracks()[0], audio = audioRef.current;
          if (!audio) return;
          const snapshot = { inputSource: local ? 'microphone' : state.silence ? 'silence' : 'none', connection: connection.connectionState, ice: connection.iceConnectionState, channel: state.channel?.readyState || null, localTrack: local?.readyState || null, localEnabled: local?.enabled ?? null, localMuted: local?.muted ?? null, remoteTrack: audio.srcObject?.getAudioTracks()[0]?.readyState || null, audioPaused: audio.paused, audioMuted: audio.muted, audioVolume: audio.volume, audioReady: audio.readyState, playbackError: state.playbackError, packetsSent: null, packetsReceived: null, bytesSent: null, bytesReceived: null, inputEnergy: null };
          stats.forEach(item => {
            if (item.kind !== 'audio' && item.mediaType !== 'audio') return;
            if (item.type === 'outbound-rtp') { snapshot.packetsSent = item.packetsSent ?? null; snapshot.bytesSent = item.bytesSent ?? null; }
            if (item.type === 'inbound-rtp') { snapshot.packetsReceived = item.packetsReceived ?? null; snapshot.bytesReceived = item.bytesReceived ?? null; }
            if (item.type === 'media-source' && local && item.trackIdentifier === local.id) snapshot.inputEnergy = item.totalAudioEnergy ?? null;
          });
          await api('voice-status', { sessionToken, status: snapshot });
        } catch { /* Diagnostics cannot stop a functioning call. */ }
      };
      connection.ontrack = event => {
        if (!current() || !audioRef.current) return;
        const audio = audioRef.current;
        audio.srcObject = event.streams[0] || new MediaStream([event.track]);
        void resumePlayback();
      };
      connection.onconnectionstatechange = () => {
        if (!current()) return;
        if (connection.connectionState === 'connected') {
          clearTimeout(state.timer); state.busy = false;
          cues.current.connected();
          patch({ active: true, busy: false, status: 'Connected.' });
          // One attempt per call. Repeated transport events cannot retry permission,
          // override a mute, or recapture a disconnected device.
          if (!inputAttempted) {
            inputAttempted = true;
            if (openMicWanted.current) startInput();
          }
          if (!greetingRequested && sessionToken) {
            greetingRequested = true;
            state.diagnosticsTimer = setInterval(() => void reportAudioStatus(), 2000);
            void reportAudioStatus();
            void api('voice-ready', { sessionToken }).catch(error => { if (current()) reportError(`Call connected, but the greeting could not be sent: ${error.message}`); });
          }
        } else if (['failed', 'disconnected'].includes(connection.connectionState)) {
          reportError('WebRTC connection lost.'); void disconnect('Connection lost. Microphone off.');
        }
      };
      state.channel = connection.createDataChannel('oai-events');
      state.channel.onmessage = event => {
        if (!current()) return;
        try { const activity = voiceActivityEvent(JSON.parse(event.data).type); if (activity) patch({ activity }); }
        catch { /* Unknown events never alter the native realtime conversation. */ }
      };
      await connection.setLocalDescription(await connection.createOffer());
      if (!current()) return;
      patch({ status: 'Connecting voice through Codex…' });
      const answer = await api('connect', { sdp: connection.localDescription.sdp, voice: selectedVoice });
      if (!current()) return;
      state.timer = setTimeout(() => { if (current()) { reportError('WebRTC did not connect within 30 seconds.'); void disconnect('Connection timed out. Microphone off.'); } }, 30000);
      sessionToken = answer.sessionToken;
      await connection.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    } catch (error) {
      if (attempt === state.generation) { reportError(error); await disconnect('Could not connect. Microphone off.'); }
    }
  }, [patch, disconnect, reportError, startInput, sounds, resumePlayback]);
  const toggleMute = useCallback(() => {
    if (resource.current.pc?.connectionState !== 'connected' || resource.current.disconnecting) return;
    sounds.unlock(); cues.current.requestInput();
    if (input.current.stream || input.current.pending) { openMicWanted.current = false; stopInput(); }
    else { openMicWanted.current = true; startInput(); }
  }, [startInput, stopInput, sounds]);
  return { ...view, openMicMuted: !openMicWanted.current, startInput, stopInput, audioRef, resumePlayback, connect, disconnect, toggleMute, transportLost, handleEvent, dispose };
}
