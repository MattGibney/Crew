import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { TriangleAlert, ChevronDown, MoreVertical } from "lucide-react";
import { Table, TableCaption, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table";
import { Toaster } from "@/components/ui/sonner";
import { SettingsToast } from "../manager/settings/SettingsToast";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Archive,
  GitBranch,
  Globe,
  Keyboard,
  Mic,
  Layers,
  NotebookPen,
  Settings2,
  Radio,
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
import { Separator } from "@/components/ui/separator";
import { OnlineStatus } from "@/components/online-status";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Message } from "../manager/Message";
import { ArchivedAgentsSettings } from "./ArchivedAgentsSettings";
import { ManagerOverview } from "./ManagerOverview";
import { AgentPicture, useAgentPicture } from "./AgentPicture";
import { useConversationHistory } from "./useConversationHistory";
import { useVoiceArtifacts } from "./useVoiceArtifacts";
import {
  conversationTimeline,
  reconcilePendingVoice,
} from "./conversation-timeline";
import type { LiveTranscriptItem } from "./voice/live-transcript";
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
import type { AgentsClient, AgentsSnapshot, CreateJobInput } from "./client";
import crewMark from "../../../build/crew-mark.png";
import "./agents.css";

export interface AgentSettingsPanel {
  id: string;
  label: string;
  description?: string;
  icon?: LucideIcon;
  render(context: {
    openSettings: (pageId: string) => void;
    snapshot: AgentsSnapshot;
    refresh: () => Promise<void>;
    visible: boolean;
  }): ReactNode;
}
export interface AgentsAppProps {
  renderBrowser?: (context: {
    snapshot: AgentsSnapshot;
    selectedAgent: Agent | null;
    client: AgentsClient;
    visible: boolean;
  }) => ReactNode;
  client: AgentsClient;
  /** #89 supplies access, connections and approval panels; foundation owns navigation. */
  settingsPanels?: AgentSettingsPanel[];
  /** Service access decisions appear alongside questions and native approvals. */
  renderAccessApprovals?: AgentSettingsPanel["render"];
  banner?: ReactNode;
  /** Return null once owner setup is complete. Opening setup starts no work. */
  renderSetup?: (context: {
    snapshot: AgentsSnapshot;
    refresh: () => Promise<void>;
    openSettings: (pageId: string) => void;
    visible: boolean;
  }) => ReactNode;
  /** Mounted once. Visibility controls presentation only; the app owns call lifetime. */
  renderVoice?: (context: {
    primaryAgent: Agent | null;
    snapshot: AgentsSnapshot;
    visible: boolean;
    mode: "voice" | "compact" | "hidden";
    controlsTarget: HTMLElement | null;
    onTranscript: (items: LiveTranscriptItem[]) => void;
  }) => ReactNode;
  headerActions?: ReactNode;
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
  | "managers"
  | "browser"
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
  renderBrowser,
  client,
  settingsPanels = [],
  renderAccessApprovals,
  banner,
  renderSetup,
  renderVoice,
  headerActions,
  nativeWindow = false,
  navigationRequest,
  renderPreparationActions,
}: AgentsAppProps) {
  const [snapshot, setSnapshot] = useState<AgentsSnapshot | null>(null);
  const [view, setView] = useState<View>("managers");
  const [settingsReturn, setSettingsReturn] = useState<View>("managers");
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
  const [liveTranscript, setLiveTranscript] = useState<LiveTranscriptItem[]>(
    [],
  );
  const [secondaryVoiceTarget, setSecondaryVoiceTarget] =
    useState<HTMLElement | null>(null);
  const [workerWidth, setWorkerWidth] = useState<number | null>(null);
  const [workspaceWidth, setWorkspaceWidth] = useState(1000);
  const workspace = useRef<HTMLElement | null>(null);
  const resizing = useRef(false);
  const locks = useRef(new Set<string>());
  const composerDrafts = useRef(new Map<string, string>());
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
    snapshot?.agents.find(
      (agent) => !agent.archivedAt && agent.id === primaryAgentId(snapshot),
    ) ?? null;
  useEffect(() => {
    setSelectedId(null);
    setView((current) =>
      !primary &&
      ["conversation", "agents", "scratchpad", "browser"].includes(current)
        ? "managers"
        : current === "agents"
          ? "conversation"
          : current,
    );
  }, [primary?.id]);
  useEffect(() => {
    if (
      selectedId &&
      snapshot &&
      !snapshot.agents.some(
        (agent) => agent.id === selectedId && !agent.archivedAt,
      )
    ) {
      setSelectedId(null);
      setView((current) => (current === "agents" ? "conversation" : current));
    }
  }, [selectedId, snapshot]);
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
  const openManager = async (agent: Agent) => {
    if (pending.has("contact")) return;
    if (primary?.id !== agent.id) {
      const settings = snapshot?.projectSettings;
      if (!client.selectContact || !settings) {
        setError(
          "Agent selection is unavailable. Refresh the project and try again.",
        );
        return;
      }
      const selected = await act("contact", async () => {
        await client.selectContact!(agent.id, settings.revision);
        const next = await client.readSnapshot();
        if (primaryAgentId(next) !== agent.id)
          throw new Error(
            "The selected agent could not be confirmed. Please try again.",
          );
        setSnapshot(next);
      });
      if (!selected) return;
    }
    setSelectedId(null);
    setView("conversation");
  };
  const setup = snapshot
    ? renderSetup?.({
        snapshot,
        refresh,
        openSettings,
        visible: view !== "settings",
      })
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
          description: "Manage sessions for your team members and worker agents.",
          icon: Radio,
          render: () => <AgentSessionsSettings agents={snapshot.agents} skills={snapshot.skills} pending={pending} act={act} client={client} />,
        },
        ...settingsPanels.map((panel) => ({
          ...panel,
          render: (context: Parameters<AgentSettingsPanel["render"]>[0]) =>
            panel.render({
              ...context,
              snapshot: {
                ...context.snapshot,
                agents: context.snapshot.agents.filter(
                  (agent) => !agent.archivedAt,
                ),
              },
            }),
        })),
        {
          id: "crew-archived-agents",
          label: "Archived agents",
          description:
            "Restore an agent or permanently delete its local agent records.",
          icon: Archive,
          render: () => (
            <ArchivedAgentsSettings
              agents={snapshot.agents}
              client={client}
              pending={pending}
              act={act}
            />
          ),
        },
        {
          id: "crew-attention",
          label: "Questions and approvals",
          description: "Review requests that need your decision.",
          icon: CircleHelp,
          render: (context) => (
            <div className="space-y-10">
              <OwnerInbox
                snapshot={snapshot}
                client={client}
                pending={pending}
                act={act}
                openAgent={showWorker}
              />
              {renderAccessApprovals && <Separator />}
              {renderAccessApprovals?.(context)}
            </div>
          ),
        },
        {
          id: "crew-preparation",
          label: "Quit Crew",
          description:
            "Close Crew while keeping your agents and saved conversations.",
          icon: RotateCw,
          render: () =>
            renderPreparationActions?.({ snapshot, refresh }) ?? (
              <p className="text-sm text-muted-foreground">
                Use the desktop application menu to quit Crew.
              </p>
            ),
        },
      ]
    : [];
  const detailVisible = view === "agents" && selectedId !== null;
  const normalView =
    !setupVisible &&
    (view === "conversation" ||
      view === "agents" ||
      view === "scratchpad" ||
      view === "browser") &&
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
          {renderBrowser && view !== "managers" && primary && !setupVisible && (
            <Button
              variant={view === "browser" ? "secondary" : "ghost"}
              aria-pressed={view === "browser"}
              onClick={() => setView("browser")}
            >
              <Globe />
              <span className="hidden sm:inline">Browser</span>
              <span className="sr-only sm:hidden">Browser</span>
            </Button>
          )}
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
        </div>
      </header>
      {banner && (
        <div className="shrink-0 border-b bg-muted/50 px-5 py-2 text-center text-xs text-muted-foreground">
          {banner}
        </div>
      )}
      <nav
        aria-label="Workspace views"
        className={`${normalView ? "flex" : "hidden"} shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2 sm:px-5`}
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSelectedId(null);
              setView("managers");
            }}
          >
            <ArrowLeft aria-hidden="true" />
            Team members
          </Button>
          {primary && (
            <span className="min-w-0 truncate text-sm font-semibold">
              {primary.profile.name}
            </span>
          )}
        </div>
        <div className="flex w-full gap-1 sm:w-auto">
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
        </div>
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
          {setup && (
            <section
              hidden={!setupVisible}
              className="min-h-0 flex-1 overflow-auto"
            >
              {setup}
            </section>
          )}
          <div
            hidden={setupVisible || view !== "managers"}
            className="min-h-0 flex-1 overflow-y-auto"
          >
            <ManagerOverview
              snapshot={snapshot}
              client={client}
              pending={pending.has("contact")}
              onOpen={(agent) => void openManager(agent)}
              onManage={() => openSettings("agents")}
            />
          </div>
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
              aria-label="Agent workspace"
              className={`${view === "conversation" ? "flex" : "hidden"} min-h-0 min-w-0 flex-col overflow-hidden`}
            >
              {primary ? (
                <Conversation
                  key={primary.id}
                  agent={primary}
                  memoryDrafts={composerDrafts.current}
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
                  liveTranscript={liveTranscript}
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
                  <Empty icon={<Settings />} title="Choose an agent">
                    <p>Choose a contact in Agents settings.</p>
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
              <div className="mb-4 flex justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openSettings("agents")}
                >
                  <Plus />
                  Manage agents
                </Button>
              </div>
              <AgentWorkerList
                snapshot={snapshot}
                client={client}
                onSelect={showWorker}
                compact={view === "conversation"}
              />
            </aside>
          </main>
          {renderBrowser?.({
            snapshot,
            selectedAgent: primary,
            client,
            visible: !setupVisible && view === "browser",
          })}
          {snapshot.agents
            .filter(
              (agent) =>
                !agent.archivedAt &&
                visitedIds.has(agent.id) &&
                agent.id !== primary?.id,
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
                  onEdit={() => openSettings("agents")}
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
              setupVisible ||
              view === "conversation" ||
              view === "settings" ||
              view === "managers"
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
            visible:
              !setupVisible && view !== "settings" && view !== "managers",
            mode:
              setupVisible || view === "settings" || view === "managers"
                ? "hidden"
                : view === "conversation"
                  ? inputMode === "voice"
                    ? "voice"
                    : "compact"
                  : "compact",
            onTranscript: setLiveTranscript,
            controlsTarget:
              view === "conversation"
                ? composerVoiceTarget
                : secondaryVoiceTarget,
          })}
        </>
      )}
      <Toaster position="bottom-right" closeButton />
      {toast && (
        <SettingsToast message={toast} onDismiss={() => setToast("")} />
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
  const workers = snapshot.agents.filter(
    (agent) =>
      agent.reportsTo.type === "agent" &&
      agent.reportsTo.agentId === primaryAgentId(snapshot) &&
      !agent.archivedAt,
  );
  return (
    <section aria-label="Workers and worktrees" className="min-w-0 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">
            Workers{" "}
            <span className="ml-1 text-muted-foreground">{workers.length}</span>
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Workers reporting to your selected agent.
          </p>
        </div>
        <Layers className="size-4 text-muted-foreground" aria-hidden="true" />
      </div>
      {!workers.length && (
        <div className="rounded-xl border border-dashed px-5 py-9 text-center">
          <FolderGit2 className="mx-auto mb-3 size-6 text-muted-foreground" />
          <h3 className="text-sm font-medium">A workspace for every task</h3>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            This agent’s workers and their progress appear here.
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
              <Button
                variant="ghost"
                type="button"
                onClick={() => onSelect(agent.id)}
                aria-label={`Open worker ${agent.profile.name}`}
                className="group items-stretch justify-start whitespace-normal flex h-full w-full min-w-0 flex-col rounded-xl border bg-card p-3 text-left shadow-xs transition-colors hover:border-primary/40 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
              </Button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function AgentSessionsSettings({
  agents,
  skills,
  client,
  pending,
  act,
}: {
  agents: Agent[];
  skills: Skill[];
  client: AgentsClient;
  pending: Set<string>;
  act: Action;
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState("");
  const bulkLock = useRef(false);
  const mounted = useRef(true);
  const latest = useRef({ agents, pending, act });
  latest.current = { agents, pending, act };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const activeIds = new Set(
      agents.filter((agent) => !agent.archivedAt).map((agent) => agent.id),
    );
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => activeIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [agents]);
  const active = agents.filter((agent) => !agent.archivedAt);
  const selected = active.filter((agent) => selectedIds.has(agent.id));
  const eligible = (agent: Agent, action: "start" | "stop" | "restart") =>
    !agent.archivedAt &&
    !latest.current.pending.has(`lifecycle-${agent.id}`) &&
    !["starting", "stopping"].includes(agent.runtime.session.observedState) &&
    !(
      action === "start" && agent.runtime.session.observedState === "started"
    ) &&
    !(action === "stop" && agent.runtime.session.observedState === "stopped");
  const runBulk = async (action: "start" | "stop" | "restart") => {
    if (bulkLock.current) return;
    const targets = selected.map((agent) => ({
      id: agent.id,
      name: agent.profile.name,
    }));
    if (!targets.length) return;
    bulkLock.current = true;
    setRunning(true);
    setResult(
      `${action[0].toUpperCase() + action.slice(1)} requested for ${targets.length} agents…`,
    );
    let completed = 0,
      skipped = 0;
    const failed: string[] = [];
    try {
      for (const target of targets) {
        if (!mounted.current) break;
        const current = latest.current.agents.find(
          (agent) => agent.id === target.id,
        );
        if (!current || !eligible(current, action)) {
          skipped++;
          continue;
        }
        try {
          const success = await latest.current.act(
            `lifecycle-${target.id}`,
            () => client.lifecycle(target.id, action),
          );
          if (success) completed++;
          else failed.push(target.name);
        } catch {
          failed.push(target.name);
        }
      }
      if (mounted.current)
        setResult(
          `${action[0].toUpperCase() + action.slice(1)}: ${completed} acknowledged${skipped ? `, ${skipped} skipped` : ""}${failed.length ? `. Failed or unconfirmed: ${failed.join(", ")}.` : "."}`,
        );
    } finally {
      bulkLock.current = false;
      if (mounted.current) setRunning(false);
    }
  };
  return (
    <div className="space-y-5">
      {selected.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <p className="text-sm font-medium">{selected.length} selected</p>
            <Button
              variant="ghost"
              size="sm"
              disabled={running}
              onClick={() => setSelectedIds(new Set())}
            >
              Clear selection
            </Button>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" disabled={running} />}>
              {running ? "Applying actions…" : "Bulk action"}<ChevronDown className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              {(["start", "stop", "restart"] as const).map((action) => (
                <DropdownMenuItem key={action} disabled={running || !selected.some((agent) => eligible(agent, action))} onClick={() => void runBulk(action)}>
                  {action === "start" ? <Play /> : action === "stop" ? <Square /> : <RotateCw />}
                  {action[0].toUpperCase() + action.slice(1)} selected
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      {result && (
        <p role="status" className="text-sm text-muted-foreground">
          {result}
        </p>
      )}
      <div className="overflow-x-auto rounded-lg border">
        <Table className="w-full text-left text-sm">
          <TableCaption className="sr-only">
            All active agents and their sessions
          </TableCaption>
          <TableHeader className="border-b bg-muted/30 text-xs text-muted-foreground">
            <TableRow>
              <TableHead className="w-10 px-4 py-3">
                <Checkbox
                  aria-label="Select all agents"
                  disabled={running || !active.length}
                  checked={!!active.length && selected.length === active.length}
                  indeterminate={
                    selected.length > 0 && selected.length < active.length
                  }
                  onCheckedChange={(checked) => {
                    setSelectedIds(
                      checked
                        ? new Set(active.map((agent) => agent.id))
                        : new Set(),
                    );
                    setResult("");
                  }}
                />
              </TableHead>
              <TableHead className="px-4 py-3 font-medium">Agent</TableHead>
              <TableHead className="px-4 py-3 font-medium">Status</TableHead>
              <TableHead className="px-4 py-3 font-medium">
                <span className="sr-only">Session controls</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="divide-y">
            {active.map((agent) => (
              <AgentSessionRow
                key={agent.id}
                agent={agent}
                skills={skills}
                pending={pending}
                act={act}
                client={client}
                selected={selectedIds.has(agent.id)}
                locked={running}
                onSelect={(checked) => {
                  setSelectedIds((current) => {
                    const next = new Set(current);
                    if (checked) next.add(agent.id);
                    else next.delete(agent.id);
                    return next;
                  });
                  setResult("");
                }}
              />
            ))}
            {!active.length && (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="px-4 py-8 text-muted-foreground"
                >
                  No active agents. Create or restore an agent in Settings.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        Stop preserves the chat, notes and resources. Start never connects voice
        or creates an assignment.
      </p>
    </div>
  );
}

function AgentSessionPanel(props: { agent: Agent; skills: Skill[]; client: AgentsClient; pending: Set<string>; act: Action }) {
  return <div className="overflow-x-auto rounded-lg border"><Table>
    <TableCaption className="sr-only">Session for {props.agent.profile.name}</TableCaption>
    <TableHeader><TableRow><TableHead>Agent</TableHead><TableHead>Status</TableHead><TableHead><span className="sr-only">Session controls</span></TableHead></TableRow></TableHeader>
    <TableBody><AgentSessionRow {...props} /></TableBody>
  </Table></div>;
}

function AgentSessionRow({
  agent,
  skills,
  client,
  pending,
  act,
  selected = false,
  onSelect,
  locked = false,
}: {
  agent: Agent;
  skills: Skill[];
  client: AgentsClient;
  pending: Set<string>;
  act: Action;
  selected?: boolean;
  onSelect?(checked: boolean): void;
  locked?: boolean;
}) {
  const session = agent.runtime.session;
  const busy = locked ||
    ["starting", "stopping"].includes(session.observedState) ||
    pending.has(`lifecycle-${agent.id}`);
  const needsRecovery = ["unknown", "error"].includes(session.observedState);
  const pendingProfile =
    !session.appliedConfiguration ||
    Boolean(
      agent.runtime.threadId &&
      !session.appliedConfiguration.instructionsDigest,
    ) ||
    session.appliedConfiguration.profileRevision !== agent.profile.revision ||
    !sameSkills(agent, skills);
  return (
    <TableRow data-state={selected ? "selected" : undefined}>
      {onSelect && <TableCell className="px-4 py-3 align-top"><Checkbox aria-label={`Select ${agent.profile.name}`} checked={selected} disabled={locked} onCheckedChange={(checked) => onSelect(!!checked)} /></TableCell>}
      <TableCell className="px-4 py-3 align-top">
        <div className="flex items-center gap-3">
          <AgentPicture imageRef={agent.profile.pictureRef} client={client} className="size-10 shrink-0" />
          <div><p className="font-medium">{agent.profile.name}</p><p className="mt-1 text-xs text-muted-foreground">{agent.reportsTo.type === "user" ? "Team member" : "Worker agent"}</p></div>
        </div>
      </TableCell>
      <TableCell className="px-4 py-3 align-top whitespace-normal"><div className="max-w-md space-y-2">
        {session.instructionPreparation?.state === "compacting" ? (
          <Badge variant="secondary">Applying instructions</Badge>
        ) : ["started", "stopped"].includes(session.observedState) ? (
          <OnlineStatus
            online={session.observedState === "started"}
            className="text-sm"
          />
        ) : needsRecovery ? (
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-destructive"><TriangleAlert className="size-3.5" aria-hidden="true" />{session.observedState === "error" ? "Session error" : "Status unknown"}</span>
        ) : (
          <Badge variant="outline" className="capitalize">
            {session.observedState}
          </Badge>
        )}
      {needsRecovery && (
        <Collapsible className="space-y-2">
          <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="group h-auto gap-1 px-0 py-0 text-xs text-muted-foreground" aria-label={`Session details for ${agent.profile.name}`} />}>
            View details <ChevronDown className="size-3 transition-transform group-data-panel-open:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-2 text-xs leading-5 text-muted-foreground">
            {session.lastError && <p role="alert" className="break-words text-foreground">{session.lastError.message}</p>}
            <p>Recovery checks that the previous process has exited before reconnecting. Your sign-in and chat are preserved.</p>
            {pendingProfile && <p>Saved instructions or skills will apply when you restart.</p>}
          </CollapsibleContent>
        </Collapsible>
      )}
      {pendingProfile && !needsRecovery &&
        session.instructionPreparation?.state !== "compacting" && (
          <p role="status" className="text-sm text-muted-foreground">
            {agent.runtime.threadId
              ? "Saved instructions or skills are waiting for Restart."
              : "Start applies your saved instructions and skills."}
          </p>
        )}
      {session.instructionPreparation?.state === "compacting" && (
        <p role="status" className="text-sm text-muted-foreground">
          Updating instructions in this chat. Codex is summarizing its active
          context; the readable chat history is kept. This uses model allowance.
        </p>
      )}
      {session.instructionPreparation?.state === "uncertain" && (
        <p role="status" className="text-sm text-muted-foreground">
          The instruction update could not be confirmed. The existing chat is
          retained; check the session error before retrying.
        </p>
      )}
      {session.lastError && !needsRecovery && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive"
        >
          {session.lastError.message}
        </p>
      )}
      </div></TableCell>
      <TableCell className="px-4 py-3 align-top">
        <div role="group" aria-label={`Session controls for ${agent.profile.name}`}>
        <div className="flex items-center justify-end gap-2">
          {["unknown", "error"].includes(session.observedState) &&
            client.recoverSession && (
              <Button
                variant="outline"
                aria-label={`Recover session for ${agent.profile.name}`}
                disabled={busy || Boolean(agent.archivedAt)}
                onClick={() =>
                  void act(`lifecycle-${agent.id}`, () =>
                    client.recoverSession!(agent.id),
                  )
                }
              >
                <RotateCw className="size-4" /> Recover session
              </Button>
            )}
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={`Session actions for ${agent.profile.name}`} disabled={busy || Boolean(agent.archivedAt)} />}>
              <MoreVertical className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {(["start", "stop", "restart"] as const).map((action) => (
                <DropdownMenuItem
                  key={action}
                  aria-label={`${action[0].toUpperCase() + action.slice(1)} session for ${agent.profile.name}`}
                  disabled={busy || Boolean(agent.archivedAt) || (action === "start" && session.observedState === "started") || (action === "stop" && session.observedState === "stopped")}
                  onClick={() => void act(`lifecycle-${agent.id}`, () => client.lifecycle(agent.id, action))}
                >
                  {action === "start" ? <Play /> : action === "stop" ? <Square /> : <RotateCw />}
                  {action[0].toUpperCase() + action.slice(1)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        </div>
      </TableCell>
    </TableRow>
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
  onEdit,
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
  onEdit(): void;
}) {
  const [tab, setTab] = useState<
    "overview" | "conversation" | "notes" | "links"
  >("conversation");
  const jobs = snapshot.jobs.filter(
    (job) => job.assignment.assignedToAgentId === agent.id,
  );
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(value as typeof tab)}
      aria-label="Worker detail"
      className="flex min-h-0 flex-1 flex-col gap-0"
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
            Back to conversation
          </Button>
          <span className="hidden h-4 border-l sm:block" />
          <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">
            {agent.profile.name}
          </h1>
          <Badge variant="outline" className="text-[10px]">
            Session {agent.runtime.session.observedState}
          </Badge>
        </div>
        <TabsList
          variant="line"
          aria-label="Worker detail tabs"
          className="-mb-px mt-3 w-full justify-start overflow-x-auto"
        >
          {(
            [
              ["overview", "Overview", LayoutDashboard],
              ["conversation", "Conversation", MessageSquare],
              ["notes", "Work notes", FileText],
              ["links", "Links", Link2],
            ] as const
          ).map(([value, label, Icon]) => (
            <TabsTrigger key={value} value={value} className="flex-none">
              <Icon className="size-3.5" />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      <TabsContent
        value="conversation"
        keepMounted
        className="min-h-0 flex-1 flex flex-col data-[hidden]:hidden"
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
      </TabsContent>
      <TabsContent
        value="notes"
        keepMounted
        className="min-h-0 flex-1 overflow-auto px-5 py-6 sm:px-8"
      >
        <AgentScratchpad agent={agent} />
      </TabsContent>
      <TabsContent
        value="overview"
        keepMounted
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
          <section className="border-t pt-5">
            <Button variant="outline" onClick={onEdit}>
              Edit agent configuration
            </Button>
            <p className="mt-2 text-xs text-muted-foreground">
              Identity, instructions, voice, skills and access are managed
              together in Agents settings.
            </p>
          </section>
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
              Archive agent
            </Button>
          )}
        </div>
      </TabsContent>
      <TabsContent
        value="links"
        keepMounted
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
      </TabsContent>
    </Tabs>
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
  liveTranscript = [],
  hasVoice = false,
  onOpenSettings,
  attention,
  memoryDrafts,
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
  liveTranscript?: LiveTranscriptItem[];
  hasVoice?: boolean;
  onOpenSettings?: () => void;
  attention?: ReactNode;
  memoryDrafts?: Map<string, string>;
}) {
  const {
    items,
    cursor,
    loading,
    loaded,
    error: historyError,
    refresh: load,
    loadEarlier,
    showLatest,
  } = useConversationHistory({
    client,
    agentId: agent.id,
    threadId: agent.runtime.threadId,
    sessionId: agent.runtime.session.sessionId,
    visible,
    version: historyVersion,
  });
  const voiceHistory = useVoiceArtifacts({
    agent,
    client,
    revision: snapshot.voiceArtifactsRevision ?? 0,
    visible:
      visible &&
      snapshot.voiceArtifactsRevision != null &&
      Boolean(client.readVoiceArtifacts),
  });
  const pendingVoice = useRef<LiveTranscriptItem[]>([]);
  pendingVoice.current = reconcilePendingVoice(
    pendingVoice.current,
    readOnly ? [] : liveTranscript,
    voiceHistory.artifacts,
    agent.runtime.threadId,
  );
  const timeline = conversationTimeline(
    items,
    voiceHistory.artifacts,
    pendingVoice.current,
    agent.runtime.threadId,
  );
  const picture = useAgentPicture(client, agent.profile.pictureRef);
  const draftKey = `crew-agent-draft:${snapshot.projectId}:${agent.id}`;
  const [draft, setDraft] = useState(
    () => memoryDrafts?.get(draftKey) ?? readComposerDraft(draftKey),
  );
  useEffect(() => {
    if (readOnly) return;
    memoryDrafts?.set(draftKey, draft);
    try {
      if (draft) localStorage.setItem(draftKey, draft);
      else localStorage.removeItem(draftKey);
    } catch {
      /* Unavailable local storage never discards an in-memory draft. */
    }
  }, [draft, draftKey, readOnly, memoryDrafts]);
  const [mode, setMode] = useState<DeliveryMode>("steer");
  const intents = snapshot.pendingMessages.filter(
    (message) =>
      message.recipientAgentId === agent.id && message.sender.type !== "system",
  );
  const receipts = snapshot.receipts.filter(
    (receipt) =>
      receipt.recipientAgentId === agent.id && receipt.sender.type !== "system",
  );
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
  const voicePanelTarget = useRef<HTMLDivElement | null>(null);
  const compactVoiceTarget = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // Only the controls portal moves; the voice runtime and audio stay mounted.
    voiceTarget?.(
      effectiveMode === "voice"
        ? voicePanelTarget.current
        : compactVoiceTarget.current,
    );
    return () => voiceTarget?.(null);
  }, [effectiveMode, voiceTarget]);
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
                      {items.length > 0 && (
                        <p className="mt-1">
                          Showing the last loaded messages; history has not
                          refreshed.
                        </p>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-2"
                        disabled={loading}
                        onClick={() => void load()}
                      >
                        Retry history
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={loading}
                        onClick={() => void showLatest()}
                      >
                        Show latest history
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
                    onClick={() => void loadEarlier()}
                  >
                    Load earlier history
                  </Button>
                </MessageScrollerItem>
              )}
              {!timeline.length && !voiceHistory.loading && (
                <MessageScrollerItem messageId="conversation-empty">
                  <p className="text-center text-sm text-muted-foreground">
                    {loading || (!loaded && agent.runtime.threadId)
                      ? "Loading conversation…"
                      : historyError
                        ? "Saved history is currently unavailable."
                        : cursor
                          ? "No public messages in these pages. Load earlier history to continue."
                          : agent.runtime.threadId
                            ? "No saved public messages are available for this chat."
                            : "Start this agent in Settings, then send your first message."}
                  </p>
                </MessageScrollerItem>
              )}
              {(voiceHistory.loading ||
                voiceHistory.error ||
                voiceHistory.warning ||
                voiceHistory.cursor ||
                timeline.some(
                  (row) =>
                    row.type === "native" &&
                    (!row.timestamp ||
                      row.item.timestampSource === "native_turn"),
                )) && (
                <MessageScrollerItem
                  messageId="timeline-notices"
                  className="space-y-2 text-xs text-muted-foreground"
                >
                  {voiceHistory.loading && (
                    <p role="status">Loading voice transcripts…</p>
                  )}
                  {voiceHistory.error && (
                    <p role="alert">
                      {voiceHistory.error}
                      {voiceHistory.artifacts.length
                        ? " Showing the last loaded transcripts; they may be stale."
                        : ""}{" "}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void voiceHistory.refresh()}
                      >
                        Retry voice history
                      </Button>
                    </p>
                  )}
                  {voiceHistory.warning && (
                    <p role="alert">{voiceHistory.warning}</p>
                  )}
                  {voiceHistory.cursor && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={voiceHistory.loading}
                      onClick={() => void voiceHistory.loadEarlier()}
                    >
                      Load earlier voice messages
                    </Button>
                  )}
                  {timeline.some(
                    (row) => row.type === "native" && !row.timestamp,
                  ) && (
                    <p>
                      Some message times are unavailable. Their original chat
                      order is preserved; their order relative to voice messages
                      cannot be verified.
                    </p>
                  )}
                  {timeline.some(
                    (row) =>
                      row.type === "native" &&
                      row.item.timestampSource === "native_turn",
                  ) && (
                    <p>
                      Some messages use their native turn's start time; exact
                      message times are unavailable.
                    </p>
                  )}
                </MessageScrollerItem>
              )}
              {timeline.map((row) => (
                <MessageScrollerItem key={row.id} messageId={row.id}>
                  {row.type === "native" ? (
                    <HistoryItem
                      item={row.item}
                      snapshot={snapshot}
                      client={client}
                      managerDirection={
                        readOnly && row.item.sender.type === "agent"
                      }
                    />
                  ) : (
                    <Message
                      message={{
                        id: row.id,
                        role: row.item.role,
                        text: row.item.text,
                        source: "voice",
                        status: row.item.done
                          ? "complete"
                          : !row.item.ended &&
                              (row.artifact?.state === "active" ||
                                !row.artifact)
                            ? "streaming"
                            : "partial",
                      }}
                      label={
                        row.item.role === "user" ? "You" : agent.profile.name
                      }
                      ariaLabel={
                        row.item.role === "user"
                          ? "Your message"
                          : `${agent.profile.name} message`
                      }
                      profile={{
                        name: agent.profile.name,
                        picture,
                        voice: null,
                        version: "voice-projection",
                      }}
                      copyable
                    >
                      {row.timestamp && (
                        <time
                          dateTime={row.timestamp}
                          className="mt-2 block text-[11px] text-muted-foreground"
                        >
                          {formatDate(row.timestamp)}
                        </time>
                      )}
                      {row.artifact?.state === "interrupted" &&
                        !row.item.done && (
                          <p className="text-xs text-muted-foreground">
                            Call interrupted; the final words may be missing.
                          </p>
                        )}
                    </Message>
                  )}
                </MessageScrollerItem>
              ))}
              {hasVoice &&
                !readOnly &&
                snapshot.voiceArtifactsRevision == null && (
                  <MessageScrollerItem messageId="voice-history-limit">
                    <p className="text-xs text-muted-foreground">
                      Voice transcripts cannot be restored in this host.
                    </p>
                  </MessageScrollerItem>
                )}
              {(intents.length > 0 || receipts.length > 0) && (
                <MessageScrollerItem messageId="delivery-activity">
                  <Collapsible className="rounded-lg border px-4 py-3 text-sm">
                    <CollapsibleTrigger
                      type="button"
                      className="group inline-flex items-center gap-1.5 text-left cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring text-xs font-medium text-muted-foreground"
                    >
                      <ChevronRight
                        aria-hidden="true"
                        className="size-3.5 shrink-0 transition-transform group-aria-expanded:rotate-90"
                      />
                      Delivery activity
                      {intents.length ? ` · ${intents.length} pending` : ""}
                    </CollapsibleTrigger>
                    <CollapsibleContent keepMounted>
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
                              Accepted · {actorLabel(receipt.sender, snapshot)}{" "}
                              · {formatDate(receipt.acknowledgedAt)}
                            </p>
                          ))}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
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
            <Button
              variant="ghost"
              type="button"
              className="h-auto p-0 underline underline-offset-4"
              onClick={onReturnToPrimary}
            >
              Return to your conversation
            </Button>{" "}
            to send directions.
          </div>
        ) : (
          <Tabs
            value={effectiveMode}
            onValueChange={(value) => onInputMode?.(value as "text" | "voice")}
            className="shrink-0 space-y-3 bg-background px-5 pb-4 pt-2 sm:px-7"
          >
            <div className="mx-auto w-full max-w-3xl">
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
                    <TabsList aria-label="Input method">
                      <TabsTrigger value="text">
                        <Keyboard className="size-3.5" />
                        Text
                      </TabsTrigger>
                      <TabsTrigger value="voice">
                        <Mic className="size-3.5" />
                        Voice
                      </TabsTrigger>
                    </TabsList>
                    <span className="text-[11px] text-muted-foreground">
                      Message this agent
                    </span>
                  </div>
                )}
                <TabsContent value="voice" keepMounted>
                  <div ref={voicePanelTarget} />
                </TabsContent>
                <TabsContent value="text" keepMounted className="p-2">
                  <Textarea
                    aria-label="Message this agent"
                    placeholder="Message this agent…"
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
                </TabsContent>
                <div
                  ref={compactVoiceTarget}
                  hidden={effectiveMode !== "text"}
                />
              </form>
            </div>
          </Tabs>
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
      <Collapsible className="rounded-lg border bg-muted/20 px-3 py-2 text-sm">
        <CollapsibleTrigger
          type="button"
          className="group inline-flex items-center gap-1.5 text-left cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring text-xs font-medium text-muted-foreground"
        >
          <ChevronRight
            aria-hidden="true"
            className="size-3.5 shrink-0 transition-transform group-aria-expanded:rotate-90"
          />
          {item.kind === "approval"
            ? "Native approval record"
            : "Tool activity"}
        </CollapsibleTrigger>
        <CollapsibleContent keepMounted>
          <div className="mt-3">
            <Content blocks={item.content} client={client} />
          </div>
          <HistoryCorrelation item={item} />
        </CollapsibleContent>
      </Collapsible>
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
      {item.timestamp && (
        <time
          dateTime={item.timestamp}
          className="mt-2 block text-[11px] text-muted-foreground"
        >
          {formatDate(item.timestamp)}
        </time>
      )}
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
    <Collapsible className="mt-3 text-xs text-muted-foreground">
      <CollapsibleTrigger
        type="button"
        className="group inline-flex items-center gap-1.5 text-left cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight
          aria-hidden="true"
          className="size-3.5 shrink-0 transition-transform group-aria-expanded:rotate-90"
        />
        Reference
      </CollapsibleTrigger>
      <CollapsibleContent keepMounted>
        <p className="mt-1 break-all">
          {item.runtimeRef}
          {item.turnId ? ` · Turn ${item.turnId}` : ""}
        </p>
      </CollapsibleContent>
    </Collapsible>
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
      <Collapsible className="mt-2 text-xs text-muted-foreground">
        <CollapsibleTrigger
          type="button"
          className="group inline-flex items-center gap-1.5 text-left cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight
            aria-hidden="true"
            className="size-3.5 shrink-0 transition-transform group-aria-expanded:rotate-90"
          />
          Retained message and attempts
        </CollapsibleTrigger>
        <CollapsibleContent keepMounted>
          <div className="mt-3 text-foreground">
            <Content blocks={message.content} client={client} />
          </div>
          <p className="mt-3 break-all">Message {message.id}</p>
          {message.delivery.attempts.map((attempt) => (
            <p key={attempt.id} className="mt-1 break-all">
              {attempt.outcome} · {attempt.id} ·{" "}
              {formatDate(attempt.attemptedAt)}
            </p>
          ))}
        </CollapsibleContent>
      </Collapsible>
    </div>
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
            <Collapsible className="mt-4 text-sm">
              <CollapsibleTrigger
                type="button"
                className="group inline-flex items-center gap-1.5 text-left cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronRight
                  aria-hidden="true"
                  className="size-3.5 shrink-0 transition-transform group-aria-expanded:rotate-90"
                />
                Updates ({job.work.updates.length})
              </CollapsibleTrigger>
              <CollapsibleContent keepMounted>
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
              </CollapsibleContent>
            </Collapsible>
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
      <Collapsible className="mt-5 border-t pt-3 text-sm">
        <CollapsibleTrigger
          type="button"
          className="group inline-flex items-center gap-1.5 text-left cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight
            aria-hidden="true"
            className="size-3.5 shrink-0 transition-transform group-aria-expanded:rotate-90"
          />
          Assignment and history
        </CollapsibleTrigger>
        <CollapsibleContent keepMounted>
          <form
            className="mt-4 space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void act(
                `assign-${job.id}`,
                () =>
                  client.assignJob(
                    job.id,
                    assignee || null,
                    instruction || null,
                  ),
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
        </CollapsibleContent>
      </Collapsible>
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
      {!requests.length && !snapshot.nativeApprovals.length && (
        <Empty icon={<Inbox />} title="No questions or session approvals">
          <p>Agents bring questions here when they need your help.</p>
        </Empty>
      )}
      <div className="space-y-4">
        {snapshot.nativeApprovals.map((approval) => (
          <article
            key={`${approval.agentId}:${approval.approvalId}`}
            className="border-b pb-8 last:border-b-0"
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
        Answering an agent’s question does not grant it permission to use a service.
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
    <article className="border-b pb-8 last:border-b-0">
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
          {!["agents", "agent-templates", "connections"].includes(panel?.id ?? "") && (
            <div className="sticky -top-10 z-20 -mx-4 -mt-10 bg-background px-4 pb-4 pt-10 supports-backdrop-filter:bg-background/70 supports-backdrop-filter:backdrop-blur-md">
              <h2 className="text-xl font-semibold tracking-tight">
                {panel?.label || "Project settings"}
              </h2>
              {panel?.description && (
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  {panel.description}
                </p>
              )}
            </div>
          )}
          {panels.map((item) => (
            <div key={item.id} hidden={panel?.id !== item.id}>
              {item.render({
                openSettings: setActive,
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
    ? (snapshot.projectSettings.contactAgentId ??
        snapshot.projectSettings.primaryAgentId)
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
function readComposerDraft(key: string): string {
  try {
    const value = localStorage.getItem(key);
    return value && value.length <= 200_000 ? value : "";
  } catch {
    return "";
  }
}
