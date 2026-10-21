import type { ManagerProps } from "../contracts/manager.js";
import {
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Play,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";

// Presentation only: the call and playback live above project/global view navigation.
export function ManagerCallBar({
  manager,
  onManager,
}: ManagerProps & { onManager: () => void }) {
  const { voice } = manager;
  const allocated = voice.allocated || voice.busy;
  const callError = voice.inputError || (!voice.active ? manager.error : "");
  const mic = voice.inputPending
    ? "Microphone permission pending"
    : voice.transmitting
      ? "Microphone on"
      : "Microphone off";
  return (
    <footer
      aria-label="Manager call"
      className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-t bg-background px-3 py-1.5 sm:px-6"
    >
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <span
          className={`size-1.5 shrink-0 rounded-full ${voice.active ? "bg-primary" : "bg-muted-foreground"}`}
          aria-hidden="true"
        />
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-7 px-0 text-xs"
          onClick={onManager}
        >
          Manager
        </Button>
        <span
          role="status"
          className="truncate text-muted-foreground"
          title={callError || voice.status}
        >
          {voice.disconnecting
            ? "Ending call"
            : voice.busy
              ? "Connecting…"
              : voice.active
                ? `Connected · ${mic}`
                : "Call off · microphone off"}
        </span>
        {callError && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 shrink-0 px-1 text-xs text-destructive"
            title={callError}
            aria-label={`Review call error with manager: ${callError}`}
            onClick={onManager}
          >
            <TriangleAlert className="size-3.5" />
            <span className="hidden sm:inline">Review call error</span>
          </Button>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {voice.active && voice.playbackBlocked && (
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
        {voice.active && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            onClick={voice.toggleMute}
            aria-label={
              voice.transmitting || voice.inputPending
                ? "Mute manager microphone"
                : "Unmute manager microphone"
            }
          >
            {voice.transmitting || voice.inputPending ? (
              <MicOff className="size-3.5" />
            ) : (
              <Mic className="size-3.5" />
            )}
            <span className="hidden sm:inline">
              {voice.transmitting || voice.inputPending ? "Mute" : "Unmute"}
            </span>
          </Button>
        )}
        {allocated ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 text-xs"
            onClick={() => void voice.disconnect()}
            disabled={voice.disconnecting}
            aria-label="End manager call"
          >
            <PhoneOff className="size-3.5" />
            <span className="hidden sm:inline">
              {voice.busy ? "Cancel" : "End call"}
            </span>
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            className="h-8 text-xs"
            onClick={manager.connect}
            disabled={
              !manager.managerEnabled ||
              !manager.prepared ||
              !manager.eventReady ||
              !manager.catalog
            }
          >
            <Phone className="size-3.5" />
            Start call
          </Button>
        )}
      </div>
    </footer>
  );
}
