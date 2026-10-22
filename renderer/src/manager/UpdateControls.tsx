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
  const plan = status?.workspacePlan || status?.plan,
    planActive = plan && !["complete"].includes(plan!.phase);
  const planTitles: Record<string, string> = {
    draining: "Pausing work for the update…",
    ready: "Work is paused. Preparing to restart…",
    marking: "Confirming every project before installation…",
    installing: "Restarting to install the update…",
    resuming: "Restoring work paused for this update…",
    blocked: "The update needs your review.",
    canceled: "Update canceled. Paused work is retained.",
    complete: "Update coordination finished.",
  };
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
        aria-label={available ? "Crew update available" : "Crew updates"}
        aria-expanded={open}
        aria-controls="updates-panel"
        onClick={() => setOpen((value) => !value)}
      >
        <ArrowDownToLine aria-hidden="true" />
        <span className="hidden sm:inline">Updates</span>
        {available && (
          <span
            className="size-1.5 rounded-full bg-primary"
            aria-label="Update available"
          />
        )}
      </Button>
      {open && (
        <section
          id="updates-panel"
          aria-label="Crew updates"
          className="absolute right-0 top-full z-50 mt-2 w-[min(340px,calc(100vw-2rem))] max-h-[calc(100dvh-6rem)] overflow-y-auto space-y-4 rounded-xl border bg-popover p-4 text-sm text-popover-foreground shadow-lg"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <h2 className="font-semibold">Crew updates</h2>
              {status?.currentVersion && (
                <Badge variant="secondary">{status.currentVersion}</Badge>
              )}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Close updates"
              onClick={() => setOpen(false)}
            >
              <X aria-hidden="true" />
            </Button>
          </div>
          <p role="status" aria-live="polite" className="leading-relaxed">
            {planActive
              ? planTitles[plan!.phase] || "Update state needs review."
              : messages[phase] || "Loading update status…"}
          </p>
          {(error || status?.error) && (
            <p role="alert" className="break-words text-destructive">
              {error || status?.error}
            </p>
          )}
          {phase === "downloading" && status?.downloadPercent != null && (
            <progress
              aria-label="Update download"
              value={status?.downloadPercent}
              max={100}
              className="h-2 w-full accent-primary"
            />
          )}
          {phase === "downloaded" && status?.installBlocked && (
            <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
              {status.reasons?.map((reason) => (
                <p key={reason}>{reason}</p>
              ))}
            </div>
          )}
          {phase === "downloaded" && (status?.notices?.length ?? 0) > 0 && (
            <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
              {status?.notices!.map((notice) => (
                <p key={notice}>{notice}</p>
              ))}
            </div>
          )}
          {planActive && (
            <div className="space-y-2 break-words text-xs leading-relaxed text-muted-foreground">
              <p>
                New work is held across all projects. Workers keep their
                sessions, worktrees and changes.
              </p>
              {plan.projects?.map((project) => (
                <p key={project.id}>
                  <span className="font-medium text-foreground">
                    {project.name}
                  </span>
                  : {project.phase || "waiting"}
                </p>
              ))}
              {plan.targets?.map((target) => (
                <p key={`${target.projectId || ""}:${target.taskId}`}>
                  <span className="font-medium text-foreground">
                    {target.projectName ? `${target.projectName} · ` : ""}
                    {target.taskId}
                  </span>
                  : {String(target.progress || "waiting").replaceAll("-", " ")}
                </p>
              ))}
              {plan.reasons?.map((reason) => (
                <p key={reason}>{reason}</p>
              ))}
              {plan.manager?.interrupted && (
                <p>
                  The manager was interrupted, not completed. Continue in the
                  conversation after returning to work. Voice will remain
                  disconnected.
                </p>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {status?.supported && (
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
            {phase === "available" && (
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
            {phase === "downloaded" && !planActive && (
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
            {phase === "downloaded" &&
              status?.installBlocked &&
              !planActive && (
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() => void request("pause-update")}
                >
                  Pause work and update
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
                  Cancel update
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
                  Paused workers stay paused. Already queued work, including
                  queued resumes, may continue. Review each conversation before
                  resuming anything else.
                </p>
              </>
            )}
            {phase === "downloaded" && status?.installBlocked && (
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
            Updates never restart Crew while a conversation, worker or project
            environment is active. Your local settings and work history stay on
            this Mac.
          </p>
          <a
            href="https://github.com/MattGibney/crew/releases/latest"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-xs text-primary underline underline-offset-4"
          >
            View releases on GitHub
          </a>
        </section>
      )}
    </div>
  );
}
