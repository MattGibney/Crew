import type { ManagerProps } from "../contracts/manager.js";
import {
  AudioLines,
  LoaderCircle,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Play,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";

export function VoiceControls({
  manager,
  embedded = false,
}: ManagerProps & { embedded?: boolean }) {
  const { voice, catalog, voiceLoading, voiceNotice, prepared, eventReady } =
    manager;
  const voiceLocked = voice.allocated || voice.busy;
  const phase = voice.inputPending
    ? "Waiting for microphone permission"
    : voice.transmitting
      ? "Listening"
      : voice.activity === "speaking" && voice.active
        ? "Speaking"
        : voice.activity === "processing" && voice.active
          ? "Processing"
          : voice.disconnecting
            ? "Ending call"
            : voice.busy
              ? "Connecting"
              : voice.active
                ? "Connected · microphone off"
                : voice.openMicMuted
                  ? "Microphone muted"
                  : "Microphone off";
  const Icon =
    voice.busy || voice.inputPending
      ? LoaderCircle
      : voice.transmitting
        ? Mic
        : voice.activity === "speaking" && voice.active
          ? AudioLines
          : MicOff;
  return (
    <section
      aria-label="Voice controls"
      className={
        embedded
          ? "text-card-foreground"
          : "rounded-xl border bg-card text-card-foreground"
      }
    >
      <div className="space-y-2 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={`flex size-7 shrink-0 items-center justify-center rounded-full ${voice.transmitting ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}
            >
              <Icon
                className={`size-4 ${voice.busy || voice.inputPending ? "animate-spin motion-reduce:animate-none" : ""}`}
                aria-hidden="true"
              />
            </span>
            <p
              id="status"
              role="status"
              aria-live="polite"
              className="text-xs text-muted-foreground"
            >
              {phase}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {voice.active && (
              <>
                {voice.playbackBlocked && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void voice.resumePlayback()}
                  >
                    <Play aria-hidden="true" />
                    Enable audio
                  </Button>
                )}
                <Button
                  id="mute"
                  type="button"
                  size="sm"
                  variant={
                    voice.transmitting || voice.inputPending
                      ? "secondary"
                      : "default"
                  }
                  className="h-8"
                  onClick={voice.toggleMute}
                >
                  {voice.transmitting || voice.inputPending ? (
                    <MicOff aria-hidden="true" />
                  ) : (
                    <Mic aria-hidden="true" />
                  )}
                  {voice.transmitting
                    ? "Mute microphone"
                    : voice.inputPending
                      ? "Cancel microphone"
                      : voice.inputError
                        ? "Retry microphone"
                        : "Unmute microphone"}
                </Button>
              </>
            )}
            {voiceLocked ? (
              <Button
                id="disconnect"
                type="button"
                size="sm"
                variant="ghost"
                disabled={voice.disconnecting}
                onClick={() => void voice.disconnect()}
              >
                <PhoneOff aria-hidden="true" />
                {voice.disconnecting
                  ? "Ending call…"
                  : voice.busy
                    ? "Cancel"
                    : "End call"}
              </Button>
            ) : (
              <Button
                id="connect"
                type="button"
                size="sm"
                onClick={manager.connect}
                disabled={
                  !manager.managerEnabled ||
                  !prepared ||
                  !eventReady ||
                  !catalog
                }
              >
                <Phone aria-hidden="true" />
                Connect voice
              </Button>
            )}
          </div>
        </div>
        {voice.inputError && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{voice.inputError}</AlertDescription>
          </Alert>
        )}
        {!catalog && !voiceLoading && voiceNotice && (
          <Alert role="alert">
            <AlertDescription>
              {voiceNotice} Review Manager profile in Settings.
            </AlertDescription>
          </Alert>
        )}
      </div>
    </section>
  );
}
