import { useCallback, useEffect, useRef, useState } from "react";
import type { RuntimeBinding } from "../../../../src/agents/contracts.mjs";
import {
  createVoiceInput,
  voiceActivityEvent,
} from "../../manager/voice-input";
import { createSilentAudio } from "../../manager/voice-silence";
import { createCallCues, createSounds } from "../../manager/sounds";
import { sameVoiceBinding } from "./client";
import type { PrimaryVoiceCall, PrimaryVoiceClient } from "./client";
import {
  updateLiveTranscript,
  type LiveTranscriptItem,
} from "./live-transcript";

interface Call extends PrimaryVoiceCall {
  peer: RTCPeerConnection;
  silence: ReturnType<typeof createSilentAudio>;
  sender: RTCRtpSender;
  channel: RTCDataChannel;
  timer?: ReturnType<typeof setTimeout>;
  sessionToken?: string;
  connected: boolean;
  readyRequested: boolean;
  inputAttempted: boolean;
}
const initial = {
  phase: "idle" as "idle" | "connecting" | "connected" | "ending",
  transmitting: false,
  inputPending: false,
  inputError: "",
  error: "",
  playbackBlocked: false,
  activity: "ready",
  mutedIntent: false,
};

/** Mount once in the app. Hiding controls/navigation never owns call lifetime. */
export function usePrimaryVoice(
  client: PrimaryVoiceClient,
  binding: RuntimeBinding | null,
) {
  const [view, setView] = useState(initial);
  const [transcript, setTranscript] = useState<LiveTranscriptItem[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const call = useRef<Call | null>(null);
  const wanted = useRef(true);
  const ending = useRef(false);
  const currentBinding = useRef(binding);
  currentBinding.current = binding;
  const sounds = useRef<ReturnType<typeof createSounds> | null>(null);
  if (!sounds.current) sounds.current = createSounds();
  const cues = useRef<ReturnType<typeof createCallCues> | null>(null);
  if (!cues.current)
    cues.current = createCallCues((kind) => sounds.current?.play(kind));
  const patch = useCallback(
    (value: Partial<typeof initial>) =>
      setView((before) => ({ ...before, ...value })),
    [],
  );
  const input = useRef<ReturnType<typeof createVoiceInput> | null>(null);
  if (!input.current)
    input.current = createVoiceInput({
      acquire: () =>
        navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        }),
      idleTrack: () => call.current?.silence.track ?? null,
      onChange: (state) => {
        cues.current!.input(state.transmitting, state.inputPending);
        patch(state);
      },
      onError: () =>
        patch({
          inputError:
            "Microphone unavailable. Check permission and your input device, then choose Unmute to retry.",
        }),
    });
  const release = useCallback(() => {
    const previous = call.current;
    call.current = null;
    setTranscript([]);
    input.current!.reset();
    if (previous) {
      clearTimeout(previous.timer);
      previous.peer.onconnectionstatechange = null;
      previous.peer.ontrack = null;
      previous.channel.onmessage = null;
      previous.channel.close();
      previous.peer.close();
      previous.silence.dispose();
    }
    if (audioRef.current) audioRef.current.srcObject = null;
    cues.current!.ended();
    patch({
      transmitting: false,
      inputPending: false,
      playbackBlocked: false,
      activity: "ready",
    });
    return previous;
  }, [patch]);
  const disconnect = useCallback(async () => {
    if (ending.current) return;
    const previous = release();
    if (!previous) return;
    ending.current = true;
    patch({ phase: "ending" });
    try {
      await client.stop({ binding: previous.binding, callId: previous.callId });
    } catch {
      patch({
        error:
          "Microphone stopped. The native call could not confirm disconnect; retry after refreshing its session.",
      });
    } finally {
      ending.current = false;
      patch({ phase: "idle" });
    }
  }, [client, patch, release]);
  const resumePlayback = useCallback(async () => {
    const current = call.current;
    if (!current || !audioRef.current) return;
    try {
      await audioRef.current.play();
      if (call.current === current) patch({ playbackBlocked: false });
    } catch {
      if (call.current === current) patch({ playbackBlocked: true });
    }
  }, [patch]);
  const connect = useCallback(
    async (voice: string) => {
      const selected = currentBinding.current;
      if (!selected || !voice || call.current || ending.current) return;
      sounds.current ??= createSounds();
      sounds.current.unlock();
      setTranscript([]);
      patch({ phase: "connecting", inputError: "", error: "" });
      let current: Call | null = null;
      let pendingPeer: RTCPeerConnection | null = null;
      let pendingSilence: ReturnType<typeof createSilentAudio> | null = null;
      try {
        const peer = (pendingPeer = new RTCPeerConnection());
        const silence = (pendingSilence = createSilentAudio());
        const sender = peer.addTransceiver(silence.track, {
          direction: "sendrecv",
          streams: [silence.stream],
        }).sender;
        current = {
          binding: { ...selected },
          callId: crypto.randomUUID(),
          peer,
          silence,
          sender,
          channel: peer.createDataChannel("oai-events"),
          connected: false,
          readyRequested: false,
          inputAttempted: false,
        };
        const active = current;
        call.current = active;
        const valid = () =>
          call.current === active &&
          currentBinding.current !== null &&
          sameVoiceBinding(currentBinding.current, active.binding);
        const ready = () => {
          if (
            !valid() ||
            !active.connected ||
            !active.sessionToken ||
            active.readyRequested
          )
            return;
          active.readyRequested = true;
          void client
            .ready({
              binding: active.binding,
              callId: active.callId,
              sessionToken: active.sessionToken,
            })
            .catch(() => {
              if (valid())
                patch({
                  error:
                    "Call connected. Its startup acknowledgement was not confirmed.",
                });
            });
        };
        // Deadline covers local negotiation as well as native SDP and connection.
        active.timer = setTimeout(() => {
          if (!valid()) return;
          patch({ error: "Voice did not connect within 45 seconds." });
          void disconnect();
        }, 45_000);
        peer.ontrack = (event) => {
          if (!valid() || !audioRef.current) return;
          audioRef.current.srcObject =
            event.streams[0] ?? new MediaStream([event.track]);
          void resumePlayback();
        };
        peer.onconnectionstatechange = () => {
          if (!valid()) return;
          if (peer.connectionState === "connected") {
            active.connected = true;
            clearTimeout(active.timer);
            cues.current!.connected();
            patch({ phase: "connected" });
            if (!active.inputAttempted) {
              active.inputAttempted = true;
              if (wanted.current) void input.current!.start(active.sender);
            }
            ready();
          } else if (
            ["failed", "disconnected", "closed"].includes(peer.connectionState)
          ) {
            patch({ error: "Voice connection ended. Microphone off." });
            void disconnect();
          }
        };
        active.channel.onmessage = (event) => {
          if (!valid()) return;
          try {
            const value: unknown = JSON.parse(event.data);
            if (
              !value ||
              typeof value !== "object" ||
              !("type" in value) ||
              typeof value.type !== "string"
            )
              return;
            const activity = voiceActivityEvent(value.type);
            if (activity) patch({ activity });
            // Native handoff/transcript events are passive. Never create a model turn here.
          } catch {
            /* Non-JSON transport data is not a user message. */
          }
        };
        await silence.ready;
        if (!valid()) return;
        await peer.setLocalDescription(await peer.createOffer());
        if (!valid()) return;
        const sdp = peer.localDescription?.sdp;
        if (!sdp) throw new Error("No local offer");
        const answer = await client.start({
          binding: active.binding,
          callId: active.callId,
          sdp,
          voice,
        });
        if (!valid()) {
          await client.stop({ binding: active.binding, callId: active.callId });
          return;
        }
        if (
          answer.threadId !== active.binding.threadId ||
          !answer.sessionToken ||
          !answer.sdp
        )
          throw new Error("Native voice identity mismatch");
        active.sessionToken = answer.sessionToken;
        await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
        ready();
      } catch {
        if (current && call.current !== current) return;
        patch({
          error:
            "Voice could not connect to this agent session. Microphone off.",
        });
        if (current) await disconnect();
        else {
          pendingPeer?.close();
          pendingSilence?.dispose();
          patch({ phase: "idle" });
        }
      }
    },
    [client, disconnect, patch, resumePlayback],
  );
  const toggleMute = useCallback(() => {
    const active = call.current;
    if (!active || ending.current) return;
    sounds.current ??= createSounds();
    sounds.current.unlock();
    cues.current!.requestInput();
    if (
      wanted.current &&
      (input.current!.stream || input.current!.pending || !active.connected)
    ) {
      wanted.current = false;
      input.current!.stop();
    } else {
      wanted.current = true;
      if (active.connected) void input.current!.start(active.sender);
    }
    patch({ mutedIntent: !wanted.current });
  }, [patch]);
  const bindingKey = binding ? JSON.stringify(binding) : "";
  useEffect(() => {
    const active = call.current;
    if (active && (!binding || !sameVoiceBinding(binding, active.binding)))
      void disconnect();
  }, [bindingKey, binding, disconnect]);
  useEffect(
    () =>
      client.subscribe((event) => {
        const active = call.current;
        if (
          !active ||
          event.callId !== active.callId ||
          !sameVoiceBinding(event.binding, active.binding)
        )
          return;
        if (event.kind === "transcript") {
          setTranscript((items) =>
            call.current === active
              ? updateLiveTranscript(items, event)
              : items,
          );
          return;
        }
        if (event.kind === "error")
          patch({
            error:
              "The native voice session reported an error. Microphone off.",
          });
        void disconnect();
      }),
    [client, disconnect, patch],
  );
  useEffect(() => {
    const close = () => {
      const previous = release();
      if (previous) {
        const identity = { binding: previous.binding, callId: previous.callId };
        client.abandon?.(identity);
        void client.stop(identity).catch(() => {});
      }
    };
    window.addEventListener("pagehide", close);
    return () => {
      window.removeEventListener("pagehide", close);
      close();
    };
  }, [client, release]);
  useEffect(
    () => () => {
      sounds.current?.dispose();
      sounds.current = null;
    },
    [],
  );
  return {
    ...view,
    transcript:
      binding && call.current && sameVoiceBinding(binding, call.current.binding)
        ? transcript
        : EMPTY_TRANSCRIPT,
    audioRef,
    connect,
    disconnect,
    toggleMute,
    resumePlayback,
  };
}

const EMPTY_TRANSCRIPT: LiveTranscriptItem[] = [];
