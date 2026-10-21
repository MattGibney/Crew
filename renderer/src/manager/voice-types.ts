import type { createSilentAudio } from "./voice-silence.js";
export interface VoiceResources {
  generation: number;
  pc: RTCPeerConnection | null;
  stream: MediaStream | null;
  channel: RTCDataChannel | null;
  busy: boolean;
  disconnecting: boolean;
  silence?: ReturnType<typeof createSilentAudio> | null;
  sender?: RTCRtpSender | null;
  timer?: ReturnType<typeof setTimeout>;
  diagnosticsTimer?: ReturnType<typeof setInterval>;
  playbackError?: string | null;
}
export interface VoiceView {
  busy: boolean;
  allocated: boolean;
  active: boolean;
  disconnecting: boolean;
  muted: boolean;
  transmitting: boolean;
  inputPending: boolean;
  inputError: string;
  playbackBlocked: boolean;
  activity: string;
  status: string;
}
export interface VoiceDiagnostics {
  inputSource: string;
  connection: RTCPeerConnectionState;
  ice: RTCIceConnectionState;
  channel: RTCDataChannelState | null;
  localTrack: MediaStreamTrackState | null;
  localEnabled: boolean | null;
  localMuted: boolean | null;
  remoteTrack: MediaStreamTrackState | null;
  audioPaused: boolean;
  audioMuted: boolean;
  audioVolume: number;
  audioReady: number;
  playbackError?: string | null;
  packetsSent: number | null;
  packetsReceived: number | null;
  bytesSent: number | null;
  bytesReceived: number | null;
  inputEnergy: number | null;
}
