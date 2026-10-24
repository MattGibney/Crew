import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  LoaderCircle,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Volume2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type {
  Agent,
  RuntimeBinding,
} from "../../../../src/agents/contracts.mjs";
import type { PrimaryVoiceCatalog, PrimaryVoiceClient } from "./client";
import { usePrimaryVoice } from "./usePrimaryVoice";
import type { LiveTranscriptItem } from "./live-transcript";

export function PrimaryAgentVoice({
  client,
  agent,
  visible = true,
  mode = "voice",
  controlsTarget,
  onTranscript,
  embedded = false,
}: {
  client: PrimaryVoiceClient;
  agent: Agent | null;
  visible?: boolean;
  mode?: "voice" | "compact" | "hidden";
  /** Only visual controls move. The hook and audio element remain at App root. */
  controlsTarget?: HTMLElement | null;
  onTranscript?: (items: LiveTranscriptItem[]) => void;
  embedded?: boolean;
}) {
  const session = agent?.runtime.session;
  const binding: RuntimeBinding | null =
    agent &&
    session?.observedState === "started" &&
    session.sessionId &&
    agent.runtime.threadId
      ? {
          projectId: agent.projectId,
          agentId: agent.id,
          sessionId: session.sessionId,
          threadId: agent.runtime.threadId,
        }
      : null;
  const key = binding ? JSON.stringify(binding) : "";
  const [catalog, setCatalog] = useState<PrimaryVoiceCatalog | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [retry, setRetry] = useState(0);
  const voice = usePrimaryVoice(client, binding);
  useEffect(() => {
    onTranscript?.(voice.transcript);
  }, [onTranscript, voice.transcript]);
  useEffect(
    () => client.subscribeCatalog?.(() => setRetry((value) => value + 1)),
    [client],
  );
  useEffect(() => {
    let current = true;
    setCatalog(null);
    setCatalogError("");
    if (binding)
      void client
        .listVoices(binding)
        .then((next) => {
          if (current) setCatalog(next);
        })
        .catch(() => {
          if (current) setCatalogError("Voices unavailable for this session.");
        });
    return () => {
      current = false;
    };
    // The native binding identity owns catalogue refresh, not every snapshot object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key, retry]);
  const selected = catalog?.selectedVoice ?? catalog?.defaultVoice;
  const supported =
    selected && catalog?.voices.some((item) => item.id === selected);
  const allocated = voice.phase !== "idle";
  const status = voice.inputPending
    ? "Allow microphone"
    : voice.phase === "connecting"
      ? "Connecting"
      : voice.phase === "ending"
        ? "Ending call"
        : voice.phase === "connected"
          ? voice.transmitting
            ? voice.activity === "speaking"
              ? "Speaking"
              : "Listening"
            : "Muted"
          : binding
            ? "Voice"
            : "Start your primary agent to use voice";
  const show =
    visible &&
    mode !== "hidden" &&
    (mode === "voice" || allocated || voice.error || voice.inputError);
  const controls = show ? (
    <section
      aria-label="Primary agent voice"
      className={embedded ? "w-full" : "mx-auto w-full max-w-5xl px-4 pb-4"}
    >
      <div
        className={`flex flex-wrap items-center justify-between gap-3 ${embedded ? "py-1" : "rounded-lg border px-3 py-2"}`}
      >
        <span
          role="status"
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          {voice.phase === "connecting" || voice.inputPending ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : voice.transmitting ? (
            <Mic className="size-4" />
          ) : (
            <MicOff className="size-4" />
          )}
          {status}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          {voice.playbackBlocked && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void voice.resumePlayback()}
            >
              <Volume2 />
              Enable audio
            </Button>
          )}
          {allocated && voice.phase !== "ending" && (
            <Button variant="ghost" size="sm" onClick={voice.toggleMute}>
              {voice.transmitting ||
              voice.inputPending ||
              (!voice.mutedIntent && voice.phase === "connecting") ? (
                <>
                  <MicOff />
                  Mute
                </>
              ) : (
                <>
                  <Mic />
                  Unmute
                </>
              )}
            </Button>
          )}
          {allocated ? (
            <Button
              variant="outline"
              size="sm"
              disabled={voice.phase === "ending"}
              onClick={() => void voice.disconnect()}
            >
              <PhoneOff />
              {voice.phase === "connecting" ? "Cancel" : "End call"}
            </Button>
          ) : mode === "voice" ? (
            <Button
              size="sm"
              disabled={!binding || !supported}
              onClick={() => {
                if (selected) void voice.connect(selected);
              }}
            >
              <Phone />
              Connect voice
            </Button>
          ) : null}
        </div>
      </div>
      {(voice.error || voice.inputError) && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {voice.inputError || voice.error}
        </p>
      )}
      {mode === "voice" && catalogError && (
        <p className="mt-2 text-sm text-muted-foreground">
          {catalogError}{" "}
          <Button
            variant="ghost"
            type="button"
            className="h-auto p-0 underline"
            onClick={() => setRetry((value) => value + 1)}
          >
            Retry
          </Button>
        </p>
      )}
      {mode === "voice" && catalog && !supported && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          Your saved voice is unavailable. Choose a supported voice in your
          primary agent settings.
        </p>
      )}
    </section>
  ) : null;
  return (
    <>
      <audio ref={voice.audioRef} autoPlay playsInline hidden />
      {controlsTarget === undefined
        ? controls
        : controlsTarget
          ? createPortal(controls, controlsTarget)
          : null}
    </>
  );
}
