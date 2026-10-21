import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import {
  AudioLines,
  Circle,
  GitBranch,
  MessageSquare,
  Layers,
  NotebookPen,
  Settings2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useCrewManager } from "./useCrewManager.js";
import { WorkerAttention } from "./WorkerAttention.js";
import { UpdateControls } from "./UpdateControls.js";
import { Settings } from "./Settings.js";
import { WorkChat } from "./WorkChat.js";
import { workspaceWorkers, workerSelectionRemoved } from "./worker-model.js";
import { WorkerDetail } from "./WorkerDetail.js";
import { ManagerCallBar } from "./ManagerCallBar.js";
import { ProjectSwitcher } from "./ProjectSwitcher.js";
import { ManagerScratchpad } from "./ManagerScratchpad.js";
import crewMark from "../../../build/crew-mark.png";

export function App() {
  const manager = useCrewManager();
  const [pane, setPane] = useState("conversation");
  const [selectedWorker, setSelectedWorker] = useState<string | null>(null);
  const [settingsReturn, setSettingsReturn] = useState("conversation");
  const workspace = useRef<HTMLElement | null>(null),
    resizing = useRef(false);
  const [workerWidth, setWorkerWidth] = useState<number | null>(null);
  const [workspaceWidth, setWorkspaceWidth] = useState(1200);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0)
        setWorkspaceWidth(entry.contentRect.width);
    });
    if (workspace.current) observer.observe(workspace.current);
    return () => observer.disconnect();
  }, []);
  const maximumWorkerWidth = Math.round(Math.min(720, workspaceWidth * 0.6));
  const resizeWorkers = (width: number) => {
    const available = workspace.current?.getBoundingClientRect().width || 1024;
    setWorkerWidth(
      Math.round(Math.max(280, Math.min(width, 720, available * 0.6))),
    );
  };
  const openPane = (next: string) => {
    setPane(next);
  };
  const showWorker = (id: string) => {
    setSelectedWorker(id);
    openPane("detail");
  };
  const recordedTasks = manager.orchestration.tasks || [];
  const tasks = workspaceWorkers(recordedTasks).map((task) => ({
    ...task,
    pendingApprovalCount: task.archiveRestoration?.requiresRecovery
      ? 0
      : (manager.workerApprovals || []).filter(
          (request) =>
            request.taskId === task.id && request.runId === task.runId,
        ).length,
  }));
  useEffect(() => {
    if (workerSelectionRemoved(recordedTasks, selectedWorker)) {
      setSelectedWorker(null);
      setPane((current) => (current === "detail" ? "conversation" : current));
      setSettingsReturn((current) =>
        current === "detail" ? "conversation" : current,
      );
    }
  }, [recordedTasks, selectedWorker]);
  const selectedTask = tasks.find((task) => task.id === selectedWorker);
  const workspaceManager = {
    ...manager,
    workerApprovals: (manager.workerApprovals || []).filter((request) =>
      tasks.some(
        (task) =>
          task.id === request.taskId &&
          task.runId === request.runId &&
          !task.archiveRestoration?.requiresRecovery,
      ),
    ),
  };
  const approvalCount = workspaceManager.workerApprovals.length;
  const workerView = { ...manager.orchestration, tasks };
  const pending = tasks.reduce(
    (count, task) =>
      count + (task.attention || []).filter((item) => !item.ackedAt).length,
    0,
  );
  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <a
        href={
          pane === "conversation"
            ? "#manager-composer"
            : pane === "scratchpad"
              ? "#scratchpad-content"
              : "#workspace-content"
        }
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded-md focus:bg-background focus:p-3"
      >
        {pane === "conversation"
          ? "Skip to message"
          : "Skip to project content"}
      </a>
      <header
        className={`flex min-h-18 shrink-0 items-center justify-between gap-4 border-b px-5 sm:px-7 ${window.crewWindow?.integratedTitlebar ? "crew-window-header" : ""}`}
      >
        <div className="flex min-w-0 items-center gap-4">
          <div className="flex items-center gap-2.5">
            <img
              src={crewMark}
              alt=""
              width="34"
              height="34"
              className="size-8"
            />
            <span className="text-xl font-semibold tracking-tight">Crew</span>
          </div>
          <span className="h-6 border-l" aria-hidden="true" />
          <div className="min-w-0">
            <ProjectSwitcher fallbackName={manager.projectInfo?.name} />
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <GitBranch className="size-3" aria-hidden="true" />
              {manager.projectInfo?.mode === "fixture"
                ? "Acceptance workspace"
                : "Local workspace"}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          <Button
            variant={pane === "settings" ? "secondary" : "ghost"}
            aria-pressed={pane === "settings"}
            onClick={() => {
              if (pane !== "settings") setSettingsReturn(pane);
              openPane(pane === "settings" ? settingsReturn : "settings");
            }}
          >
            <Settings2 aria-hidden="true" />
            <span className="hidden sm:inline">Settings</span>
            <span className="sr-only sm:hidden">Settings</span>
          </Button>
          <div className="crew-window-status flex items-center gap-2">
            <UpdateControls liveStatus={manager.updates} />
            <Circle
              className={`size-2 ${manager.eventReady ? "fill-primary text-primary" : ""}`}
              aria-hidden="true"
            />
            <span className="hidden sm:inline">
              {manager.eventReady ? "Controller connected" : "Reconnecting…"}
            </span>
            {pane !== "settings" && manager.voice.active && (
              <Badge variant="secondary">
                <AudioLines className="size-3" aria-hidden="true" />
                Voice connected
              </Badge>
            )}
          </div>
        </div>
      </header>
      <nav
        aria-label="Workspace views"
        className={`${["conversation", "workers", "scratchpad"].includes(pane) ? "flex" : "hidden"} shrink-0 gap-1 border-b px-3 py-2 sm:px-5`}
      >
        <Button
          variant={pane === "conversation" ? "secondary" : "ghost"}
          aria-pressed={pane === "conversation"}
          className="h-8 text-xs"
          onClick={() => openPane("conversation")}
        >
          <MessageSquare />
          Conversation{" "}
          {approvalCount > 0 && (
            <Badge>
              {approvalCount} approval{approvalCount === 1 ? "" : "s"}
            </Badge>
          )}
        </Button>
        <Button
          variant={pane === "workers" ? "secondary" : "ghost"}
          aria-pressed={pane === "workers"}
          className="h-8 text-xs"
          onClick={() => openPane("workers")}
        >
          <Layers />
          Workers {pending > 0 && <Badge>{pending}</Badge>}
        </Button>
        <Button
          variant={pane === "scratchpad" ? "secondary" : "ghost"}
          aria-pressed={pane === "scratchpad"}
          className="h-8 text-xs"
          onClick={() => openPane("scratchpad")}
        >
          <NotebookPen />
          Scratchpad
        </Button>
      </nav>
      <main
        ref={workspace}
        id="workspace-content"
        style={
          workerWidth === null
            ? undefined
            : ({ "--crew-worker-width": `${workerWidth}px` } as CSSProperties)
        }
        className={`${pane === "conversation" || pane === "workers" ? "grid" : "hidden"} min-h-0 flex-1 ${pane === "conversation" ? "manager-split" : ""}`}
      >
        <section
          aria-label="Manager workspace"
          className={`min-h-0 min-w-0 overflow-y-auto flex-col ${pane === "conversation" ? "flex" : "hidden"}`}
        >
          <WorkChat manager={workspaceManager} />
        </section>
        <div
          role="separator"
          aria-label="Resize worker panel"
          aria-orientation="vertical"
          aria-valuemin={280}
          aria-valuemax={maximumWorkerWidth}
          aria-valuenow={Math.min(workerWidth || 560, maximumWorkerWidth)}
          tabIndex={pane === "conversation" ? 0 : -1}
          className={`${pane === "conversation" ? "hidden lg:block" : "hidden"} relative z-10 cursor-col-resize touch-none bg-border outline-none before:absolute before:inset-y-0 before:-left-1.5 before:w-3 hover:bg-primary focus-visible:bg-primary focus-visible:ring-2 focus-visible:ring-ring`}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            resizing.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (resizing.current) {
              event.preventDefault();
              resizeWorkers(
                (workspace.current?.getBoundingClientRect().right ||
                  event.clientX) - event.clientX,
              );
            }
          }}
          onPointerUp={(event) => {
            if (resizing.current)
              resizeWorkers(
                (workspace.current?.getBoundingClientRect().right ||
                  event.clientX) - event.clientX,
              );
            resizing.current = false;
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => {
            resizing.current = false;
          }}
          onLostPointerCapture={() => {
            resizing.current = false;
          }}
          onDoubleClick={() => setWorkerWidth(null)}
          onKeyDown={(event) => {
            const current =
              workspace.current?.querySelector("aside")?.getBoundingClientRect()
                .width || 560;
            if (
              ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
            ) {
              event.preventDefault();
              resizeWorkers(
                event.key === "Home"
                  ? 280
                  : event.key === "End"
                    ? 720
                    : current + (event.key === "ArrowLeft" ? 32 : -32),
              );
            }
          }}
        />
        <aside
          aria-label="Project workers"
          className={`min-h-0 min-w-0 overflow-y-auto bg-muted/25 p-5 ${pane === "conversation" ? "hidden lg:block" : pane === "workers" ? "block" : "hidden"}`}
        >
          <WorkerAttention
            compact={pane === "conversation"}
            view={workerView}
            onSelect={showWorker}
          />
        </aside>
      </main>
      <div
        className={`${pane === "detail" ? "flex" : "hidden"} min-h-0 flex-1 flex-col`}
      >
        {selectedTask ? (
          <WorkerDetail
            key={selectedTask.id}
            task={selectedTask}
            manager={workspaceManager}
            onBack={() => openPane("conversation")}
            onManager={() => openPane("conversation")}
          />
        ) : (
          <section className="flex-1 p-8">
            <p>This worker is no longer available in this project.</p>
            <Button onClick={() => openPane("conversation")}>
              Back to manager
            </Button>
          </section>
        )}
      </div>
      <div
        className={`${pane === "scratchpad" ? "flex" : "hidden"} min-h-0 flex-1 flex-col`}
      >
        <ManagerScratchpad
          scratchpad={manager.work.managerScratchpad}
          scratchpadReadError={manager.work.managerScratchpadError}
          eventReady={manager.eventReady}
          tasks={tasks}
          onSelectWorker={showWorker}
        />
      </div>
      {pane !== "conversation" && pane !== "settings" && (
        <ManagerCallBar
          manager={manager}
          onManager={() => openPane("conversation")}
        />
      )}
      <audio
        id="audio"
        ref={manager.voice.audioRef}
        autoPlay
        className="hidden"
        aria-label="Manager voice playback"
      />
      <div
        className={`${pane === "settings" ? "flex" : "hidden"} min-h-0 flex-1`}
      >
        <Settings manager={manager} />
      </div>
    </div>
  );
}
