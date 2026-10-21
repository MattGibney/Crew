import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText } from './api.js';

// Media resources belong to this hook, never to a worker or an SSE notification.
export function useVoiceSession(onError) {
  const audioRef = useRef(null);
  const resource = useRef({ generation: 0, pc: null, stream: null, channel: null, busy: false, disconnecting: false });
  const [view, setView] = useState({ busy: false, allocated: false, active: false, muted: false, status: 'Microphone off. No voice session started.' });
  const onErrorRef = useRef(onError); onErrorRef.current = onError;
  const patch = useCallback(value => setView(previous => ({ ...previous, ...value })), []);
  const reportError = useCallback(error => onErrorRef.current(errorText(error)), []);
  const release = useCallback(() => {
    const state = resource.current;
    clearTimeout(state.timer); clearInterval(state.diagnosticsTimer);
    state.timer = null; state.diagnosticsTimer = null;
    if (state.pc) { state.pc.onconnectionstatechange = null; state.pc.ontrack = null; state.pc.close(); }
    state.stream?.getTracks().forEach(track => track.stop());
    state.pc = null; state.stream = null; state.channel = null;
    if (audioRef.current) audioRef.current.srcObject = null;
    patch({ allocated: false, active: false, muted: false });
  }, [patch]);
  const dispose = useCallback(() => {
    const state = resource.current;
    state.generation++; state.busy = state.disconnecting; release(); patch({ busy: state.disconnecting });
  }, [release, patch]);
  useEffect(() => () => { dispose(); }, [dispose]);
  const disconnect = useCallback(async (message = 'Disconnected. Microphone off.') => {
    const state = resource.current;
    if (state.disconnecting) return;
    state.disconnecting = true; state.generation++; release(); state.busy = true; patch({ busy: true });
    try { await api('disconnect'); } catch (error) { reportError(error); }
    finally { state.busy = false; state.disconnecting = false; patch({ busy: false, status: message }); }
  }, [release, patch, reportError]);
  const transportLost = useCallback(() => {
    const state = resource.current, hadVoice = Boolean(state.pc || state.busy);
    dispose();
    patch({ status: hadVoice ? 'Bridge connection lost. Microphone off.' : 'Live connection unavailable. Keep one browser tab open, then refresh. Microphone off.' });
  }, [dispose, patch]);
  const handleEvent = useCallback(message => {
    const state = resource.current;
    if (state.disconnecting || (!state.pc && !state.busy)) return;
    if (message.type === 'error') { reportError(message.message); void disconnect('Voice error. Microphone off.'); }
    if (message.type === 'closed') void disconnect('Voice session ended. Microphone off.');
  }, [disconnect, reportError]);
  const connect = useCallback(async selectedVoice => {
    const state = resource.current;
    if (state.busy || state.disconnecting || state.pc || !selectedVoice) return;
    state.busy = true; state.playbackError = null;
    const attempt = ++state.generation;
    patch({ busy: true, status: 'Waiting for microphone permission…' });
    try {
      // This call is reached only from the user's Connect button.
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (attempt !== state.generation) { acquired.getTracks().forEach(track => track.stop()); return; }
      state.stream = acquired;
      const connection = new RTCPeerConnection(); state.pc = connection;
      patch({ allocated: true });
      let sessionToken, greetingRequested = false;
      const current = () => state.pc === connection && state.generation === attempt;
      const reportAudioStatus = async () => {
        if (!current() || !sessionToken) return;
        try {
          const stats = await connection.getStats();
          if (!current()) return;
          const local = state.stream?.getAudioTracks()[0], audio = audioRef.current;
          if (!audio) return;
          const snapshot = { connection: connection.connectionState, ice: connection.iceConnectionState, channel: state.channel?.readyState || null, localTrack: local?.readyState || null, localEnabled: local?.enabled ?? null, localMuted: local?.muted ?? null, remoteTrack: audio.srcObject?.getAudioTracks()[0]?.readyState || null, audioPaused: audio.paused, audioMuted: audio.muted, audioVolume: audio.volume, audioReady: audio.readyState, playbackError: state.playbackError, packetsSent: null, packetsReceived: null, bytesSent: null, bytesReceived: null, inputEnergy: null };
          stats.forEach(item => {
            if (item.kind !== 'audio' && item.mediaType !== 'audio') return;
            if (item.type === 'outbound-rtp') { snapshot.packetsSent = item.packetsSent ?? null; snapshot.bytesSent = item.bytesSent ?? null; }
            if (item.type === 'inbound-rtp') { snapshot.packetsReceived = item.packetsReceived ?? null; snapshot.bytesReceived = item.bytesReceived ?? null; }
            if (item.type === 'media-source') snapshot.inputEnergy = item.totalAudioEnergy ?? null;
          });
          await api('voice-status', { sessionToken, status: snapshot });
        } catch { /* Diagnostics cannot stop a functioning call. */ }
      };
      acquired.getTracks().forEach(track => connection.addTrack(track, acquired));
      connection.ontrack = event => {
        if (!current() || !audioRef.current) return;
        const audio = audioRef.current;
        audio.srcObject = event.streams[0] || new MediaStream([event.track]);
        audio.play().catch(error => {
          if (!current()) return;
          state.playbackError = error.name || 'Playback failed'; reportError('Press Play in the audio player to hear Codex.');
        });
      };
      connection.onconnectionstatechange = () => {
        if (!current()) return;
        if (connection.connectionState === 'connected') {
          clearTimeout(state.timer); state.busy = false;
          patch({ active: true, busy: false, status: 'Connected. Microphone on — speak naturally, or interrupt Codex.' });
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
  }, [patch, disconnect, reportError]);
  const toggleMute = useCallback(() => {
    const track = resource.current.stream?.getAudioTracks()[0]; if (!track) return;
    const enabled = !track.enabled;
    resource.current.stream.getAudioTracks().forEach(item => { item.enabled = enabled; });
    patch({ muted: !enabled, status: enabled ? 'Connected. Microphone on.' : 'Connected. Microphone muted; Codex may still speak.' });
  }, [patch]);
  return { ...view, audioRef, connect, disconnect, toggleMute, transportLost, handleEvent, dispose };
}
