import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ChangeEvent, CSSProperties, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  GitBranch,
  Keyboard,
  Mic,
  Layers,
  NotebookPen,
  Settings2,
  Radio,
  UserRound,
  FolderGit2,
  LayoutDashboard,
  Link2,
  type LucideIcon,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronRight,
  CircleHelp,
  ExternalLink,
  FileText,
  Inbox,
  LoaderCircle,
  MessageSquare,
  Play,
  Plus,
  RotateCw,
  Settings,
  Square,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Message } from "../manager/Message";
import { readProfilePicture } from "../manager/profile";
import { AgentPicture, useAgentPicture } from "./AgentPicture";
import { WorkerReference } from "../manager/worker/WorkerReference";
import { WebLink } from "../manager/WebLink";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import type {
  Agent,
  AgentContent,
  AgentMessage,
  DeliveryMode,
  ExecutionReservation,
  HelpRequest,
  Job,
  JobStatus,
  MessageSender,
  RuntimeHistoryItem,
  Skill,
} from "../../../src/agents/contracts.mjs";
import type {
  AgentsClient,
  AgentsSnapshot,
  CreateJobInput,
  ProfileInput,
} from "./client";
import crewMark from "../../../build/crew-mark.png";
import "./agents.css";

export interface AgentSettingsPanel {
  id: string;
  label: string;
  description?: string;
  icon?: LucideIcon;
  render(context: {
    snapshot: AgentsSnapshot;
    refresh: () => Promise<void>;
    visible: boolean;
  }): ReactNode;
}
export interface AgentsAppProps {
  client: AgentsClient;
  /** #89 supplies access, connections and approval panels; foundation owns navigation. */
  settingsPanels?: AgentSettingsPanel[];
  banner?: ReactNode;
  /** Return null once owner setup is complete. Opening setup starts no work. */
  renderSetup?: (context: {
    snapshot: AgentsSnapshot;
    refresh: () => Promise<void>;
    openSettings: (pageId: string) => void;
  }) => ReactNode;
  /** Mounted once. Visibility controls presentation only; the app owns call lifetime. */
  renderVoice?: (context: {
    primaryAgent: Agent | null;
    snapshot: AgentsSnapshot;
    visible: boolean;
    mode: "voice" | "compact" | "hidden";
    controlsTarget: HTMLElement | null;
    transcriptTarget: HTMLElement | null;
  }) => ReactNode;
  headerActions?: ReactNode;
  headerUpdates?: ReactNode;
  nativeWindow?: boolean;
  navigationRequest?: { id: string; view: View };
  renderPreparationActions?: (context: {
    snapshot: AgentsSnapshot;
    refresh: () => Promise<void>;
  }) => ReactNode;
}

type Action = (
  key: string,
  operation: () => Promise<unknown>,
  success?: string,
) => Promise<boolean>;
type View =
  | "conversation"
  | "agents"
  | "scratchpad"
  | "inbox"
  | "prepare"
  | "settings"
  | "updates";
const statusLabels: Record<JobStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  blocked: "Blocked",
  ready: "Ready",
  completed: "Completed",
  cancelled: "Cancelled",
};

export function AgentsApp({
  client,
  settingsPanels = [],
  banner,
  renderSetup,
  renderVoice,
  headerActions,
  headerUpdates,
  nativeWindow = false,
  navigationRequest,
  renderPreparationActions,
}: AgentsAppProps) {
  const [snapshot, setSnapshot] = useState<AgentsSnapshot | null>(null);
  const [view, setView] = useState<View>("conversation");
  const [settingsReturn, setSettingsReturn] = useState<View>("conversation");
  const [settingsRequest, setSettingsRequest] = useState({
    id: "initial",
    page: "crew-sessions",
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [visitedIds, setVisitedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [historyVersion, setHistoryVersion] = useState(0);
  const [inputMode, setInputMode] = useState<"text" | "voice">("voice");
  const [composerVoiceTarget, setComposerVoiceTarget] =
    useState<HTMLElement | null>(null);
  const [transcriptTarget, setTranscriptTarget] = useState<HTMLElement | null>(
    null,
  );
  const [secondaryVoiceTarget, setSecondaryVoiceTarget] =
    useState<HTMLElement | null>(null);
  const [workerWidth, setWorkerWidth] = useState<number | null>(null);
  const [workspaceWidth, setWorkspaceWidth] = useState(1000);
  const workspace = useRef<HTMLElement | null>(null);
  const resizing = useRef(false);
  const locks = useRef(new Set<string>());
  const refreshVersion = useRef(0);
  const alive = useRef(true);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current =
    view === "conversation" ? primaryAgentId(snapshot) : selectedId;
  const refresh = useCallback(async () => {
    const request = ++refreshVersion.current;
    const next = await client.readSnapshot();
    if (alive.current && request === refreshVersion.current) setSnapshot(next);
  }, [client]);
  useEffect(() => {
    alive.current = true;
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    let historyChanged = false;
    void refresh().catch((cause: unknown) => setError(errorText(cause)));
    const unsubscribe = client.subscribe((event) => {
      if (
        event.kind === "runtime" &&
        event.event.binding.agentId === selectedRef.current
      )
        historyChanged = true;
      if (scheduled !== undefined) return;
      scheduled = setTimeout(() => {
        scheduled = undefined;
        void refresh().catch((cause: unknown) => setError(errorText(cause)));
        if (historyChanged) setHistoryVersion((value) => value + 1);
        historyChanged = false;
      }, 150);
    });
    return () => {
      alive.current = false;
      refreshVersion.current++;
      clearTimeout(scheduled);
      unsubscribe();
    };
  }, [client, refresh]);
  useEffect(() => {
    if (!navigationRequest) return;
    if (
      navigationRequest.view === "prepare" ||
      navigationRequest.view === "inbox" ||
      navigationRequest.view === "updates"
    ) {
      setSettingsRequest({
        id: navigationRequest.id,
        page:
          navigationRequest.view === "updates"
            ? "crew-updates"
            : navigationRequest.view === "prepare"
              ? "crew-preparation"
              : "crew-attention",
      });
      setView("settings");
    } else setView(navigationRequest.view);
  }, [navigationRequest?.id]);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0)
        setWorkspaceWidth(entry.contentRect.width);
    });
    if (workspace.current) observer.observe(workspace.current);
    return () => observer.disconnect();
  }, [Boolean(snapshot)]);
  const act: Action = async (key, operation, success) => {
    if (locks.current.has(key)) return false;
    locks.current.add(key);
    setPending(new Set(locks.current));
    setError("");
    let completed = false;
    try {
      const result = await operation();
      if (
        result &&
        typeof result === "object" &&
        "state" in result &&
        (result.state === "failed" || result.state === "uncertain")
      ) {
        const detail = "error" in result ? result.error : null;
        throw new Error(
          detail && typeof detail === "object" && "message" in detail
            ? String(detail.message)
            : `The operation is ${result.state}.`,
        );
      }
      completed = true;
      if (success) setToast(success);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      try {
        await refresh();
      } catch (cause) {
        setError(errorText(cause));
      }
      locks.current.delete(key);
      if (alive.current) setPending(new Set(locks.current));
    }
    return completed;
  };
  const primary =
    snapshot?.agents.find((agent) => agent.id === primaryAgentId(snapshot)) ??
    null;
  const showWorker = (id: string) => {
    setVisitedIds((current) => new Set([...current, id]));
    setSelectedId(id);
    setView("agents");
  };
  const openSettings = (page?: string) => {
    if (view !== "settings") setSettingsReturn(view);
    if (page) setSettingsRequest({ id: crypto.randomUUID(), page });
    setView("settings");
  };
  const setup = snapshot
    ? renderSetup?.({ snapshot, refresh, openSettings })
    : null;
  const setupVisible = Boolean(setup) && view !== "settings";
  const attentionCount =
    (snapshot?.helpRequests.filter(
      (item) => item.target.type === "user" && item.state === "open",
    ).length ?? 0) + (snapshot?.nativeApprovals.length ?? 0);
  const maximumWorkerWidth = Math.round(Math.min(720, workspaceWidth * 0.6));
  const resizeWorkers = (width: number) =>
    setWorkerWidth(
      Math.round(Math.max(280, Math.min(width, 720, workspaceWidth * 0.6))),
    );
  const panels: AgentSettingsPanel[] = snapshot
    ? [
        {
          id: "crew-sessions",
          label: "Sessions",
          description: "Manage the live manager session for this project.",
          icon: Radio,
          render: () =>
            primary ? (
              <AgentSessionPanel
                agent={primary}
                skills={snapshot.skills}
                pending={pending}
                act={act}
                client={client}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                Choose your primary agent during setup.
              </p>
            ),
        },
        {
          id: "crew-manager",
          label: "Manager profile",
          description:
            "Customize your manager’s identity, personality, instructions and project skills.",
          icon: UserRound,
          render: () =>
            primary ? (
              <ProfileEditor
                key={primary.id}
                agent={primary}
                client={client}
                skills={snapshot.skills}
                pending={pending.has(`profile-${primary.id}`)}
                onSave={async (input) => {
                  let saved: Agent | null = null;
                  const success = await act(
                    `profile-${primary.id}`,
                    async () => {
                      saved = await client.saveProfile(primary.id, {
                        ...input,
                        expectedRevision:
                          input.expectedRevision ?? primary.profile.revision,
                      });
                    },
                    "Profile saved. Use Start or Restart to apply it.",
                  );
                  return success ? saved : null;
                }}
              />
            ) : null,
        },
        ...settingsPanels,
        {
          id: "crew-attention",
          label: "Questions and approvals",
          description: "Review requests that need your decision.",
          icon: CircleHelp,
          render: () => (
            <OwnerInbox
              snapshot={snapshot}
              client={client}
              pending={pending}
              act={act}
              openAgent={showWorker}
            />
          ),
        },
        {
          id: "crew-preparation",
          label: "Restart and Quit",
          description:
            "Review continuation notes and readiness before closing Crew.",
          icon: RotateCw,
          render: () => (
            <Preparation
              snapshot={snapshot}
              client={client}
              pending={pending}
              act={act}
              actions={renderPreparationActions?.({ snapshot, refresh })}
            />
          ),
        },
      ]
    : [];
  const detailVisible = view === "agents" && selectedId !== null;
  const normalView =
    !setupVisible &&
    (view === "conversation" || view === "agents" || view === "scratchpad") &&
    !detailVisible;
  return (
    <div className="agents-app flex h-dvh min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <a
        href={
          view === "conversation" ? "#manager-composer" : "#workspace-content"
        }
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded-md focus:bg-background focus:p-3"
      >
        {view === "conversation"
          ? "Skip to message"
          : "Skip to project content"}
      </a>
      <header
        className={`flex min-h-18 shrink-0 items-center justify-between gap-4 border-b px-5 sm:px-7 ${nativeWindow ? "crew-window-header" : ""}`}
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
            {headerActions || (
              <span className="block truncate text-sm font-medium">
                {snapshot?.projectName || "Opening project…"}
              </span>
            )}
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <GitBranch className="size-3" aria-hidden="true" />
              Local workspace
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant={view === "settings" ? "secondary" : "ghost"}
            aria-pressed={view === "settings"}
            onClick={() => {
              if (view === "settings") setView(settingsReturn);
              else openSettings();
            }}
          >
            <Settings2 aria-hidden="true" />
            <span className="hidden sm:inline">Settings</span>
            <span className="sr-only sm:hidden">Settings</span>
          </Button>
          {headerUpdates}
        </div>
      </header>
      {banner && (
        <div className="shrink-0 border-b bg-muted/50 px-5 py-2 text-center text-xs text-muted-foreground">
          {banner}
        </div>
      )}
      <nav
        aria-label="Workspace views"
        className={`${normalView ? "flex" : "hidden"} shrink-0 gap-1 border-b px-3 py-2 sm:px-5`}
      >
        <Button
          variant={view === "conversation" ? "secondary" : "ghost"}
          aria-pressed={view === "conversation"}
          className="h-8 text-xs"
          onClick={() => {
            setView("conversation");
            setSelectedId(null);
          }}
        >
          <MessageSquare />
          Conversation
          {attentionCount > 0 && <Badge>{attentionCount} to review</Badge>}
        </Button>
        <Button
          variant={view === "agents" ? "secondary" : "ghost"}
          aria-pressed={view === "agents"}
          className="h-8 text-xs"
          onClick={() => {
            setView("agents");
            setSelectedId(null);
          }}
        >
          <Layers />
          Workers
        </Button>
        <Button
          variant={view === "scratchpad" ? "secondary" : "ghost"}
          aria-pressed={view === "scratchpad"}
          className="h-8 text-xs"
          onClick={() => setView("scratchpad")}
        >
          <NotebookPen />
          Scratchpad
        </Button>
      </nav>
      {error && (
        <div
          role="alert"
          className="mx-5 my-3 flex shrink-0 items-start justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
        >
          <span>{error}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Dismiss error"
            onClick={() => setError("")}
          >
            <X />
          </Button>
        </div>
      )}
      {!snapshot && (
        <div className="m-8">
          <Empty
            title={error ? "Project unavailable" : "Loading project"}
            icon={<LoaderCircle className={error ? "" : "animate-spin"} />}
          >
            <Button
              variant="outline"
              onClick={() => void act("refresh", refresh)}
            >
              Retry
            </Button>
          </Empty>
        </div>
      )}
      {snapshot && (
        <>
          {setupVisible && (
            <section className="min-h-0 flex-1 overflow-auto">{setup}</section>
          )}
          <main
            ref={workspace}
            id="workspace-content"
            style={
              workerWidth === null
                ? undefined
                : ({
                    "--crew-worker-width": `${workerWidth}px`,
                  } as CSSProperties)
            }
            className={`${!setupVisible && (view === "conversation" || (view === "agents" && !selectedId)) ? "grid" : "hidden"} min-h-0 flex-1 ${view === "conversation" ? "manager-split" : ""}`}
          >
            <section
              aria-label="Manager workspace"
              className={`${view === "conversation" ? "flex" : "hidden"} min-h-0 min-w-0 flex-col overflow-hidden`}
            >
              {primary ? (
                <Conversation
                  key={primary.id}
                  agent={primary}
                  snapshot={snapshot}
                  client={client}
                  pending={pending}
                  act={act}
                  historyVersion={historyVersion}
                  visible={!setupVisible && view === "conversation"}
                  readOnly={false}
                  onReturnToPrimary={() => setView("conversation")}
                  inputMode={inputMode}
                  onInputMode={setInputMode}
                  voiceTarget={setComposerVoiceTarget}
                  transcriptTarget={setTranscriptTarget}
                  hasVoice={Boolean(renderVoice)}
                  onOpenSettings={() => openSettings("crew-sessions")}
                  attention={
                    attentionCount > 0 ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openSettings("crew-attention")}
                      >
                        <CircleHelp />
                        {attentionCount} question
                        {attentionCount === 1 ? "" : "s"} or approval
                        {attentionCount === 1 ? "" : "s"} to review
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <div className="m-8">
                  <Empty icon={<Settings />} title="Set up your manager">
                    <p>Choose your primary agent in Project settings.</p>
                    <Button onClick={() => openSettings()}>
                      Open settings
                    </Button>
                  </Empty>
                </div>
              )}
            </section>
            <div
              role="separator"
              aria-label="Resize worker panel"
              aria-orientation="vertical"
              aria-valuemin={280}
              aria-valuemax={maximumWorkerWidth}
              aria-valuenow={Math.min(workerWidth || 560, maximumWorkerWidth)}
              tabIndex={view === "conversation" ? 0 : -1}
              className={`${view === "conversation" ? "hidden lg:block" : "hidden"} relative z-10 cursor-col-resize touch-none bg-border outline-none before:absolute before:inset-y-0 before:-left-1.5 before:w-3 hover:bg-primary focus-visible:bg-primary focus-visible:ring-2 focus-visible:ring-ring`}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                resizing.current = true;
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (resizing.current)
                  resizeWorkers(
                    (workspace.current?.getBoundingClientRect().right ||
                      event.clientX) - event.clientX,
                  );
              }}
              onPointerUp={(event) => {
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
                const offset =
                  event.key === "ArrowLeft"
                    ? 32
                    : event.key === "ArrowRight"
                      ? -32
                      : 0;
                if (offset || event.key === "Home" || event.key === "End") {
                  event.preventDefault();
                  resizeWorkers(
                    event.key === "Home"
                      ? 280
                      : event.key === "End"
                        ? 720
                        : (workerWidth || 560) + offset,
                  );
                }
              }}
            />
            <aside
              aria-label="Project workers"
              className={`min-h-0 min-w-0 overflow-y-auto bg-muted/25 p-5 ${view === "conversation" ? "hidden lg:block" : "block"}`}
            >
              <AgentWorkerList
                snapshot={snapshot}
                client={client}
                onSelect={showWorker}
                compact={view === "conversation"}
              />
            </aside>
          </main>
          {snapshot.agents
            .filter(
              (agent) => visitedIds.has(agent.id) && agent.id !== primary?.id,
            )
            .map((agent) => (
              <div
                key={agent.id}
                hidden={
                  setupVisible || !detailVisible || selectedId !== agent.id
                    ? true
                    : undefined
                }
                className="min-h-0 flex-1 flex-col overflow-hidden flex"
              >
                <AgentDetail
                  agent={agent}
                  snapshot={snapshot}
                  client={client}
                  pending={pending}
                  act={act}
                  historyVersion={historyVersion}
                  visible={
                    !setupVisible && detailVisible && selectedId === agent.id
                  }
                  onBack={() => {
                    setSelectedId(null);
                    setView("conversation");
                  }}
                  onArchived={() => {
                    setSelectedId(null);
                    setView("agents");
                  }}
                />
              </div>
            ))}
          <section
            hidden={setupVisible || view !== "scratchpad"}
            className="min-h-0 flex-1 overflow-y-auto px-5 py-8 sm:px-8"
          >
            {primary && <AgentScratchpad agent={primary} />}
          </section>
          <div
            ref={setSecondaryVoiceTarget}
            hidden={
              setupVisible || view === "conversation" || view === "settings"
            }
            className="shrink-0 border-t bg-background"
          />
          <div
            hidden={setupVisible || view !== "settings"}
            className="min-h-0 flex-1 flex overflow-hidden"
          >
            <SettingsView
              snapshot={snapshot}
              panels={panels}
              refresh={refresh}
              visible={view === "settings" && !setupVisible}
              requestedPage={settingsRequest}
            />
          </div>
          {renderVoice?.({
            primaryAgent: primary,
            snapshot,
            visible: !setupVisible && view !== "settings",
            mode:
              setupVisible || view === "settings"
                ? "hidden"
                : view === "conversation"
                  ? inputMode === "voice"
                    ? "voice"
                    : "compact"
                  : "compact",
            transcriptTarget,
            controlsTarget:
              view === "conversation"
                ? composerVoiceTarget
                : secondaryVoiceTarget,
          })}
        </>
      )}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed right-4 bottom-4 z-50 flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-xl border bg-background px-4 py-3 text-sm shadow-lg"
        >
          <Check className="size-4 shrink-0 text-primary" />
          <span>{toast}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Dismiss confirmation"
            onClick={() => setToast("")}
          >
            <X />
          </Button>
        </div>
      )}
    </div>
  );
}

function AgentWorkerList({
  snapshot,
  client,
  onSelect,
  compact,
}: {
  snapshot: AgentsSnapshot;
  client: AgentsClient;
  onSelect(id: string): void;
  compact: boolean;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const workers = snapshot.agents.filter(
    (agent) =>
      agent.id !== primaryAgentId(snapshot) &&
      (showArchived || !agent.archivedAt),
  );
  return (
    <section aria-label="Workers and worktrees" className="min-w-0 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">
            Your crew{" "}
            <span className="ml-1 text-muted-foreground">{workers.length}</span>
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Independent work. One manager.
          </p>
        </div>
        <Layers className="size-4 text-muted-foreground" aria-hidden="true" />
      </div>
      {snapshot.agents.some((agent) => agent.archivedAt) && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
          />
          Show archived
        </label>
      )}
      {!workers.length && (
        <div className="rounded-xl border border-dashed px-5 py-9 text-center">
          <FolderGit2 className="mx-auto mb-3 size-6 text-muted-foreground" />
          <h3 className="text-sm font-medium">A workspace for every task</h3>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            Agree a task with your manager. Its worker and progress appear here.
          </p>
        </div>
      )}
      <div className="grid auto-rows-fr grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-2.5">
        {workers.map((agent) => {
          const job = snapshot.jobs
            .filter((job) => job.assignment.assignedToAgentId === agent.id)
            .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
          return (
            <article key={agent.id} className="h-full min-w-0">
              <button
                type="button"
                onClick={() => onSelect(agent.id)}
                aria-label={`Open worker ${agent.profile.name}`}
                className="group flex h-full w-full min-w-0 flex-col rounded-xl border bg-card p-3 text-left shadow-xs transition-colors hover:border-primary/40 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="flex min-h-5 flex-wrap items-center justify-between gap-1.5">
                  <WorkerReference
                    assignment={{
                      ticket:
                        job?.work.type === "ticket" ? job.work.ticket.url : "",
                    }}
                    fallback={agent.profile.name}
                    className="text-[11px] font-medium text-muted-foreground"
                  />
                  {job && (
                    <Badge variant="outline" className="max-w-64 text-[10px]">
                      {job.progress.label || statusLabels[job.progress.status]}
                      {job.progress.percent !== null
                        ? ` · ${job.progress.percent}%`
                        : ""}
                    </Badge>
                  )}
                </div>
                <div className="mt-2 flex items-start gap-2.5">
                  <AgentPicture
                    client={client}
                    imageRef={agent.profile.pictureRef}
                    className="mt-0.5 size-7"
                  />
                  <h3 className="min-h-10 line-clamp-2 break-words text-sm font-semibold leading-5">
                    {job
                      ? job.work.type === "local"
                        ? job.work.title
                        : job.assignment.instruction?.split("\n")[0] ||
                          agent.profile.name
                      : agent.profile.name}
                  </h3>
                </div>
                {!compact && (
                  <p className="mt-1 min-h-5 line-clamp-1 break-words text-xs leading-5 text-muted-foreground">
                    {job?.progress.detail || "No progress detail reported"}
                  </p>
                )}
                {!compact && (
                  <p className="mt-auto pt-2 text-[10px] text-muted-foreground">
                    {agent.archivedAt
                      ? "Archived"
                      : `Session ${agent.runtime.session.observedState}`}
                  </p>
                )}
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function AgentSessionPanel({
  agent,
  skills,
  client,
  pending,
  act,
}: {
  agent: Agent;
  skills: Skill[];
  client: AgentsClient;
  pending: Set<string>;
  act: Action;
}) {
  const session = agent.runtime.session;
  const busy =
    ["starting", "stopping"].includes(session.observedState) ||
    pending.has(`lifecycle-${agent.id}`);
  const pendingProfile =
    !session.appliedConfiguration ||
    session.appliedConfiguration.profileRevision !== agent.profile.revision ||
    !sameSkills(agent, skills);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Badge
          variant={
            session.observedState === "started" ? "secondary" : "outline"
          }
        >
          {session.observedState}
        </Badge>
        <div className="flex flex-wrap gap-2">
          {(["start", "stop", "restart"] as const).map((action) => (
            <Button
              key={action}
              variant="outline"
              disabled={
                busy ||
                Boolean(agent.archivedAt) ||
                (action === "start" && session.observedState === "started") ||
                (action === "stop" && session.observedState === "stopped")
              }
              onClick={() =>
                void act(`lifecycle-${agent.id}`, () =>
                  client.lifecycle(agent.id, action),
                )
              }
            >
              {action === "start" ? (
                <Play />
              ) : action === "stop" ? (
                <Square />
              ) : (
                <RotateCw />
              )}
              {action[0].toUpperCase() + action.slice(1)}
            </Button>
          ))}
        </div>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        Stop preserves the conversation, notes and resources. Start never
        connects voice or creates an assignment.
      </p>
      {pendingProfile && (
        <p role="status" className="text-sm text-muted-foreground">
          {session.observedState === "started"
            ? "Saved instructions or skills are waiting for Restart."
            : "Start applies your saved instructions and skills."}
        </p>
      )}
      {session.lastError && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive"
        >
          {session.lastError.message}
        </p>
      )}
    </div>
  );
}

function AgentScratchpad({ agent }: { agent: Agent }) {
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h1 className="text-lg font-semibold">Work notes</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The agent’s visible working notes. Read only.
        </p>
      </div>
      {agent.scratchpad.markdown ? (
        <div className="agent-markdown text-sm leading-7">
          <Markdown text={agent.scratchpad.markdown} />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No notes saved yet.</p>
      )}
      <p className="text-xs text-muted-foreground">
        Last saved {formatDate(agent.scratchpad.updatedAt)}
      </p>
    </div>
  );
}

function AgentDetail({
  agent,
  snapshot,
  client,
  pending,
  act,
  historyVersion,
  visible,
  onBack,
  onArchived,
}: {
  agent: Agent;
  snapshot: AgentsSnapshot;
  client: AgentsClient;
  pending: Set<string>;
  act: Action;
  historyVersion: number;
  visible: boolean;
  onBack(): void;
  onArchived(): void;
}) {
  const [tab, setTab] = useState<
    "overview" | "conversation" | "notes" | "links"
  >("conversation");
  const jobs = snapshot.jobs.filter(
    (job) => job.assignment.assignedToAgentId === agent.id,
  );
  return (
    <section
      aria-label="Worker detail"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="shrink-0 border-b px-5 pt-4 sm:px-8">
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 h-7 shrink-0 text-xs text-muted-foreground"
            onClick={onBack}
          >
            <ArrowLeft />
            Back to manager
          </Button>
          <span className="hidden h-4 border-l sm:block" />
          <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">
            {agent.profile.name}
          </h1>
          <Badge variant="outline" className="text-[10px]">
            Session {agent.runtime.session.observedState}
          </Badge>
        </div>
        <div
          role="tablist"
          aria-label="Worker detail tabs"
          className="-mb-px mt-3 flex gap-4 overflow-x-auto sm:gap-5"
        >
          {(
            [
              ["overview", "Overview", LayoutDashboard],
              ["conversation", "Conversation", MessageSquare],
              ["notes", "Work notes", FileText],
              ["links", "Links", Link2],
            ] as const
          ).map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={`flex shrink-0 items-center gap-2 border-b-2 pb-3 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring ${tab === value ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
            >
              <Icon className="size-3.5" />
              {label}
            </button>
          ))}
        </div>
      </div>
      <div
        hidden={tab !== "conversation"}
        className="min-h-0 flex-1 flex flex-col"
      >
        <Conversation
          agent={agent}
          snapshot={snapshot}
          client={client}
          pending={pending}
          act={act}
          historyVersion={historyVersion}
          visible={visible && tab === "conversation"}
          readOnly
          onReturnToPrimary={onBack}
        />
      </div>
      <div
        hidden={tab !== "notes"}
        className="min-h-0 flex-1 overflow-auto px-5 py-6 sm:px-8"
      >
        <AgentScratchpad agent={agent} />
      </div>
      <div
        hidden={tab !== "overview"}
        className="min-h-0 flex-1 overflow-auto px-5 py-6 sm:px-8"
      >
        <div className="mx-auto max-w-4xl space-y-8">
          <AgentSessionPanel
            agent={agent}
            skills={snapshot.skills}
            client={client}
            pending={pending}
            act={act}
          />
          <JobsView
            agent={agent}
            snapshot={snapshot}
            client={client}
            pending={pending}
            act={act}
          />
          <details className="border-t pt-5">
            <summary className="text-sm font-medium">
              Profile and instructions
            </summary>
            <div className="mt-5">
              <ProfileEditor
                agent={agent}
                client={client}
                skills={snapshot.skills}
                pending={pending.has(`profile-${agent.id}`)}
                onSave={async (input) => {
                  let saved: Agent | null = null;
                  const success = await act(
                    `profile-${agent.id}`,
                    async () => {
                      saved = await client.saveProfile(agent.id, {
                        ...input,
                        expectedRevision:
                          input.expectedRevision ?? agent.profile.revision,
                      });
                    },
                    "Profile saved. Use Start or Restart to apply it.",
                  );
                  return success ? saved : null;
                }}
              />
            </div>
          </details>
          <p className="text-xs text-muted-foreground">
            Reports to {actorLabel(agent.reportsTo, snapshot)} ·{" "}
            {agent.access.permissionGroupIds.length} permission groups ·{" "}
            {agent.access.serviceConnectionIds.length} connections
          </p>
          {!agent.archivedAt && (
            <Button
              variant="outline"
              disabled={pending.has(`archive-${agent.id}`)}
              onClick={async () => {
                if (
                  await act(
                    `archive-${agent.id}`,
                    () => client.archiveAgent(agent.id),
                    "Agent archived. Its history and resources are retained.",
                  )
                )
                  onArchived();
              }}
            >
              Archive worker
            </Button>
          )}
        </div>
      </div>
      <div
        hidden={tab !== "links"}
        className="min-h-0 flex-1 overflow-auto px-5 py-6 sm:px-8"
      >
        <div className="mx-auto max-w-3xl space-y-4">
          {jobs
            .filter((job) => job.work.type === "ticket")
            .map((job) => (
              <p key={job.id}>
                {job.work.type === "ticket" && (
                  <SafeLink url={job.work.ticket.url}>
                    {job.work.ticket.externalId}
                  </SafeLink>
                )}
              </p>
            ))}
          {agent.resources.map((resource) => (
            <div key={resource.id} className="rounded-lg border p-4">
              <p className="text-sm font-medium">{resource.kind}</p>
              <p className="mt-1 break-all text-xs text-muted-foreground">
                {resource.location}
              </p>
            </div>
          ))}
          {!agent.resources.length &&
            !jobs.some((job) => job.work.type === "ticket") && (
              <p className="text-sm text-muted-foreground">
                No links or resources attached.
              </p>
            )}
        </div>
      </div>
    </section>
  );
}

function Conversation({
  agent,
  snapshot,
  client,
  pending,
  act,
  historyVersion,
  visible,
  readOnly,
  onReturnToPrimary,
  inputMode = "text",
  onInputMode,
  voiceTarget,
  transcriptTarget,
  hasVoice = false,
  onOpenSettings,
  attention,
}: {
  agent: Agent;
  snapshot: AgentsSnapshot;
  client: AgentsClient;
  pending: Set<string>;
  act: Action;
  historyVersion: number;
  visible: boolean;
  readOnly: boolean;
  onReturnToPrimary: () => void;
  inputMode?: "text" | "voice";
  onInputMode?: (mode: "text" | "voice") => void;
  voiceTarget?: (node: HTMLDivElement | null) => void;
  transcriptTarget?: (node: HTMLDivElement | null) => void;
  hasVoice?: boolean;
  onOpenSettings?: () => void;
  attention?: ReactNode;
}) {
  const [items, setItems] = useState<RuntimeHistoryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const sequence = useRef(0);
  const draftKey = `crew-agent-draft:${snapshot.projectId}:${agent.id}`;
  const [draft, setDraft] = useState(() => readComposerDraft(draftKey));
  useEffect(() => {
    if (readOnly) return;
    try {
      if (draft) localStorage.setItem(draftKey, draft);
      else localStorage.removeItem(draftKey);
    } catch {
      /* Unavailable local storage never discards an in-memory draft. */
    }
  }, [draft, draftKey, readOnly]);
  const [mode, setMode] = useState<DeliveryMode>("steer");
  const intents = snapshot.pendingMessages.filter(
    (message) =>
      message.recipientAgentId === agent.id && message.sender.type !== "system",
  );
  const receipts = snapshot.receipts.filter(
    (receipt) =>
      receipt.recipientAgentId === agent.id && receipt.sender.type !== "system",
  );
  const load = useCallback(
    async (nextCursor?: string) => {
      const request = ++sequence.current;
      setLoading(true);
      setHistoryError("");
      try {
        const result = await client.readHistory(agent.id, nextCursor);
        if (request !== sequence.current) return;
        if (result.state === "failed") {
          setHistoryError(result.error.message);
          return;
        }
        setItems((current) =>
          nextCursor
            ? uniqueHistory([...result.value.items, ...current])
            : uniqueHistory(result.value.items),
        );
        setCursor(result.value.nextCursor);
      } catch (cause) {
        if (request === sequence.current) setHistoryError(errorText(cause));
      } finally {
        if (request === sequence.current) setLoading(false);
      }
    },
    [agent.id, client],
  );
  useEffect(() => {
    if (visible && agent.runtime.threadId) void load();
    return () => {
      sequence.current++;
    };
  }, [visible, agent.runtime.threadId, historyVersion, load]);
  const send = async () => {
    const content = draft.trim();
    if (!content || readOnly) return;
    const submitted = draft;
    const success = await act(`send-${agent.id}`, () =>
      client.sendMessage({
        recipientAgentId: agent.id,
        jobId: null,
        replyToMessageId: null,
        content: [{ type: "text", text: content }],
        deliveryMode: mode,
      }),
    );
    if (success) {
      setDraft((current) => (current === submitted ? "" : current));
      await load();
    }
  };
  const effectiveMode = hasVoice ? inputMode : "text";
  return (
    <MessageScrollerProvider
      autoScroll
      defaultScrollPosition="end"
      scrollEdgeThreshold={8}
    >
      <div className="relative flex min-h-0 flex-1 flex-col">
        <MessageScroller className="flex-1">
          <MessageScrollerViewport
            aria-label={
              readOnly ? "Worker conversation" : "Manager conversation"
            }
            className="px-5 sm:px-7 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40"
          >
            <MessageScrollerContent
              aria-label="Conversation messages"
              aria-live="off"
              className="mx-auto max-w-3xl gap-7 py-8"
            >
              {(attention ||
                historyError ||
                (!readOnly && agent.runtime.session.lastError)) && (
                <MessageScrollerItem
                  messageId="conversation-notices"
                  className="space-y-3"
                >
                  {attention}
                  {agent.runtime.session.lastError && !readOnly && (
                    <div
                      role="alert"
                      className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive"
                    >
                      {agent.runtime.session.lastError.message}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-2"
                        onClick={onOpenSettings}
                      >
                        Open Sessions
                      </Button>
                    </div>
                  )}
                  {historyError && (
                    <div
                      role="alert"
                      className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive"
                    >
                      {historyError}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-2"
                        onClick={() => void load()}
                      >
                        Retry history
                      </Button>
                    </div>
                  )}
                </MessageScrollerItem>
              )}
              {cursor && (
                <MessageScrollerItem
                  messageId="earlier-history"
                  className="text-center"
                >
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={loading}
                    onClick={() => void load(cursor)}
                  >
                    Load earlier history
                  </Button>
                </MessageScrollerItem>
              )}
              {!items.length && (
                <MessageScrollerItem messageId="conversation-empty">
                  <p className="text-center text-sm text-muted-foreground">
                    {loading
                      ? "Loading conversation…"
                      : historyError
                        ? "Saved history is currently unavailable."
                        : agent.runtime.threadId
                          ? "No messages yet."
                          : "Start your manager in Settings, then send your first message."}
                  </p>
                </MessageScrollerItem>
              )}
              {items
                .filter(
                  (item) =>
                    item.kind !== "other" && item.sender.type !== "system",
                )
                .map((item) => (
                  <MessageScrollerItem
                    key={item.runtimeRef}
                    messageId={item.runtimeRef}
                    scrollAnchor={item.sender.type === "user"}
                  >
                    <HistoryItem
                      item={item}
                      snapshot={snapshot}
                      client={client}
                      managerDirection={
                        readOnly && item.sender.type === "agent"
                      }
                    />
                  </MessageScrollerItem>
                ))}
              {!readOnly && (
                <div ref={transcriptTarget} className="empty:hidden" />
              )}
              {(intents.length > 0 || receipts.length > 0) && (
                <MessageScrollerItem messageId="delivery-activity">
                  <details className="rounded-lg border px-4 py-3 text-sm">
                    <summary className="text-xs font-medium text-muted-foreground">
                      Delivery activity
                      {intents.length ? ` · ${intents.length} pending` : ""}
                    </summary>
                    <div className="mt-3 divide-y">
                      {intents.map((message) => (
                        <DeliveryItem
                          key={message.id}
                          message={message}
                          client={client}
                          snapshot={snapshot}
                          act={act}
                          pending={pending}
                        />
                      ))}
                      {receipts
                        .slice(-10)
                        .reverse()
                        .map((receipt) => (
                          <p
                            key={receipt.messageId}
                            className="py-2 text-xs text-muted-foreground"
                          >
                            Accepted · {actorLabel(receipt.sender, snapshot)} ·{" "}
                            {formatDate(receipt.acknowledgedAt)}
                          </p>
                        ))}
                    </div>
                  </details>
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton
            size="sm"
            variant="outline"
            className="rounded-full px-3 shadow-md"
            aria-label="Jump to latest"
          >
            <ArrowDown className="size-3.5" />
            Jump to latest
          </MessageScrollerButton>
        </MessageScroller>
        {readOnly ? (
          <div className="shrink-0 border-t px-5 py-3 text-xs text-muted-foreground sm:px-8">
            Read-only worker history.{" "}
            <button
              type="button"
              className="underline underline-offset-4"
              onClick={onReturnToPrimary}
            >
              Return to your manager
            </button>{" "}
            to send directions.
          </div>
        ) : (
          <div className="shrink-0 space-y-3 bg-background px-5 pb-4 pt-2 sm:px-7">
            <div className="mx-auto max-w-3xl">
              <form
                id="manager-composer"
                tabIndex={-1}
                aria-label="Message and voice composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  void send();
                }}
                className="flex flex-col overflow-hidden rounded-xl border bg-background shadow-sm focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20"
              >
                {hasVoice && (
                  <div className="flex items-center justify-between gap-3 px-3 pt-2">
                    <div
                      role="tablist"
                      aria-label="Input method"
                      className="flex gap-1 rounded-lg bg-muted/60 p-0.5"
                    >
                      {(["text", "voice"] as const).map((mode) => (
                        <button
                          key={mode}
                          id={`input-tab-${mode}`}
                          type="button"
                          role="tab"
                          aria-selected={effectiveMode === mode}
                          aria-controls={`input-panel-${mode}`}
                          tabIndex={effectiveMode === mode ? 0 : -1}
                          onClick={() => onInputMode?.(mode)}
                          onKeyDown={(event) => {
                            if (
                              [
                                "ArrowLeft",
                                "ArrowRight",
                                "Home",
                                "End",
                              ].includes(event.key)
                            ) {
                              event.preventDefault();
                              const next =
                                event.key === "Home"
                                  ? "text"
                                  : event.key === "End"
                                    ? "voice"
                                    : mode === "text"
                                      ? "voice"
                                      : "text";
                              onInputMode?.(next);
                              document
                                .getElementById(`input-tab-${next}`)
                                ?.focus();
                            }
                          }}
                          className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring ${effectiveMode === mode ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"}`}
                        >
                          {mode === "text" ? (
                            <Keyboard className="size-3.5" />
                          ) : (
                            <Mic className="size-3.5" />
                          )}
                          {mode === "text" ? "Text" : "Voice"}
                        </button>
                      ))}
                    </div>
                    <span className="text-[11px] text-muted-foreground">
                      Message your manager
                    </span>
                  </div>
                )}
                <div
                  ref={voiceTarget}
                  id="input-panel-voice"
                  role="tabpanel"
                  aria-labelledby="input-tab-voice"
                  className={effectiveMode === "text" ? "order-3" : ""}
                />
                <div
                  id="input-panel-text"
                  role="tabpanel"
                  aria-labelledby={hasVoice ? "input-tab-text" : undefined}
                  hidden={effectiveMode !== "text"}
                  className="p-2"
                >
                  <Textarea
                    aria-label="Message your manager"
                    placeholder="Message your manager…"
                    value={draft}
                    maxLength={200_000}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault();
                        if (!pending.has(`send-${agent.id}`) && draft.trim())
                          void send();
                      }
                    }}
                    className="min-h-14 max-h-40 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
                    disabled={Boolean(agent.archivedAt)}
                  />
                  <div className="flex items-center justify-between gap-2 px-1">
                    <p className="text-[11px] text-muted-foreground">
                      {agent.runtime.session.observedState === "stopped"
                        ? "Manager is stopped. Your message waits until Start in Settings."
                        : agent.runtime.session.activeTurnId
                          ? "Send another message to guide the current work."
                          : "Enter to send · Shift Enter for a new line"}
                    </p>
                    <NativeSelect
                      aria-label="Delivery mode"
                      value={mode}
                      onChange={(event) =>
                        setMode(event.target.value as DeliveryMode)
                      }
                      className="h-7 max-w-36 text-[11px]"
                    >
                      <option value="steer">Send now</option>
                      <option value="queue">After current turn</option>
                    </NativeSelect>
                    <Button
                      type="submit"
                      size="icon"
                      aria-label="Send message"
                      disabled={
                        !draft.trim() ||
                        pending.has(`send-${agent.id}`) ||
                        Boolean(agent.archivedAt)
                      }
                    >
                      {pending.has(`send-${agent.id}`) ? (
                        <LoaderCircle className="animate-spin" />
                      ) : (
                        <ArrowUp />
                      )}
                    </Button>
                  </div>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </MessageScrollerProvider>
  );
}

function HistoryItem({
  item,
  snapshot,
  client,
  managerDirection = false,
}: {
  item: RuntimeHistoryItem;
  snapshot: AgentsSnapshot;
  client: AgentsClient;
  managerDirection?: boolean;
}) {
  const sender = item.sender;
  const senderAgent =
    sender.type === "agent" || sender.type === "assistant"
      ? snapshot.agents.find((agent) => agent.id === sender.agentId)
      : undefined;
  const picture = useAgentPicture(client, senderAgent?.profile.pictureRef);
  const own =
    item.sender.type === "user" && item.sender.userId === snapshot.ownerId;
  const technical = item.kind === "tool" || item.kind === "approval";
  if (technical)
    return (
      <details className="rounded-lg border bg-muted/20 px-3 py-2 text-sm">
        <summary className="text-xs font-medium text-muted-foreground">
          {item.kind === "approval"
            ? "Native approval record"
            : "Tool activity"}
        </summary>
        <div className="mt-3">
          <Content blocks={item.content} client={client} />
        </div>
        <HistoryCorrelation item={item} />
      </details>
    );
  const text = item.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");
  const attachments = item.content.filter((block) => block.type !== "text");
  const name = historyActor(item, snapshot);
  return (
    <Message
      message={{
        id: item.runtimeRef,
        role: own || managerDirection ? "user" : "assistant",
        text,
        turnId: item.turnId ?? undefined,
      }}
      label={name}
      ariaLabel={own ? "Your message" : `${name} message`}
      profile={{ name, picture, voice: null, version: "native-projection" }}
      copyable={!own}
    >
      {attachments.length > 0 && (
        <div className="mt-3">
          <Content blocks={attachments} client={client} />
        </div>
      )}
    </Message>
  );
}
function HistoryCorrelation({ item }: { item: RuntimeHistoryItem }) {
  return (
    <details className="mt-3 text-xs text-muted-foreground">
      <summary>Reference</summary>
      <p className="mt-1 break-all">
        {item.runtimeRef}
        {item.turnId ? ` · Turn ${item.turnId}` : ""}
      </p>
    </details>
  );
}
function DeliveryItem({
  message,
  snapshot,
  client,
  act,
  pending,
}: {
  message: AgentMessage;
  snapshot: AgentsSnapshot;
  client: AgentsClient;
  act: Action;
  pending: Set<string>;
}) {
  return (
    <div className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs">
          <strong className="capitalize">{message.delivery.state}</strong> ·{" "}
          {message.deliveryMode} · {actorLabel(message.sender, snapshot)}
        </span>
        {message.delivery.state === "uncertain" && (
          <Button
            variant="outline"
            size="sm"
            disabled={pending.has(`reconcile-${message.id}`)}
            onClick={() =>
              void act(`reconcile-${message.id}`, () =>
                client.reconcileMessage(message.id),
              )
            }
          >
            Check native receipt
          </Button>
        )}
        {message.delivery.state === "failed" &&
          message.delivery.attempts.at(-1)?.outcome === "not_sent" &&
          client.retryMessage && (
            <Button
              variant="outline"
              size="sm"
              disabled={pending.has(`retry-${message.id}`)}
              onClick={() =>
                void act(`retry-${message.id}`, () =>
                  client.retryMessage!(message.id),
                )
              }
            >
              Retry unsent message
            </Button>
          )}
      </div>
      {message.delivery.error && (
        <p className="mt-2 text-xs text-destructive">
          {message.delivery.error.message}
        </p>
      )}
      <details className="mt-2 text-xs text-muted-foreground">
        <summary>Retained message and attempts</summary>
        <div className="mt-3 text-foreground">
          <Content blocks={message.content} client={client} />
        </div>
        <p className="mt-3 break-all">Message {message.id}</p>
        {message.delivery.attempts.map((attempt) => (
          <p key={attempt.id} className="mt-1 break-all">
            {attempt.outcome} · {attempt.id} · {formatDate(attempt.attemptedAt)}
          </p>
        ))}
      </details>
    </div>
  );
}

type ProfileSave = {
  profile: ProfileInput;
  skills: Agent["skills"];
  expectedRevision?: number;
};
function ProfileEditor({
  agent,
  client,
  skills,
  pending,
  onSave,
}: {
  agent?: Agent;
  client: AgentsClient;
  skills: Skill[];
  pending: boolean;
  onSave: (input: ProfileSave) => Promise<Agent | null>;
}) {
  const [profile, setProfile] = useState<ProfileInput>(() =>
    agent
      ? {
          name: agent.profile.name,
          pictureRef: agent.profile.pictureRef,
          personality: agent.profile.personality,
          systemPrompt: agent.profile.systemPrompt,
        }
      : { name: "", pictureRef: null, personality: "", systemPrompt: "" },
  );
  const [revision, setRevision] = useState(agent?.profile.revision);
  const [selection, setSelection] = useState<Agent["skills"]>(
    agent?.skills ?? [],
  );
  const savedSource = useRef(agent);
  const [dirty, setDirty] = useState(false);
  const editVersion = useRef(0);
  const pictureInputId = useId();
  const pictureRequest = useRef(0);
  const [draftPicture, setDraftPicture] = useState<string | null | undefined>(
    undefined,
  );
  const [readingPicture, setReadingPicture] = useState(false);
  const [savingPicture, setSavingPicture] = useState(false);
  const [pictureError, setPictureError] = useState("");
  useEffect(
    () => () => {
      pictureRequest.current++;
    },
    [],
  );
  useEffect(() => {
    if (!agent || dirty || savedSource.current === agent) return;
    setProfile({
      name: agent.profile.name,
      pictureRef: agent.profile.pictureRef,
      personality: agent.profile.personality,
      systemPrompt: agent.profile.systemPrompt,
    });
    setRevision(agent.profile.revision);
    setSelection(agent.skills);
    setDraftPicture(undefined);
    savedSource.current = agent;
  }, [agent, dirty]);
  const change = <K extends keyof ProfileInput>(
    key: K,
    value: ProfileInput[K],
  ) => {
    editVersion.current++;
    setDirty(true);
    setProfile((current) => ({ ...current, [key]: value }));
  };
  const choosePicture = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const request = ++pictureRequest.current;
    editVersion.current++;
    setDirty(true);
    setReadingPicture(true);
    setPictureError("");
    try {
      const picture = await readProfilePicture(file);
      if (request === pictureRequest.current) setDraftPicture(picture);
    } catch (error) {
      if (request === pictureRequest.current) setPictureError(errorText(error));
    } finally {
      if (request === pictureRequest.current) setReadingPicture(false);
    }
  };
  return (
    <form
      className="space-y-6"
      onSubmit={async (event) => {
        event.preventDefault();
        if (
          pending ||
          savingPicture ||
          readingPicture ||
          (agent && dirty && revision !== agent.profile.revision)
        )
          return;
        const submittedVersion = editVersion.current;
        setSavingPicture(true);
        setPictureError("");
        try {
          const pictureRef =
            draftPicture === undefined
              ? profile.pictureRef
              : draftPicture === null
                ? null
                : client.saveImage
                  ? (await client.saveImage(draftPicture)).imageRef
                  : await Promise.reject(
                      new Error(
                        "Picture uploads are unavailable. Try again when this project reconnects.",
                      ),
                    );
          const saved = await onSave({
            profile: { ...profile, pictureRef },
            skills: selection,
            expectedRevision: revision,
          });
          if (saved) {
            setRevision(saved.profile.revision);
            if (submittedVersion === editVersion.current) {
              setProfile({
                name: saved.profile.name,
                pictureRef: saved.profile.pictureRef,
                personality: saved.profile.personality,
                systemPrompt: saved.profile.systemPrompt,
              });
              setDraftPicture(undefined);
              savedSource.current = saved;
              setDirty(false);
            }
          }
        } catch {
          setPictureError(
            "The profile could not be saved. Your changes are kept; try again.",
          );
        } finally {
          setSavingPicture(false);
        }
      }}
    >
      <div>
        <h2 className="text-lg font-semibold">
          {agent ? "Agent profile" : "Identity and instructions"}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Profile changes are saved separately from the running session.
        </p>
      </div>
      {agent && dirty && revision !== agent.profile.revision && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive"
        >
          The saved profile changed while you were editing. Your draft is
          retained; reload the saved version before saving again.
          <Button
            type="button"
            variant="ghost"
            disabled={pending || savingPicture}
            onClick={() => {
              pictureRequest.current++;
              editVersion.current++;
              setReadingPicture(false);
              setDraftPicture(undefined);
              setPictureError("");
              setDirty(false);
            }}
          >
            Reload saved profile
          </Button>
        </p>
      )}
      <Field label="Name">
        <Input
          required
          maxLength={160}
          value={profile.name}
          onChange={(event) => change("name", event.target.value)}
        />
      </Field>
      <div className="space-y-2">
        <p className="text-sm font-medium">Picture</p>
        <div className="flex flex-wrap items-center gap-3">
          <AgentPicture
            client={client}
            imageRef={profile.pictureRef}
            picture={draftPicture}
            className="size-12"
          />
          <label
            htmlFor={pictureInputId}
            className="cursor-pointer text-xs text-primary"
          >
            Choose picture
          </label>
          <input
            id={pictureInputId}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            aria-label="Agent picture"
            className="max-w-full text-xs"
            disabled={
              pending || savingPicture || readingPicture || !client.saveImage
            }
            onChange={(event) => void choosePicture(event)}
          />
          {(draftPicture === undefined ? profile.pictureRef : draftPicture) && (
            <Button
              type="button"
              variant="link"
              size="sm"
              disabled={pending || savingPicture}
              onClick={() => {
                pictureRequest.current++;
                setReadingPicture(false);
                setPictureError("");
                setDraftPicture(null);
                change("pictureRef", null);
              }}
            >
              Remove picture
            </Button>
          )}
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          PNG, JPEG or WebP, up to 512 KB and 2048 × 2048 pixels. The picture
          stays in this project on this Mac.
        </p>
        {readingPicture && (
          <p role="status" className="text-xs text-muted-foreground">
            Checking picture…
          </p>
        )}
        {!client.saveImage && (
          <p className="text-xs text-muted-foreground">
            Picture uploads are unavailable in this connection.
          </p>
        )}
        {pictureError && (
          <p role="alert" className="text-xs text-destructive">
            {pictureError}
          </p>
        )}
      </div>
      <Field label="Personality">
        <Textarea
          rows={3}
          placeholder="How should this colleague communicate and approach work?"
          value={profile.personality}
          onChange={(event) => change("personality", event.target.value)}
        />
      </Field>
      <Field label="Instructions">
        <Textarea
          rows={9}
          className="min-h-56 font-mono text-sm"
          value={profile.systemPrompt}
          onChange={(event) => change("systemPrompt", event.target.value)}
        />
      </Field>
      <details className="rounded-lg border px-4 py-3 text-sm">
        <summary className="font-medium">Writing useful instructions</summary>
        <div className="mt-3 space-y-3 text-muted-foreground">
          <p>
            Describe the agent’s responsibilities, useful project context and
            how you want decisions or questions brought to you. For example:
            “Keep research concise, link evidence and ask me when a decision
            changes the agreed scope.”
          </p>
          <p>
            These instructions define this agent’s behavior. Permissions are
            managed separately. Saving does not start a turn or alter active
            instructions; explicit Start or Restart applies the saved profile.
          </p>
        </div>
      </details>
      <fieldset className="space-y-3 border-t pt-5">
        <legend className="pr-2 text-sm font-medium">Skills</legend>
        {skills.length ? (
          skills.map((skill) => (
            <label
              key={skill.id}
              className="flex items-start gap-3 rounded-lg border p-3 text-sm"
            >
              <input
                type="checkbox"
                className="mt-1"
                checked={selection.some(
                  (item) => item.skillId === skill.id && item.enabled,
                )}
                onChange={(event) => {
                  editVersion.current++;
                  setDirty(true);
                  setSelection((current) => [
                    ...current.filter((item) => item.skillId !== skill.id),
                    { skillId: skill.id, enabled: event.target.checked },
                  ]);
                }}
              />
              <span>
                <span className="font-medium">{skill.name}</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {skill.description}
                </span>
              </span>
            </label>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">
            No project skills are available. Native skill authoring is managed
            separately.
          </p>
        )}
      </fieldset>
      <div className="flex justify-end border-t pt-5">
        <Button
          type="submit"
          disabled={
            pending ||
            savingPicture ||
            readingPicture ||
            !profile.name.trim() ||
            Boolean(agent && dirty && revision !== agent.profile.revision)
          }
        >
          {(pending || savingPicture) && (
            <LoaderCircle className="animate-spin" />
          )}{" "}
          {agent ? "Save profile" : "Create agent"}
        </Button>
      </div>
    </form>
  );
}

function JobsView({
  agent,
  snapshot,
  client,
  pending,
  act,
}: {
  agent: Agent;
  snapshot: AgentsSnapshot;
  client: AgentsClient;
  pending: Set<string>;
  act: Action;
}) {
  const [creating, setCreating] = useState(false);
  const jobs = snapshot.jobs.filter(
    (job) => job.assignment.assignedToAgentId === agent.id,
  );
  return (
    <>
      <PageHeading
        title="Jobs"
        description="Progress is reported by agents. Session activity does not change it."
      >
        <Button
          variant="outline"
          disabled={Boolean(agent.archivedAt)}
          onClick={() => setCreating((value) => !value)}
        >
          <Plus />
          New job
        </Button>
      </PageHeading>
      {creating && (
        <div className="mb-6 rounded-xl border p-5">
          <JobEditor
            agent={agent}
            snapshot={snapshot}
            pending={pending.has(`job-${agent.id}`)}
            onCreate={async (input) => {
              const ok = await act(
                `job-${agent.id}`,
                () => client.createJob(input),
                "Job created. No message or model turn was started.",
              );
              if (ok) setCreating(false);
              return ok;
            }}
          />
        </div>
      )}
      {jobs.length ? (
        <div className="space-y-4">
          {jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              snapshot={snapshot}
              client={client}
              act={act}
              pending={pending}
            />
          ))}
        </div>
      ) : (
        <Empty icon={<FileText />} title="No assigned jobs">
          <p>Create a local objective or link an existing ticket.</p>
        </Empty>
      )}
    </>
  );
}
function JobCard({
  job,
  snapshot,
  client,
  act,
  pending,
}: {
  job: Job;
  snapshot: AgentsSnapshot;
  client: AgentsClient;
  act: Action;
  pending: Set<string>;
}) {
  const [assignee, setAssignee] = useState(
    job.assignment.assignedToAgentId ?? "",
  );
  const [instruction, setInstruction] = useState(
    job.assignment.instruction ?? "",
  );
  return (
    <article className="rounded-xl border p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="mb-1 text-xs text-muted-foreground">
            {job.work.type === "ticket"
              ? `${job.work.ticket.provider} ticket`
              : "Local job"}
          </div>
          <h3 className="font-medium">
            {job.work.type === "ticket" ? (
              <SafeLink url={job.work.ticket.url}>
                {jobTitle(job)}
                <ExternalLink className="ml-1 inline size-3" />
              </SafeLink>
            ) : (
              jobTitle(job)
            )}
          </h3>
        </div>
        <JobProgressView job={job} />
      </div>
      {job.assignment.instruction && (
        <div className="mt-4">
          <p className="text-xs font-medium text-muted-foreground">
            Assignment brief
          </p>
          <p className="mt-1 whitespace-pre-wrap text-sm">
            {job.assignment.instruction}
          </p>
        </div>
      )}
      {job.work.type === "local" ? (
        <>
          <div className="agent-markdown mt-4 text-sm">
            <Markdown text={job.work.objective} />
          </div>
          {job.work.updates.length > 0 && (
            <details className="mt-4 text-sm">
              <summary>Updates ({job.work.updates.length})</summary>
              {job.work.updates.map((update) => (
                <div key={update.id} className="mt-3 border-l-2 pl-3">
                  <p className="text-xs text-muted-foreground">
                    {agentName(update.recordedByAgentId, snapshot)} ·{" "}
                    {formatDate(update.recordedAt)}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap">{update.text}</p>
                  <WorkLinks links={update.links} />
                </div>
              ))}
            </details>
          )}
          {job.work.outcome && (
            <div className="mt-4 rounded-lg bg-muted/50 p-3 text-sm">
              <p className="mb-1 font-medium">Recorded outcome</p>
              <Markdown text={job.work.outcome.summary} />
              <WorkLinks links={job.work.outcome.links} />
            </div>
          )}
        </>
      ) : (
        <p className="mt-4 text-xs text-muted-foreground">
          Requirements and results remain in the linked ticket. Crew retains
          this assignment and its reported progress.
        </p>
      )}
      <details className="mt-5 border-t pt-3 text-sm">
        <summary>Assignment and history</summary>
        <form
          className="mt-4 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void act(
              `assign-${job.id}`,
              () =>
                client.assignJob(job.id, assignee || null, instruction || null),
              "Assignment saved.",
            );
          }}
        >
          <Field label="Assigned agent">
            <NativeSelect
              value={assignee}
              onChange={(event) => setAssignee(event.target.value)}
            >
              <option value="">Unassigned</option>
              {snapshot.agents
                .filter((agent) => !agent.archivedAt)
                .map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.profile.name}
                  </option>
                ))}
            </NativeSelect>
          </Field>
          <Field label="Assignment-specific direction">
            <Textarea
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
            />
          </Field>
          <Button
            type="submit"
            variant="outline"
            disabled={pending.has(`assign-${job.id}`)}
          >
            Save assignment
          </Button>
        </form>
        <ol className="mt-4 space-y-2 text-xs text-muted-foreground">
          {job.assignmentHistory.map((event) => (
            <li key={event.id}>
              {formatDate(event.recordedAt)} ·{" "}
              {actorLabel(event.changedBy, snapshot)} assigned{" "}
              {event.assignedAgentId
                ? agentName(event.assignedAgentId, snapshot)
                : "no agent"}
              {event.instruction ? ` · ${event.instruction}` : ""}
            </li>
          ))}
        </ol>
      </details>
    </article>
  );
}
function JobEditor({
  agent,
  snapshot,
  pending,
  onCreate,
}: {
  agent: Agent;
  snapshot: AgentsSnapshot;
  pending: boolean;
  onCreate: (input: CreateJobInput) => Promise<boolean>;
}) {
  const [type, setType] = useState<"local" | "ticket">("local");
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [provider, setProvider] = useState<"github" | "linear">("github");
  const [connectionId, setConnectionId] = useState("");
  const [externalId, setExternalId] = useState("");
  const [url, setUrl] = useState("");
  const [instruction, setInstruction] = useState("");
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void onCreate({
          assignedToAgentId: agent.id,
          instruction: instruction || null,
          work:
            type === "local"
              ? { type, title, objective }
              : { type, ticket: { provider, connectionId, externalId, url } },
        });
      }}
    >
      <Field label="Job type">
        <NativeSelect
          value={type}
          onChange={(event) =>
            setType(event.target.value as "local" | "ticket")
          }
        >
          <option value="local">Local objective</option>
          <option value="ticket">Existing ticket</option>
        </NativeSelect>
      </Field>
      {type === "local" ? (
        <>
          <Field label="Title">
            <Input
              required
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <Field label="Objective">
            <Textarea
              required
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
            />
          </Field>
        </>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Provider">
              <NativeSelect
                value={provider}
                onChange={(event) =>
                  setProvider(event.target.value as "github" | "linear")
                }
              >
                <option value="github">GitHub</option>
                <option value="linear">Linear</option>
              </NativeSelect>
            </Field>
            <Field label="Existing service connection">
              <NativeSelect
                required
                value={connectionId}
                onChange={(event) => setConnectionId(event.target.value)}
              >
                <option value="">Select connection</option>
                {snapshot.serviceConnections?.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          {!snapshot.serviceConnections?.length && (
            <p className="text-xs text-muted-foreground">
              A service connection must be configured in Settings before linking
              a ticket.
            </p>
          )}
          <Field
            label={
              provider === "github"
                ? "Repository-qualified issue identity"
                : "Immutable Linear issue ID"
            }
          >
            <Input
              required
              placeholder={
                provider === "github" ? "owner/repository#123" : "Issue UUID"
              }
              value={externalId}
              onChange={(event) => setExternalId(event.target.value)}
            />
          </Field>
          <Field label="Canonical ticket URL">
            <Input
              required
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </Field>
        </>
      )}
      <Field label="Assignment brief">
        <Textarea
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
        />
      </Field>
      <div className="flex justify-end">
        <Button
          type="submit"
          disabled={pending || (type === "ticket" && !connectionId)}
        >
          Create job
        </Button>
      </div>
    </form>
  );
}

function OwnerInbox({
  snapshot,
  client,
  pending,
  act,
  openAgent,
}: {
  snapshot: AgentsSnapshot;
  client: AgentsClient;
  pending: Set<string>;
  act: Action;
  openAgent: (id: string) => void;
}) {
  const requests = snapshot.helpRequests.filter(
    (request) => request.target.type === "user" && request.state === "open",
  );
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeading
        title="Inbox"
        description="Questions and native approvals that need your response."
      />
      {!requests.length && !snapshot.nativeApprovals.length && (
        <Empty icon={<Inbox />} title="Nothing waiting for you">
          <p>Agents bring questions here when they need your help.</p>
        </Empty>
      )}
      <div className="space-y-4">
        {snapshot.nativeApprovals.map((approval) => (
          <article
            key={`${approval.agentId}:${approval.approvalId}`}
            className="rounded-xl border p-5"
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-medium">
                Native approval · {agentName(approval.agentId, snapshot)}
              </h2>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => openAgent(approval.agentId)}
              >
                View agent
                <ChevronRight />
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              This decision is delivered to the exact native request. It does
              not create a Crew service grant.
            </p>
            <pre className="mt-4 overflow-auto rounded-lg bg-muted p-3 text-xs">
              {JSON.stringify(approval.request, null, 2)}
            </pre>
            {approval.state === "uncertain" ||
            approval.state === "responding" ? (
              <p
                role="status"
                className="mt-3 rounded-lg border bg-muted/40 p-3 text-sm"
              >
                {approval.state === "uncertain"
                  ? "Decision delivery is uncertain. The request is retained for native reconciliation; do not send the decision again."
                  : "Delivering your decision. Native acknowledgement is still pending."}
              </p>
            ) : approval.choices?.length ? (
              <div className="mt-4 flex flex-wrap gap-2">
                {approval.choices.map((choice, index) => (
                  <Button
                    key={index}
                    variant="outline"
                    disabled={pending.has(`approval-${approval.approvalId}`)}
                    onClick={() =>
                      void act(`approval-${approval.approvalId}`, () =>
                        client.respondToNativeApproval(
                          approval.agentId,
                          approval.approvalId,
                          choice.response,
                        ),
                      )
                    }
                  >
                    {choice.label}
                  </Button>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">
                This native request does not expose supported response choices
                here. It remains pending.
              </p>
            )}
          </article>
        ))}
        {requests.map((request) => (
          <HelpCard
            key={request.id}
            request={request}
            snapshot={snapshot}
            client={client}
            pending={pending}
            act={act}
            openAgent={openAgent}
          />
        ))}
      </div>
      <p className="mt-6 text-xs text-muted-foreground">
        Work answers do not authorize service access. Access reviews are handled
        separately in Settings.
      </p>
    </div>
  );
}
function HelpCard({
  request,
  snapshot,
  client,
  pending,
  act,
  openAgent,
}: {
  request: HelpRequest;
  snapshot: AgentsSnapshot;
  client: AgentsClient;
  pending: Set<string>;
  act: Action;
  openAgent: (id: string) => void;
}) {
  const [response, setResponse] = useState("");
  const body = snapshot.ownerInbox.find(
    (item) => item.helpRequestId === request.id,
  )?.content;
  const job = snapshot.jobs.find((item) => item.id === request.jobId);
  return (
    <article className="rounded-xl border p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-medium">
          {agentName(request.requesterAgentId, snapshot)} needs your help
        </h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => openAgent(request.requesterAgentId)}
        >
          View agent
          <ChevronRight />
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {formatDate(request.createdAt)}
        {job ? ` · ${jobTitle(job)}` : ""}
      </p>
      <div className="my-5">
        {body ? (
          <Content blocks={body} client={client} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Question content is unavailable. Open the agent’s native
            conversation for context.
          </p>
        )}
      </div>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const submitted = response;
          const ok = await act(
            `help-${request.id}`,
            () =>
              client.respondToHelp(request.id, [
                { type: "text", text: submitted.trim() },
              ]),
            "Response saved for delivery.",
          );
          if (ok)
            setResponse((current) => (current === submitted ? "" : current));
        }}
      >
        <Textarea
          aria-label={`Response to ${agentName(request.requesterAgentId, snapshot)}`}
          placeholder="Your response…"
          value={response}
          onChange={(event) => setResponse(event.target.value)}
        />
        <div className="mt-3 flex justify-end">
          <Button
            type="submit"
            disabled={!response.trim() || pending.has(`help-${request.id}`)}
          >
            Send response
          </Button>
        </div>
      </form>
    </article>
  );
}
function Preparation({
  snapshot,
  client,
  pending,
  act,
  actions,
}: {
  snapshot: AgentsSnapshot;
  client: AgentsClient;
  pending: Set<string>;
  act: Action;
  actions?: ReactNode;
}) {
  const [reason, setReason] =
    useState<ExecutionReservation["reason"]>("restart");
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeading
        title="Prepare for a pause"
        description="Ask agents to save continuation notes and report readiness before a restart, update or quit."
      />
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border p-5">
        <div>
          <label
            className="mb-2 block text-sm font-medium"
            htmlFor="prepare-reason"
          >
            Prepare for
          </label>
          <NativeSelect
            id="prepare-reason"
            value={reason}
            onChange={(event) =>
              setReason(event.target.value as ExecutionReservation["reason"])
            }
          >
            <option value="restart">Restart</option>
            <option value="update">App update</option>
            <option value="quit">Quit</option>
          </NativeSelect>
        </div>
        <Button
          disabled={pending.has("prepare")}
          onClick={() =>
            void act(
              "prepare",
              () => client.prepare(reason),
              "Preparation requested. Agents report their own readiness.",
            )
          }
        >
          {pending.has("prepare") && <LoaderCircle className="animate-spin" />}
          Request preparation
        </Button>
      </div>
      <p className="mb-5 text-sm text-muted-foreground">
        Preparation keeps communication available. It does not stop sessions or
        remove environments. The host must also verify execution has settled
        before reserving an actual restart.
      </p>
      {actions && <div className="mb-5">{actions}</div>}
      {snapshot.readiness.length ? (
        <div className="divide-y rounded-xl border">
          {snapshot.readiness.map((item) => (
            <div
              key={`${item.agentId}:${item.sessionId}`}
              className="flex flex-wrap items-start justify-between gap-4 p-4"
            >
              <div>
                <h2 className="font-medium">
                  {agentName(item.agentId, snapshot)}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {item.detail || "No readiness detail supplied."}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {item.continuationSavedAt
                    ? `Continuation saved ${formatDate(item.continuationSavedAt)}`
                    : "Continuation save not yet confirmed"}
                </p>
              </div>
              <span
                className={`rounded-md px-2 py-1 text-xs capitalize ${item.state === "blocked" ? "bg-destructive/10 text-destructive" : item.state === "ready" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}
              >
                {item.state}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <Empty icon={<CircleHelp />} title="No preparation requested">
          <p>Readiness appears here after an explicit request.</p>
        </Empty>
      )}
    </div>
  );
}
function SettingsView({
  snapshot,
  panels,
  refresh,
  visible,
  requestedPage,
}: {
  snapshot: AgentsSnapshot;
  panels: AgentSettingsPanel[];
  refresh: () => Promise<void>;
  visible: boolean;
  requestedPage: { id: string; page: string };
}) {
  const [active, setActive] = useState(panels[0]?.id ?? "");
  const content = useRef<HTMLElement | null>(null);
  const panel = panels.find((item) => item.id === active) ?? panels[0];
  useEffect(() => {
    setActive(requestedPage.page);
  }, [requestedPage.id]);
  useEffect(() => {
    if (visible) void refresh().catch(() => {});
  }, [visible, refresh]);
  useEffect(() => {
    if (content.current) content.current.scrollTop = 0;
  }, [active]);
  return (
    <section
      ref={content}
      aria-label="Settings"
      className="min-h-0 flex-1 overflow-y-auto px-5 py-10 sm:px-10"
    >
      <div className="mx-auto grid max-w-6xl items-start gap-8 md:grid-cols-[192px_minmax(0,1fr)] md:gap-12 lg:grid-cols-[224px_minmax(0,1fr)] lg:gap-16">
        <aside className="self-start md:sticky md:top-0">
          <h1 className="mb-3 px-3 text-sm font-semibold tracking-tight">
            Settings
          </h1>
          <nav aria-label="Settings pages" className="space-y-6">
            <div>
              <h2 className="mb-2 px-3 text-[11px] font-medium text-muted-foreground">
                Project settings
              </h2>
              <div className="flex flex-wrap gap-2 md:flex-col">
                {panels.map((item) => {
                  const Icon = item.icon ?? Settings2;
                  return (
                    <Button
                      key={item.id}
                      type="button"
                      variant="ghost"
                      aria-current={panel?.id === item.id ? "page" : undefined}
                      className={`h-11 justify-start gap-3 rounded-lg px-3 text-sm md:w-full ${panel?.id === item.id ? "bg-muted/60 font-semibold text-primary" : "font-medium text-muted-foreground hover:text-foreground"}`}
                      onClick={() => setActive(item.id)}
                    >
                      <Icon
                        className={`size-5 ${panel?.id === item.id ? "text-primary" : "text-muted-foreground/70"}`}
                        aria-hidden="true"
                      />
                      {item.label}
                    </Button>
                  );
                })}
              </div>
            </div>
          </nav>
        </aside>
        <div className="min-w-0 space-y-8">
          <div>
            <p className="mb-2 text-xs font-medium text-primary">
              {snapshot.projectName}
            </p>
            <h2 className="text-2xl font-semibold tracking-tight">
              {panel?.label || "Project settings"}
            </h2>
            {panel?.description && (
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {panel.description}
              </p>
            )}
          </div>
          {panels.map((item) => (
            <div key={item.id} hidden={panel?.id !== item.id}>
              {item.render({
                snapshot,
                refresh,
                visible: visible && panel?.id === item.id,
              })}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function JobProgressView({ job }: { job: Job }) {
  const progress = job.progress;
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={`job-status job-status-${progress.status}`}>
          <span className="size-1.5 rounded-full bg-current" />
          {progress.label || statusLabels[progress.status]}
        </span>
        {progress.percent !== null && (
          <span className="tabular-nums text-muted-foreground">
            {progress.percent}%
          </span>
        )}
      </div>
      {progress.detail && (
        <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
          {progress.detail}
        </p>
      )}
      <span className="sr-only">
        {statusLabels[progress.status]}
        {progress.percent === null
          ? "; percentage unavailable"
          : "; agent reported percentage"}
      </span>
    </div>
  );
}
function Content({
  blocks,
  client,
}: {
  blocks: AgentContent[];
  client: AgentsClient;
}) {
  return (
    <div className="agent-markdown space-y-3 text-sm">
      {blocks.map((block, index) => {
        if (block.type === "text")
          return <Markdown key={index} text={block.text} />;
        if (block.type === "data")
          return (
            <pre
              key={index}
              className="max-w-full overflow-auto rounded-lg bg-muted p-3 text-xs"
            >
              {JSON.stringify(block.value, null, 2)}
            </pre>
          );
        const url = client.artifactUrl?.(block.fileRef) ?? null;
        if (block.type === "image")
          return (
            <ArtifactImage key={index} url={url} caption={block.caption} />
          );
        return url && safeUrl(url, true) ? (
          <a
            key={index}
            href={url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 text-primary"
          >
            <FileText className="size-4" />
            {block.name}
          </a>
        ) : (
          <p
            key={index}
            className="flex items-center gap-2 text-muted-foreground"
          >
            <FileText className="size-4" />
            {block.name} · File unavailable
          </p>
        );
      })}
    </div>
  );
}
function ArtifactImage({
  url,
  caption,
}: {
  url: string | null;
  caption: string | null;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return url && safeUrl(url, true) && !failed ? (
    <figure>
      <img
        src={url}
        alt={caption || "Conversation attachment"}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="max-h-96 max-w-full rounded-lg border object-contain"
      />
      {caption && (
        <figcaption className="mt-2 text-xs text-muted-foreground">
          {caption}
        </figcaption>
      )}
    </figure>
  ) : (
    <p className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">
      Image unavailable{caption ? ` · ${caption}` : ""}
    </p>
  );
}
function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => (
          <SafeLink url={href || ""}>{children}</SafeLink>
        ),
        img: ({ alt }) => (
          <span className="text-muted-foreground">
            {alt || "Image"} · Attachment reference required
          </span>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
function SafeLink({ url, children }: { url: string; children: ReactNode }) {
  return <WebLink href={url}>{children}</WebLink>;
}
function safeUrl(url: string, artifact = false) {
  if (artifact && url.startsWith("/") && !url.startsWith("//")) return true;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" ||
      parsed.protocol === "http:" ||
      (artifact && parsed.protocol === "blob:")
    );
  } catch {
    return false;
  }
}
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-2 text-sm">
      <span className="block font-medium">{label}</span>
      {children}
      {hint && (
        <span className="block text-xs text-muted-foreground">{hint}</span>
      )}
    </label>
  );
}
function PageHeading({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}
function Empty({
  title,
  icon,
  children,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-12 text-center">
      <div className="flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        {icon}
      </div>
      <h2 className="text-base font-medium">{title}</h2>
      <div className="flex max-w-lg flex-col items-center gap-4 text-sm text-muted-foreground">
        {children}
      </div>
    </div>
  );
}
function WorkLinks({ links }: { links: { label: string; url: string }[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-3">
      {links.map((link, index) => (
        <SafeLink key={index} url={link.url}>
          {link.label}
        </SafeLink>
      ))}
    </div>
  );
}
function errorText(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : "The request failed. Your saved state has been retained.";
}
function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Time unavailable"
    : date.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
}
function jobTitle(job: Job) {
  return job.work.type === "local"
    ? job.work.title
    : job.work.ticket.externalId;
}
function agentName(id: string, snapshot: AgentsSnapshot) {
  return (
    snapshot.agents.find((agent) => agent.id === id)?.profile.name ??
    `Agent ${id}`
  );
}
function primaryAgentId(snapshot: AgentsSnapshot | null): string | null {
  return snapshot?.projectSettings
    ? snapshot.projectSettings.primaryAgentId
    : (snapshot?.primaryAgentId ?? null);
}

function actorLabel(actor: MessageSender, snapshot: AgentsSnapshot) {
  return actor.type === "system"
    ? "Internal"
    : actor.type === "agent"
      ? agentName(actor.agentId, snapshot)
      : actor.userId === snapshot.ownerId
        ? "You"
        : `User ${actor.userId}`;
}
function historyActor(item: RuntimeHistoryItem, snapshot: AgentsSnapshot) {
  const sender = item.sender;
  if (sender.type === "assistant") return agentName(sender.agentId, snapshot);
  if (sender.type === "system") return "System";
  if (sender.type === "tool") return sender.name;
  if (sender.type === "unattributed_native")
    return `Native ${sender.nativeRole} · origin unverified`;
  return actorLabel(sender, snapshot);
}
function sameSkills(agent: Agent, skills: Skill[]) {
  const applied = agent.runtime.session.appliedConfiguration?.skills;
  if (!applied) return false;
  const desired = agent.skills.filter((item) => item.enabled);
  return (
    desired.length === applied.length &&
    desired.every((item) => {
      const skill = skills.find((skill) => skill.id === item.skillId);
      return (
        skill &&
        applied.some(
          (ref) => ref.id === item.skillId && ref.revision === skill.revision,
        )
      );
    })
  );
}
function uniqueHistory(items: RuntimeHistoryItem[]) {
  return [...new Map(items.map((item) => [item.runtimeRef, item])).values()];
}

function readComposerDraft(key: string): string {
  try {
    const value = localStorage.getItem(key);
    return value && value.length <= 200_000 ? value : "";
  } catch {
    return "";
  }
}
