import { record as isRecord } from "../shared/errors.mjs";
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { safeError } from './redaction.mjs';
import type { LastVoice, VoiceCatalog } from './contracts.mjs';
import type { Rpc } from './protocol.mjs';
import { createConversationTimeline } from '../conversation-timeline.mjs';
export interface VoiceSessionState {
  voiceCatalog:VoiceCatalog|undefined; voiceActive:boolean; connecting:boolean;
  voiceGeneration:number; lastVoice:LastVoice|null;
  negotiation:{resolve:(sdp:string)=>void;reject:(error:unknown)=>void}|undefined;
  greetingSession:{token:string;generation:number;sent:boolean}|undefined;
  threadId:string|undefined; activeManagerInstructions:string|null;
}
export function createVoiceSession({state,rpc,prepare,ensureThread,shutdown,timeline,changed,managerPrompt,defaultPrompt,hasChild}: {
  state:VoiceSessionState; rpc:Rpc; prepare:()=>Promise<unknown>; ensureThread:()=>Promise<unknown>;
  shutdown:()=>Promise<void>; timeline:ReturnType<typeof createConversationTimeline>;
  changed:()=>void; hasChild:()=>boolean; managerPrompt:()=>string|undefined; defaultPrompt:URL;
}) {
  async function listVoices() {
    await prepare();
    if (state.voiceCatalog) return state.voiceCatalog;
    const { voices } = await rpc("thread/realtime/listVoices");
    if (
      !Array.isArray(voices?.v3) ||
      !voices.v3.length ||
      !voices.v3.every(
        (id) => typeof id === "string" && /^[a-z][a-z0-9_-]{0,60}$/.test(id),
      ) ||
      !voices.v3.includes(voices.defaultV1)
    )
      throw new Error(
        "Codex did not return a usable v3 voice catalog. Try loading voices again.",
      );
    state.voiceCatalog = {
      voices: [...new Set(voices.v3)].map((id) => ({
        id,
        name: id.charAt(0).toUpperCase() + id.slice(1),
      })),
      defaultVoice: voices.defaultV1,
    };
    return state.voiceCatalog;
  }
  async function startVoice(sdp: string, selectedVoice?: string) {
    if (state.connecting || state.voiceActive)
      throw new Error("A voice session is already active or state.connecting.");
    state.connecting = true;
    const attempt = ++state.voiceGeneration;
    let startRequested = false;
    try {
      await ensureThread();
      const catalog = await listVoices();
      const voice =
        selectedVoice === undefined || selectedVoice === ""
          ? catalog.defaultVoice
          : selectedVoice;
      if (
        typeof voice !== "string" ||
        !catalog.voices.some((item) => item.id === voice)
      )
        throw new Error("Choose a supported Codex voice before state.connecting.");
      if (attempt !== state.voiceGeneration)
        throw new Error("Voice connection cancelled.");
      state.lastVoice = {
        voice,
        requestedAt: new Date().toISOString(),
        inputTranscriptEvents: 0,
        outputTranscriptEvents: 0,
        error: null,
        browser: null,
      };
      const answer = new Promise<string>((resolve, reject) => {
        state.negotiation = { resolve, reject };
      });
      answer.catch(() => {});
      const timer = setTimeout(
        () =>
          state.negotiation?.reject(
            new Error("No WebRTC answer arrived within 40 seconds."),
          ),
        40000,
      );
      try {
        startRequested = true;
        await rpc("thread/realtime/start", {
          threadId: state.threadId,
          transport: { type: "webrtc", sdp },
          outputModality: "audio",
        realtimeStartInstructions: state.activeManagerInstructions,
        realtimeEndInstructions: state.activeManagerInstructions,
          version: "v3",
          voice,
          initialItems: [
            {
              role: "developer",
              text: `${managerPrompt() ?? (await readFile(defaultPrompt, "utf8"))}\n\nVoice runtime event (data): a new voice session is starting. Selected voice name: ${catalog.voices.find((item) => item.id === voice)!.name}. This is connection context, not a user work request.`,
            },
          ],
          clientManagedHandoffs: false,
          includeStartupContext: true,
        });
        const responseSdp = await answer;
        if (attempt !== state.voiceGeneration)
          throw new Error("Voice connection cancelled.");
        state.greetingSession = {
          token: randomUUID(),
          generation: attempt,
          sent: false,
        };
        return {
          sdp: responseSdp,
          threadId: state.threadId,
          sessionToken: state.greetingSession.token,
        };
      } finally {
        clearTimeout(timer);
        state.negotiation = undefined;
      }
    } catch (error) {
      if (attempt === state.voiceGeneration && startRequested) await stopVoice();
      throw error;
    } finally {
      state.connecting = false;
    }
  }
  async function greetVoice(sessionToken: string) {
    const session = state.greetingSession;
    if (
      !session ||
      session.token !== sessionToken ||
      session.generation !== state.voiceGeneration ||
      !state.voiceActive
    )
      throw new Error("This voice call is no longer active.");
    if (session.sent) return { requested: true };
    // Claim once: duplicate connection events cannot repeat startup acknowledgement.
    session.sent = true;
    if (state.lastVoice) state.lastVoice.voiceReadyAt = new Date().toISOString();
    // Startup behavior is in the active editable prompt. Connection acknowledgement
    // must not append a second hidden behavior instruction or synthetic user turn.
    return { requested: true };
  }
  function reportVoiceStatus(sessionToken: string, data: unknown = {}) {
    if (
      !state.greetingSession ||
      state.greetingSession.token !== sessionToken ||
      state.greetingSession.generation !== state.voiceGeneration ||
      !state.voiceActive
    )
      return { recorded: false };
    if (!isRecord(data)) return { recorded: false };
    const snapshot: Record<string, string | number | boolean | null> = {};
    const allowed = [
      "connection",
      "ice",
      "channel",
      "inputSource",
      "localTrack",
      "localEnabled",
      "localMuted",
      "remoteTrack",
      "audioPaused",
      "audioMuted",
      "audioVolume",
      "audioReady",
      "playbackError",
      "packetsSent",
      "packetsReceived",
      "bytesSent",
      "bytesReceived",
      "inputEnergy",
    ];
    for (const key of allowed) {
      const value = data[key];
      if (
        value === null ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
      )
        snapshot[key] = value;
      else if (typeof value === "string")
        snapshot[key] = safeError(value).slice(0, 200);
    }
    if (state.lastVoice)
      state.lastVoice.browser = { ...snapshot, at: new Date().toISOString() };
    return { recorded: true };
  }
  async function stopVoice({ preserveWork = true, cooperative = false } = {}) {
    state.greetingSession = undefined;
    state.voiceGeneration++;
    if (hasChild() && state.threadId && (state.voiceActive || state.connecting)) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          rpc("thread/realtime/stop", { threadId: state.threadId }),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Voice stop timed out.")),
              3000,
            );
          }),
        ]);
      } catch (error) {
        if (cooperative)
          throw new Error(
            `Voice shutdown could not be confirmed: ${safeError(error)}`,
          );
        if (preserveWork) throw error;
        await shutdown();
      } finally {
        clearTimeout(timer);
      }
    }
    timeline.partial();
    state.voiceActive = false;
    state.negotiation?.reject(new Error("Disconnected."));
    changed();
  }

  return {listVoices,startVoice,greetVoice,reportVoiceStatus,stopVoice};
}
