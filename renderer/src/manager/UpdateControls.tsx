import {
  PreparationProgress,
  preparationPhase,
  preparationPurpose,
} from "./PreparationProgress.js";
import type { UpdateStatus } from "../contracts/manager.js";
import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  Check,
  Download,
  LoaderCircle,
  RefreshCw,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { api, errorText } from "./api.js";

export function UpdateControls({
  liveStatus,
}: {
  liveStatus: UpdateStatus | null;
}) {
  const [status, setStatus] = useState<UpdateStatus | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [open, setOpen] = useState(false);
  const busyRef = useRef(false),
    panel = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (liveStatus) setStatus(liveStatus);
  }, [liveStatus]);
  const request = async (action = "status") => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      setStatus(await api("updates", { action }));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    void request();
  }, []);
  useEffect(() => {
    if (!open) return;
    void request();
    const timer = setInterval(() => void request(), 10000);
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => {
      clearInterval(timer);
      window.removeEventListener("keydown", close);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        panel.current &&
        !panel.current.contains(
          event.target instanceof Node ? event.target : null,
        )
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);
  const plan = status?.workspacePlan || status?.plan;
  const planActive = Boolean(plan && plan.phase !== "complete");
  const quit = Boolean(
    planActive && plan && preparationPurpose(plan) === "quit",
  );
  const shownQuit = useRef<string | null>(null);
  useEffect(() => {
    if (!quit || !plan) return;
    const identity = plan.id || plan.preparation?.id || "quit-preparation";
    if (shownQuit.current === identity) return;
    shownQuit.current = identity;
    setOpen(true);
  }, [quit, plan?.id, plan?.preparation?.id]);
  const title =
    planActive && plan
      ? preparationPurpose(plan) === "quit"
        ? "Preparing to quit Crew"
        : "Preparing to update Crew"
      : "Crew updates";
  const phase = status?.phase || "",
    available = ["available", "downloading", "downloaded"].includes(phase);
  const messages: Record<string, string> = {
    idle: "Check for a newer Crew release.",
    checking: "Checking GitHub Releases…",
    current: "Crew is up to date.",
    available: `Crew ${status?.availableVersion} is available.`,
    downloading: `Downloading${status?.downloadPercent == null ? "…" : ` ${Math.round(status?.downloadPercent)}%…`}`,
    downloaded: `Crew ${status?.availableVersion} is ready to install.`,
    installing: "Restarting Crew to install the update…",
    error: "The update could not be retrieved.",
    unavailable: "Updates are managed by the installed desktop app.",
  };
  return (
    <div className="relative" ref={panel}>
      <Button
        id="updates-button"
        type="button"
        variant="ghost"
        size="sm"
        aria-label={
          quit
            ? "Crew quit preparation"
            : available
              ? "Crew update available"
              : "Crew updates"
        }
        aria-expanded={open}
        aria-controls="updates-panel"
        onClick={() => setOpen((value) => !value)}
      >
        <ArrowDownToLine aria-hidden="true" />
        <span className="hidden sm:inline">
          {quit ? "Preparation" : "Updates"}
        </span>
        {available && !quit && (
          <span
            className="size-1.5 rounded-full bg-primary"
            aria-label="Update available"
          />
        )}
      </Button>
      {open && (
        <section
          id="updates-panel"
          aria-label={title}
          className="absolute right-0 top-full z-50 mt-2 w-[min(340px,calc(100vw-2rem))] max-h-[calc(100dvh-6rem)] overflow-y-auto space-y-4 rounded-xl border bg-popover p-4 text-sm text-popover-foreground shadow-lg"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <h2 className="font-semibold">{title}</h2>
              {status?.currentVersion && (
                <Badge variant="secondary">{status.currentVersion}</Badge>
              )}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={quit ? "Close quit preparation" : "Close updates"}
              onClick={() => setOpen(false)}
            >
              <X aria-hidden="true" />
            </Button>
          </div>
          <p role="status" aria-live="polite" className="leading-relaxed">
            {planActive
              ? preparationPhase(plan!)
              : messages[phase] || "Loading update status…"}
          </p>
          {(error || status?.error) && (
            <p role="alert" className="break-words text-destructive">
              {error || status?.error}
            </p>
          )}
          {!quit &&
            phase === "downloading" &&
            status?.downloadPercent != null && (
              <Progress
                aria-label="Update download"
                value={status?.downloadPercent}
                max={100}
                className="w-full [&_[data-slot=progress-track]]:h-2"
              />
            )}
          {!quit && phase === "downloaded" && status?.installBlocked && (
            <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
              {status.reasons?.map((reason) => (
                <p key={reason}>{reason}</p>
              ))}
            </div>
          )}
          {!quit &&
            phase === "downloaded" &&
            (status?.notices?.length ?? 0) > 0 && (
              <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
                {status?.notices!.map((notice) => (
                  <p key={notice}>{notice}</p>
                ))}
              </div>
            )}
          {planActive && plan && <PreparationProgress plan={plan} />}
          <div className="flex flex-wrap gap-2">
            {status?.supported && !quit && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={
                  busy ||
                  ["checking", "downloading", "installing"].includes(phase)
                }
                onClick={() => void request("check")}
              >
                {busy ? (
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                ) : (
                  <RefreshCw aria-hidden="true" />
                )}
                Check for updates
              </Button>
            )}
            {!quit && phase === "available" && (
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => void request("download")}
              >
                <Download aria-hidden="true" />
                Download update
              </Button>
            )}
            {!quit && phase === "downloaded" && !planActive && (
              <Button
                id="restart-update"
                type="button"
                size="sm"
                disabled={busy || status?.installBlocked}
                onClick={() => void request("restart")}
              >
                <Check aria-hidden="true" />
                Restart to update
              </Button>
            )}
            {!quit &&
              phase === "downloaded" &&
              status?.installBlocked &&
              !planActive && (
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() => void request("pause-update")}
                >
                  Prepare and update
                </Button>
              )}
            {planActive &&
              ["draining", "ready", "blocked"].includes(plan!.phase) && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void request("cancel-pause-update")}
                >
                  {quit ? "Cancel quit" : "Cancel update"}
                </Button>
              )}
            {planActive && ["canceled", "blocked"].includes(plan!.phase) && (
              <>
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() => void request("resume-paused-work")}
                >
                  Resume paused work
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void request("return-to-work")}
                >
                  Return to work
                </Button>
                <p className="text-xs text-muted-foreground">
                  Return to work keeps prepared workers paused. Resume paused
                  work is a separate explicit action. Already queued work,
                  including queued resumes, may continue after the hold is
                  released.
                </p>
              </>
            )}
            {(planActive ||
              (phase === "downloaded" && status?.installBlocked)) && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void request()}
              >
                Refresh readiness
              </Button>
            )}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {quit
              ? "Crew waits for agent preparation and confirmed execution settlement before quitting. Your local settings and work history stay on this Mac."
              : "Updates never restart Crew while a conversation, worker or project environment is active. Your local settings and work history stay on this Mac."}
          </p>
          {!quit && (
            <a
              href="https://github.com/MattGibney/crew/releases/latest"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block text-xs text-primary underline underline-offset-4"
            >
              View releases on GitHub
            </a>
          )}
        </section>
      )}
    </div>
  );
}
