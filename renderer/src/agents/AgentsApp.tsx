import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
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
  Users,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import type {
  Agent,
  AgentContent,
  AgentMessage,
  DeliveryMode,
  ExecutionReservation,
  HelpRequest,
  Job,
  JobStatus,
  RuntimeHistoryItem,
  Skill,
} from "../../../src/agents/contracts.mjs";
import type {
  AgentsClient,
  AgentsSnapshot,
  CreateJobInput,
  ProfileInput,
} from "./client";
import "./agents.css";

export interface AgentSettingsPanel {
  id: string;
  label: string;
  render(context: {
    snapshot: AgentsSnapshot;
    refresh: () => Promise<void>;
  }): ReactNode;
}
export interface AgentsAppProps {
  client: AgentsClient;
  /** #89 supplies access, connections and approval panels; foundation owns navigation. */
  settingsPanels?: AgentSettingsPanel[];
  banner?: ReactNode;
}

type Action = (
  key: string,
  operation: () => Promise<unknown>,
  success?: string,
) => Promise<boolean>;
type View = "agents" | "inbox" | "prepare" | "settings";
type AgentTab = "conversation" | "jobs" | "scratchpad" | "profile";
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
}: AgentsAppProps) {
  const [snapshot, setSnapshot] = useState<AgentsSnapshot | null>(null);
  const [view, setView] = useState<View>("agents");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [visitedIds, setVisitedIds] = useState<Set<string>>(new Set());
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [historyVersion, setHistoryVersion] = useState(0);
  const locks = useRef(new Set<string>());
  const refreshVersion = useRef(0);
  const alive = useRef(true);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
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
      // Native text streams can publish many events per second. Coalesce their
      // disposable projections without delaying the final update indefinitely.
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
      // Refresh even after a failure: it may have retained a native thread or pending intent.
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

  const selected =
    snapshot?.agents.find((agent) => agent.id === selectedId) ?? null;
  const agents =
    snapshot?.agents.filter((agent) => showArchived || !agent.archivedAt) ?? [];
  const openHelp =
    snapshot?.helpRequests.filter(
      (item) => item.target.type === "user" && item.state === "open",
    ) ?? [];
  const attentionCount =
    openHelp.length + (snapshot?.nativeApprovals.length ?? 0);
  const openAgent = (id: string) => {
    setVisitedIds((current) => new Set([...current, id]));
    setSelectedId(id);
    setView("agents");
    setCreating(false);
  };

  return (
    <div className="agents-app min-h-dvh bg-background text-foreground">
      <header className="border-b bg-background px-4 sm:px-7">
        <div className="mx-auto flex min-h-16 max-w-7xl flex-wrap items-center justify-between gap-3 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Users className="size-4" />
            </div>
            <strong className="text-lg tracking-tight">Crew</strong>
            <span className="h-4 border-l" />
            <span className="truncate text-sm text-muted-foreground">
              {snapshot?.projectName || "Agents"}
            </span>
          </div>
          <nav aria-label="Project navigation" className="flex gap-1">
            <NavButton
              active={view === "agents"}
              onClick={() => {
                setView("agents");
                setSelectedId(null);
                setCreating(false);
              }}
              icon={<Users />}
            >
              Agents
            </NavButton>
            <NavButton
              active={view === "inbox"}
              onClick={() => setView("inbox")}
              icon={<Inbox />}
            >
              Inbox
              {attentionCount > 0 && (
                <span className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground">
                  {attentionCount}
                </span>
              )}
            </NavButton>
            <NavButton
              active={view === "prepare"}
              onClick={() => setView("prepare")}
              icon={<Check />}
            >
              Prepare
            </NavButton>
            <NavButton
              active={view === "settings"}
              onClick={() => setView("settings")}
              icon={<Settings />}
            >
              Settings
            </NavButton>
          </nav>
        </div>
      </header>
      {banner && (
        <div className="border-b bg-muted/50 px-5 py-2 text-center text-xs text-muted-foreground">
          {banner}
        </div>
      )}
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-7 sm:py-8">
        {error && (
          <div
            role="alert"
            className="mb-5 flex items-start justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
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
        {!snapshot ? (
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
        ) : (
          <>
            {view === "agents" && !selected && !creating && (
              <>
                <PageHeading
                  title="Agents"
                  description="Persistent colleagues, each with their own instructions and work."
                >
                  <Button onClick={() => setCreating(true)}>
                    <Plus />
                    New agent
                  </Button>
                </PageHeading>
                <div className="mb-5 flex items-center justify-between gap-3 text-sm text-muted-foreground">
                  <span>
                    {agents.length} {agents.length === 1 ? "agent" : "agents"}
                  </span>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={showArchived}
                      onChange={(event) =>
                        setShowArchived(event.target.checked)
                      }
                    />
                    Show archived
                  </label>
                </div>
                {agents.length ? (
                  <div className="grid auto-rows-fr gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {agents.map((agent) => (
                      <button
                        key={agent.id}
                        onClick={() => openAgent(agent.id)}
                        className="flex min-w-0 items-start gap-3 rounded-xl border p-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        <Avatar agent={agent} client={client} />
                        <div className="min-w-0 flex-1">
                          <h2 className="truncate font-medium">
                            {agent.profile.name}
                          </h2>
                          <div className="mt-1 line-clamp-2 min-h-10 text-sm text-muted-foreground">
                            {agent.profile.personality || "No personality set"}
                          </div>
                          <div className="mt-4">
                            <AgentJobSummary
                              agent={agent}
                              jobs={snapshot.jobs}
                            />
                          </div>
                          <p className="mt-3 text-xs text-muted-foreground">
                            {agent.archivedAt
                              ? "Archived"
                              : `Session ${agent.runtime.session.observedState}`}
                          </p>
                        </div>
                        <ChevronRight className="mt-2 size-4 shrink-0 text-muted-foreground" />
                      </button>
                    ))}
                  </div>
                ) : (
                  <Empty icon={<Users />} title="Your first colleague">
                    <p>
                      Create an agent, then start its session when you are
                      ready.
                    </p>
                    <Button onClick={() => setCreating(true)}>
                      <Plus />
                      Create agent
                    </Button>
                  </Empty>
                )}
              </>
            )}
            {view === "agents" && creating && (
              <div className="mx-auto max-w-3xl">
                <Button
                  variant="ghost"
                  className="mb-5"
                  onClick={() => setCreating(false)}
                >
                  <ArrowLeft />
                  Back to agents
                </Button>
                <PageHeading
                  title="New agent"
                  description="Every agent has the same capabilities. Its instructions define its responsibilities."
                />
                <ProfileEditor
                  key="new"
                  skills={snapshot.skills}
                  pending={pending.has("create-agent")}
                  onSave={async (input) => {
                    let created: Agent | undefined;
                    const success = await act(
                      "create-agent",
                      async () => {
                        created = await client.createAgent(input);
                      },
                      "Agent created. Start its session when ready.",
                    );
                    if (success && created) openAgent(created.id);
                    return success && created ? created : null;
                  }}
                />
              </div>
            )}
            {snapshot.agents
              .filter((agent) => visitedIds.has(agent.id))
              .map((agent) => (
                <div
                  key={agent.id}
                  hidden={view !== "agents" || selectedId !== agent.id}
                >
                  <AgentDetail
                    agent={agent}
                    snapshot={snapshot}
                    client={client}
                    pending={pending}
                    act={act}
                    historyVersion={historyVersion}
                    visible={view === "agents" && selectedId === agent.id}
                    onBack={() => setSelectedId(null)}
                    onArchived={() => setSelectedId(null)}
                  />
                </div>
              ))}
            <div hidden={view !== "inbox"}>
              <OwnerInbox
                snapshot={snapshot}
                client={client}
                pending={pending}
                act={act}
                openAgent={openAgent}
              />
            </div>
            <div hidden={view !== "prepare"}>
              <Preparation
                snapshot={snapshot}
                client={client}
                pending={pending}
                act={act}
              />
            </div>
            <div hidden={view !== "settings"}>
              <SettingsView
                snapshot={snapshot}
                panels={settingsPanels}
                refresh={refresh}
              />
            </div>
          </>
        )}
      </main>
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
  onBack: () => void;
  onArchived: () => void;
}) {
  const [tab, setTab] = useState<AgentTab>("conversation");
  const session = agent.runtime.session;
  const busy =
    ["starting", "stopping"].includes(session.observedState) ||
    pending.has(`lifecycle-${agent.id}`);
  const start = (action: "start" | "stop" | "restart") =>
    void act(`lifecycle-${agent.id}`, () => client.lifecycle(agent.id, action));
  const applied = session.appliedConfiguration;
  const pendingProfile =
    !applied ||
    applied.profileRevision !== agent.profile.revision ||
    !sameSkills(agent, snapshot.skills);
  const agentJobs = snapshot.jobs.filter(
    (job) => job.assignment.assignedToAgentId === agent.id,
  );
  return (
    <section>
      <Button variant="ghost" className="mb-5 -ml-2" onClick={onBack}>
        <ArrowLeft />
        All agents
      </Button>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar agent={agent} client={client} />
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight">
              {agent.profile.name}
            </h1>
            <p className="mt-1 text-xs text-muted-foreground">
              Session {session.observedState}
              {session.activeTurnId ? " · Turn active" : ""}
              {agent.archivedAt ? " · Archived" : ""}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={
              busy ||
              Boolean(agent.archivedAt) ||
              session.observedState === "started"
            }
            onClick={() => start("start")}
          >
            <Play />
            Start
          </Button>
          <Button
            variant="outline"
            disabled={busy || session.observedState === "stopped"}
            onClick={() => start("stop")}
          >
            <Square />
            Stop
          </Button>
          <Button
            variant="outline"
            disabled={busy || Boolean(agent.archivedAt)}
            onClick={() => start("restart")}
          >
            <RotateCw />
            Restart
          </Button>
        </div>
      </div>
      {pendingProfile && (
        <p
          role="status"
          className="mt-4 rounded-lg border bg-muted/30 px-3 py-2 text-sm"
        >
          {session.observedState === "started"
            ? "Saved instructions or skills are waiting for Restart. The current session keeps its applied configuration."
            : "Start applies the saved profile and skills after native acknowledgement."}
        </p>
      )}
      {session.lastError && (
        <p
          role="alert"
          className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {session.lastError.message}
        </p>
      )}
      <nav
        aria-label={`${agent.profile.name} views`}
        className="mt-6 flex gap-5 overflow-x-auto border-b"
      >
        {(["conversation", "jobs", "scratchpad", "profile"] as AgentTab[]).map(
          (value) => (
            <button
              key={value}
              aria-current={tab === value ? "page" : undefined}
              onClick={() => setTab(value)}
              className={`shrink-0 border-b-2 px-1 pb-3 text-sm font-medium capitalize ${tab === value ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
            >
              {value}
              {value === "jobs" && agentJobs.length > 0
                ? ` (${agentJobs.length})`
                : ""}
            </button>
          ),
        )}
      </nav>
      {/* Keep editors mounted while changing views so unsaved drafts survive navigation. */}
      <div hidden={tab !== "conversation"} className="mx-auto max-w-4xl">
        <Conversation
          agent={agent}
          snapshot={snapshot}
          client={client}
          pending={pending}
          act={act}
          historyVersion={historyVersion}
          visible={visible && tab === "conversation"}
        />
      </div>
      <div hidden={tab !== "jobs"} className="py-6">
        <JobsView
          agent={agent}
          snapshot={snapshot}
          client={client}
          pending={pending}
          act={act}
        />
      </div>
      <div hidden={tab !== "scratchpad"} className="mx-auto max-w-4xl py-6">
        <PageHeading
          title="Scratchpad"
          description="The agent’s visible working notes. These can change as its work develops."
        />
        {agent.scratchpad.markdown ? (
          <div className="agent-markdown rounded-xl border p-5">
            <Markdown text={agent.scratchpad.markdown} />
          </div>
        ) : (
          <Empty icon={<FileText />} title="No notes yet">
            <p>This agent has not saved any working notes.</p>
          </Empty>
        )}
        <p className="mt-4 text-xs text-muted-foreground">
          Last saved {formatDate(agent.scratchpad.updatedAt)} · Read only
        </p>
      </div>
      <div hidden={tab !== "profile"} className="mx-auto max-w-3xl py-6">
        <ProfileEditor
          agent={agent}
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
        <div className="mt-8 space-y-3 border-t pt-6 text-sm">
          <h2 className="font-medium">Access and resources</h2>
          <p className="text-muted-foreground">
            Permissions and service connections are managed in Settings. Skills
            provide instructions; they do not grant access.
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
            <dt className="text-muted-foreground">Permission groups</dt>
            <dd>{agent.access.permissionGroupIds.length || "None assigned"}</dd>
            <dt className="text-muted-foreground">Connections</dt>
            <dd>
              {agent.access.serviceConnectionIds.length || "None assigned"}
            </dd>
            <dt className="text-muted-foreground">Reports to</dt>
            <dd>{actorLabel(agent.reportsTo, snapshot)}</dd>
            <dt className="text-muted-foreground">Resources</dt>
            <dd>
              {agent.resources.length
                ? agent.resources
                    .map(
                      (resource) => `${resource.kind} · ${resource.location}`,
                    )
                    .join("\n")
                : "None attached. Conversations do not require a coding environment."}
            </dd>
          </dl>
        </div>
        {!agent.archivedAt && (
          <div className="mt-8 flex flex-wrap items-center justify-between gap-4 border-t pt-6">
            <div>
              <h2 className="text-sm font-medium">Archive agent</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Hide it from the default list. History and resources are
                retained.
              </p>
            </div>
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
              Archive
            </Button>
          </div>
        )}
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
}: {
  agent: Agent;
  snapshot: AgentsSnapshot;
  client: AgentsClient;
  pending: Set<string>;
  act: Action;
  historyVersion: number;
  visible: boolean;
}) {
  const [items, setItems] = useState<RuntimeHistoryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const sequence = useRef(0);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<DeliveryMode>("queue");
  const [jobId, setJobId] = useState("");
  const agentJobs = snapshot.jobs.filter(
    (job) => job.assignment.assignedToAgentId === agent.id,
  );
  const intents = snapshot.pendingMessages.filter(
    (message) => message.recipientAgentId === agent.id,
  );
  const receipts = snapshot.receipts.filter(
    (receipt) => receipt.recipientAgentId === agent.id,
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
    if (!content) return;
    const submitted = draft;
    const success = await act(`send-${agent.id}`, () =>
      client.sendMessage({
        recipientAgentId: agent.id,
        jobId: jobId || null,
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
  return (
    <div className="py-6">
      {historyError && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-destructive/30 p-3 text-sm text-destructive"
        >
          {historyError}
          <Button variant="ghost" className="ml-2" onClick={() => void load()}>
            Retry history
          </Button>
        </div>
      )}
      <div aria-label="Native conversation" className="min-h-52 space-y-5">
        {cursor && (
          <div className="text-center">
            <Button
              variant="outline"
              disabled={loading}
              onClick={() => void load(cursor)}
            >
              Load earlier history
            </Button>
          </div>
        )}
        {!items.length && (
          <Empty
            icon={
              loading ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <MessageSquare />
              )
            }
            title={loading ? "Loading conversation" : "No conversation yet"}
          >
            <p>
              {agent.runtime.threadId
                ? "Native history has no messages to display."
                : "Start makes this agent available. Your first message begins the conversation."}
            </p>
          </Empty>
        )}
        {items
          .filter((item) => item.kind !== "other")
          .map((item) => (
            <HistoryItem
              key={item.runtimeRef}
              item={item}
              snapshot={snapshot}
              client={client}
            />
          ))}
      </div>
      {(intents.length > 0 || receipts.length > 0) && (
        <details className="my-6 rounded-lg border px-4 py-3 text-sm">
          <summary className="font-medium">
            Delivery activity
            {intents.length ? ` · ${intents.length} retained` : ""}
          </summary>
          <p className="mt-2 text-xs text-muted-foreground">
            Acknowledgement confirms native acceptance, not completion of the
            work.
          </p>
          <div className="mt-4 divide-y">
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
                <div key={receipt.messageId} className="py-3 text-xs">
                  <span className="font-medium">Acknowledged</span>
                  <span className="ml-2 text-muted-foreground">
                    {actorLabel(receipt.sender, snapshot)} ·{" "}
                    {formatDate(receipt.acknowledgedAt)}
                  </span>
                  <details className="mt-2 text-muted-foreground">
                    <summary>Delivery reference</summary>
                    <p className="mt-1 break-all">
                      {receipt.messageId} · Attempt {receipt.attemptId}
                    </p>
                    <p className="break-all">
                      Thread {receipt.threadId}
                      {receipt.runtimeMessageRef
                        ? ` · Message ${receipt.runtimeMessageRef}`
                        : " · Native message reference unavailable"}
                    </p>
                  </details>
                </div>
              ))}
          </div>
        </details>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        className="sticky bottom-3 mt-6 rounded-xl border bg-background p-3 shadow-sm"
      >
        <Textarea
          aria-label={`Message ${agent.profile.name}`}
          placeholder={`Message ${agent.profile.name}…`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="min-h-20 border-0 shadow-none focus-visible:ring-0"
          disabled={Boolean(agent.archivedAt)}
        />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <NativeSelect
              aria-label="Delivery mode"
              value={mode}
              onChange={(event) => setMode(event.target.value as DeliveryMode)}
            >
              <option value="queue">Queue</option>
              <option value="steer">Steer</option>
            </NativeSelect>
            <NativeSelect
              aria-label="Related job"
              value={jobId}
              onChange={(event) => setJobId(event.target.value)}
              className="max-w-52"
            >
              <option value="">No job</option>
              {agentJobs.map((job) => (
                <option key={job.id} value={job.id}>
                  {jobTitle(job)}
                </option>
              ))}
            </NativeSelect>
          </div>
          <Button
            type="submit"
            aria-label={`Send ${mode} message`}
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
            Send
          </Button>
        </div>
        <p className="mt-2 px-1 text-xs text-muted-foreground">
          {agent.runtime.session.observedState === "stopped"
            ? "This agent is stopped. Messages are retained until you explicitly Start it."
            : mode === "queue"
              ? "Waits for the current turn to finish."
              : "Addresses the active turn when supported. Unsupported steering is not sent."}
        </p>
      </form>
    </div>
  );
}

function HistoryItem({
  item,
  snapshot,
  client,
}: {
  item: RuntimeHistoryItem;
  snapshot: AgentsSnapshot;
  client: AgentsClient;
}) {
  const own =
    item.sender.type === "user" && item.sender.userId === snapshot.ownerId;
  const technical = item.kind === "tool" || item.kind === "approval";
  const content = <Content blocks={item.content} client={client} />;
  return (
    <article
      className={own ? "ml-auto max-w-[92%] sm:max-w-[85%]" : "max-w-full"}
    >
      <div
        className={`mb-2 flex items-center gap-2 text-xs text-muted-foreground ${own ? "justify-end" : ""}`}
      >
        <strong className="font-medium text-foreground">
          {historyActor(item, snapshot)}
        </strong>
        <span>
          {item.kind === "approval"
            ? "Native approval record"
            : item.kind === "tool"
              ? "Tool activity"
              : ""}
        </span>
      </div>
      {technical ? (
        <details className="rounded-lg border bg-muted/20 px-3 py-2 text-sm">
          <summary>
            {item.kind === "approval"
              ? "Approval details"
              : "Execution details"}
          </summary>
          <div className="mt-3">{content}</div>
          <HistoryCorrelation item={item} />
        </details>
      ) : (
        <div
          className={`rounded-xl p-4 ${own ? "bg-muted" : "border bg-background"}`}
        >
          {content}
          <HistoryCorrelation item={item} />
        </div>
      )}
    </article>
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
  skills,
  pending,
  onSave,
}: {
  agent?: Agent;
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
  return (
    <form
      className="space-y-6"
      onSubmit={async (event) => {
        event.preventDefault();
        const submittedVersion = editVersion.current;
        const saved = await onSave({
          profile,
          skills: selection,
          expectedRevision: revision,
        });
        if (saved) {
          setRevision(saved.profile.revision);
          if (submittedVersion === editVersion.current) setDirty(false);
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
          <Button variant="ghost" onClick={() => setDirty(false)}>
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
      <Field
        label="Picture reference"
        hint="Use an existing Crew artifact reference. Leave empty for initials."
      >
        <Input
          value={profile.pictureRef ?? ""}
          onChange={(event) => change("pictureRef", event.target.value || null)}
        />
      </Field>
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
            !profile.name.trim() ||
            Boolean(agent && dirty && revision !== agent.profile.revision)
          }
        >
          {pending && <LoaderCircle className="animate-spin" />}{" "}
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
      {job.progress.detail && (
        <p className="mt-3 text-sm text-muted-foreground">
          {job.progress.detail}
        </p>
      )}
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
}: {
  snapshot: AgentsSnapshot;
  client: AgentsClient;
  pending: Set<string>;
  act: Action;
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
}: {
  snapshot: AgentsSnapshot;
  panels: AgentSettingsPanel[];
  refresh: () => Promise<void>;
}) {
  const [active, setActive] = useState(panels[0]?.id ?? "");
  const panel = panels.find((item) => item.id === active) ?? panels[0];
  return (
    <>
      <PageHeading
        title="Project settings"
        description="Shared settings for the agents in this project."
      />
      {!panels.length ? (
        <Empty icon={<Settings />} title="Access settings are not connected">
          <p>
            The access-control track supplies connection, permission and grant
            panels here. Agent profiles remain available on each agent.
          </p>
        </Empty>
      ) : (
        <div className="flex flex-col items-start gap-8 md:flex-row">
          <nav
            aria-label="Settings pages"
            className="flex shrink-0 gap-2 md:w-44 md:flex-col"
          >
            {panels.map((item) => (
              <Button
                key={item.id}
                variant="ghost"
                className={`justify-start ${panel?.id === item.id ? "bg-primary/10 text-primary" : "text-muted-foreground"}`}
                aria-current={panel?.id === item.id ? "page" : undefined}
                onClick={() => setActive(item.id)}
              >
                {item.label}
              </Button>
            ))}
          </nav>
          <div className="min-w-0 flex-1">
            {panels.map((item) => (
              <div key={item.id} hidden={panel?.id !== item.id}>
                {item.render({ snapshot, refresh })}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function AgentJobSummary({ agent, jobs }: { agent: Agent; jobs: Job[] }) {
  const assigned = jobs
    .filter((job) => job.assignment.assignedToAgentId === agent.id)
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const job = assigned[0];
  if (!job)
    return <p className="text-xs text-muted-foreground">No assigned job</p>;
  // Cards show a selected job only; no status is inferred from native execution.
  return (
    <div>
      <div className="mb-2 truncate text-xs text-muted-foreground">
        {jobTitle(job)}
        {assigned.length > 1 ? ` · +${assigned.length - 1} jobs` : ""}
      </div>
      <JobProgressView job={job} />
    </div>
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
  return safeUrl(url) ? (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="text-primary underline-offset-4 hover:underline"
    >
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
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
function Avatar({ agent, client }: { agent: Agent; client: AgentsClient }) {
  const ref = agent.profile.pictureRef;
  const url = ref ? client.artifactUrl?.(ref) : null;
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return url && safeUrl(url, true) && !failed ? (
    <img
      src={url}
      alt=""
      onError={() => setFailed(true)}
      referrerPolicy="no-referrer"
      className="size-11 shrink-0 rounded-xl object-cover"
    />
  ) : (
    <div
      aria-hidden="true"
      className="flex size-11 shrink-0 items-center justify-center rounded-xl border bg-muted text-sm font-semibold text-muted-foreground"
    >
      {agent.profile.name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0])
        .join("")
        .toUpperCase() || "A"}
    </div>
  );
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
function NavButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={
        active ? "bg-primary/10 text-primary" : "text-muted-foreground"
      }
    >
      {icon}
      <span className="hidden sm:inline">{children}</span>
      <span className="sr-only sm:hidden">{children}</span>
    </Button>
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
function actorLabel(
  actor: import("../../../src/agents/contracts.mjs").MessageSender,
  snapshot: AgentsSnapshot,
) {
  if (actor.type === "system") return "Internal";
  return actor.type === "agent"
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
