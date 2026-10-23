import { useCallback, useEffect, useRef, useState } from "react";
import {
  BookOpen,
  CalendarClock,
  FolderOpen,
  LogIn,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import type { AccessOwnerView } from "../../../src/access/owner-contracts.mjs";
import type {
  EnvironmentPolicy,
  RuntimeBinding,
} from "../../../src/agents/contracts.mjs";
import {
  equivalentWorkspaceChoices,
  workspaceConfigurationDescription,
  workspaceConfigurationKey,
} from "../../../src/agents/workspace-identity.mjs";
import type { ApprovedWorkspace } from "../../../src/agents/environments.mjs";
import { OwnerAccessSettings } from "../access/OwnerAccessSettings";
import { ServiceConnectionWizard } from "../access";
import { ProjectSkillsPanel } from "../skills/ProjectSkillsPanel";
import type { ProjectSkillsClient } from "../skills/client";
import { SettingsToast } from "../manager/settings/SettingsToast";
import {
  AgentSchedulesPanel,
  type AgentSchedulesClient,
} from "./AgentSchedulesPanel";
import { PrimaryAgentVoice } from "./voice/PrimaryAgentVoice";
import { SubscriptionUsagePanel } from "./SubscriptionUsagePanel";
import { EnvironmentTemplateEditor } from "./EnvironmentTemplateEditor";
import type {
  SubscriptionUsageClient,
  SubscriptionUsageState,
} from "../../../src/application/subscription-usage-contracts.mjs";
import type { PrimaryVoiceClient, PrimaryVoiceEvent } from "./voice/client";
import type { ProjectPresentation } from "./DesktopApplication";
import type { AgentsSnapshot } from "./client";
import {
  AgentSetupWizard,
  type ConnectionWizardContext,
} from "./AgentSetupWizard";

type Command = <T>(name: string, args: unknown) => Promise<T>;
type Subscribe = (listener: (event: unknown) => void) => () => void;
type SubscriptionStatus =
  | { state: "signed_in"; plan: string | null }
  | {
      state: "sign_in_required";
      signIn?:
        | { state: "pending"; reason: null }
        | {
            state: "failed";
            reason: string;
            stage:
              | "initialization"
              | "configuration"
              | "request"
              | "response"
              | "completion"
              | "transport";
            code: number | null;
          };
    }
  | { state: "blocked"; reason: string };
interface SignIn {
  type: "browser";
  loginId: string;
  authorizationUrl: string;
}
interface ProjectEvent {
  type?: string;
  projectId?: string;
  event?: unknown;
}
/** One presentation per project, backed by the desktop's authenticated owner
 * command channel. No render, navigation, or subscription starts an agent/call. */
export function createProjectPresentation(
  projectId: string,
  command: Command,
  subscribe: Subscribe,
  openLink?: (url: string) => Promise<unknown>,
): ProjectPresentation {
  const onOwnerChange: Subscribe = (listener) =>
    subscribe((input) => {
      const event = input as ProjectEvent;
      if (
        event?.type !== "owner" ||
        event.projectId !== projectId ||
        !event.event
      )
        return;
      const detail = event.event as { kind?: string };
      // Token/history streams have their own reader; settings observe saved changes.
      if (detail.kind !== "runtime") listener(event.event);
    });
  const skills: ProjectSkillsClient = {
    list: () => command("skills.list", {}),
    read: (skillId) => command("skills.read", { skillId }),
    create: (input) => command("skills.create", input),
    update: (input) => command("skills.update", input),
    subscribe: (listener) => onOwnerChange(listener),
  };
  const schedules: AgentSchedulesClient = {
    read: (agentId) => command("schedules.read", { agentId }),
    save: (agentId, input) => command("schedules.save", { agentId, ...input }),
  };
  const voice: PrimaryVoiceClient = {
    listVoices: (binding) => command("voice.list", { binding }),
    start: (input) => command("voice.start", input),
    stop: (input) => command("voice.stop", input),
    ready: (input) => command("voice.ready", input),
    subscribeCatalog: (listener) => onOwnerChange(listener),
    subscribe: (listener) =>
      subscribe((input) => {
        const event = input as ProjectEvent;
        if (
          event?.type === "voice" &&
          event.projectId === projectId &&
          validVoiceEvent(event.event, projectId)
        )
          listener(event.event);
      }),
  };
  const usage: SubscriptionUsageClient = {
    read: () => command("subscription.usage", {}),
    subscribe: (listener) =>
      subscribe((input) => {
        const event = input as {
          type?: string;
          projectId?: string;
          state?: SubscriptionUsageState;
        };
        if (
          event.type === "subscription-usage" &&
          event.projectId === projectId &&
          event.state
        )
          listener(event.state);
      }),
  };
  const signIn = (visible: boolean, onStatus: (signedIn: boolean) => void) => (
    <SubscriptionSettings
      command={command}
      subscribe={onOwnerChange}
      visible={visible}
      openLink={openLink}
      onStatus={onStatus}
    />
  );
  const connectionWizard = (context: ConnectionWizardContext) => (
    <ServiceConnectionWizard {...context} isOwner />
  );
  return {
    settingsPanels: [
      {
        id: "agents",
        label: "Agents",
        icon: ShieldCheck,
        description:
          "Configure your agents and choose which one acts as your manager.",
        render: ({ snapshot, refresh, visible }) => (
          <AgentSetupWizard
            snapshot={snapshot}
            refresh={refresh}
            command={command}
            subscribe={onOwnerChange}
            visible={visible}
            renderSignIn={signIn}
            renderConnectionWizard={connectionWizard}
          />
        ),
      },
      {
        id: "subscription",
        label: "Subscription & usage",
        icon: LogIn,
        description:
          "Sign-in and account-wide Codex allowance shared with your other clients.",
        render: ({ visible }) => (
          <div className="space-y-8">
            <SubscriptionSettings
              command={command}
              subscribe={onOwnerChange}
              visible={visible}
              openLink={openLink}
            />
            <SubscriptionUsagePanel client={usage} visible={visible} />
          </div>
        ),
      },
      {
        id: "access",
        label: "Connections & access",
        icon: ShieldCheck,
        description:
          "Manage service connections, permissions and approved agent defaults.",
        render: ({ snapshot, refresh, visible }) => (
          <AccessSettings
            projectId={projectId}
            command={command}
            subscribe={onOwnerChange}
            snapshot={snapshot}
            refreshProject={refresh}
            visible={visible}
          />
        ),
      },
      {
        id: "workspace",
        label: "Workspace",
        icon: FolderOpen,
        description:
          "Approve local access to this project's registered folder.",
        render: ({ visible, refresh }) => (
          <WorkspaceSettings
            projectId={projectId}
            command={command}
            subscribe={onOwnerChange}
            visible={visible}
            refreshProject={refresh}
          />
        ),
      },
      {
        id: "skills",
        label: "Skills",
        icon: BookOpen,
        description:
          "Manage reusable instructions shared by selected project agents.",
        render: ({ visible }) => (
          <ProjectSkillsPanel client={skills} visible={visible} />
        ),
      },
      {
        id: "schedules",
        label: "Schedules",
        icon: CalendarClock,
        description: "Choose when your agents work in the background.",
        render: ({ snapshot, visible }) => (
          <SchedulesSettings
            client={schedules}
            snapshot={snapshot}
            visible={visible}
          />
        ),
      },
    ],
    renderSetup: (context) => {
      const primaryId = primaryAgentId(context.snapshot);
      if (
        context.snapshot.agents.some(
          (agent) => agent.id === primaryId && !agent.archivedAt,
        )
      )
        return null;
      return (
        <AgentSetupWizard
          snapshot={context.snapshot}
          refresh={context.refresh}
          command={command}
          subscribe={onOwnerChange}
          visible={context.visible}
          firstUse
          renderSignIn={signIn}
          renderConnectionWizard={connectionWizard}
        />
      );
    },
    renderVoice: ({
      primaryAgent,
      visible,
      mode,
      controlsTarget,
      transcriptTarget,
    }) => (
      <PrimaryAgentVoice
        client={voice}
        agent={primaryAgent}
        visible={visible}
        mode={mode}
        controlsTarget={controlsTarget}
        transcriptTarget={transcriptTarget}
        embedded
      />
    ),
  };
}

function primaryAgentId(snapshot: AgentsSnapshot) {
  return snapshot.projectSettings
    ? snapshot.projectSettings.primaryAgentId
    : (snapshot.primaryAgentId ?? null);
}

function validVoiceEvent(
  value: unknown,
  projectId: string,
): value is PrimaryVoiceEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<PrimaryVoiceEvent>;
  return Boolean(
    event.binding &&
    event.binding.projectId === projectId &&
    typeof event.binding.agentId === "string" &&
    typeof event.binding.sessionId === "string" &&
    typeof event.binding.threadId === "string" &&
    typeof event.callId === "string" &&
    ((event.kind === "transcript" &&
      typeof event.itemId === "string" &&
      event.itemId.length > 0 &&
      event.itemId.length <= 512 &&
      (event.role === "user" || event.role === "assistant") &&
      typeof event.text === "string" &&
      event.text.length <= 200_000 &&
      typeof event.done === "boolean" &&
      typeof event.delta === "boolean") ||
      ((event.kind === "closed" || event.kind === "error") &&
        (event.message === undefined || typeof event.message === "string"))),
  );
}

function AccessSettings({
  projectId,
  command,
  subscribe,
  snapshot,
  refreshProject,
  visible,
}: {
  projectId: string;
  command: Command;
  subscribe: Subscribe;
  snapshot: AgentsSnapshot;
  refreshProject(): Promise<void>;
  visible: boolean;
}) {
  const [access, setAccess] = useState<AccessOwnerView | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceView[]>([]);
  const [error, setError] = useState("");
  const [toast, setToast] = useState<{ id: string; message: string } | null>(
    null,
  );
  const sequence = useRef(0),
    alive = useRef(true);
  const reload = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const [next, environments] = await Promise.all([
        command<AccessOwnerView>("access.snapshot", {}),
        command<{ workspaces: WorkspaceView[] }>("environments.snapshot", {}),
      ]);
      if (next.projectId !== projectId) throw new Error("Project mismatch");
      if (
        !Array.isArray(environments.workspaces) ||
        environments.workspaces.some(
          (workspace) => workspace.policy.projectId !== projectId,
        )
      )
        throw new Error("Workspace project mismatch");
      if (alive.current && request === sequence.current) {
        setAccess(next);
        setWorkspaces(environments.workspaces);
        setError("");
      }
    } catch {
      if (alive.current && request === sequence.current)
        setError(
          "Access settings could not be refreshed. Your saved settings and open drafts are retained.",
        );
      throw new Error("Access settings refresh failed.");
    }
  }, [command, projectId]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      sequence.current++;
    };
  }, []);
  useEffect(() => {
    if (visible) void reload().catch(() => {});
  }, [visible, reload]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribe(() => {
      if (!visible || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        void reload().catch(() => {});
      }, 150);
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [subscribe, visible, reload]);
  const notify = (message: string) =>
    setToast({ id: crypto.randomUUID(), message });
  return (
    <div className="min-w-0">
      {error && (
        <div
          role="alert"
          className="mb-5 flex flex-wrap items-center justify-between gap-3 text-sm text-destructive"
        >
          <p>{error}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void Promise.all([reload(), refreshProject()]).catch(() =>
                setError(
                  "Access settings could not be refreshed. Your saved settings and open drafts are retained.",
                ),
              )
            }
          >
            Retry
          </Button>
        </div>
      )}
      {access ? (
        <OwnerAccessSettings
          snapshot={access}
          workspaces={workspaces.map((workspace) => ({
            policy: workspace.policy,
            label: workspace.workspace.path,
            configurationKey: workspaceConfigurationKey(workspace),
            description: workspaceConfigurationDescription(workspace),
          }))}
          isOwner
          showAgentAssignments={false}
          onNotify={notify}
          onCommand={async (name, args) => {
            await command(`access.${name}`, args);
            // A failed read must not turn an acknowledged mutation into a retryable save.
            const refreshed = await Promise.allSettled([
              reload(),
              refreshProject(),
            ]);
            if (refreshed.some((result) => result.status === "rejected"))
              setError(
                "Your change was saved, but settings could not be refreshed. Retry the refresh to see the current saved settings.",
              );
          }}
        />
      ) : (
        <p className="py-6 text-sm text-muted-foreground">
          {error ? "Access settings unavailable." : "Loading access settings…"}
        </p>
      )}
      {toast && visible && (
        <SettingsToast
          key={toast.id}
          message={toast.message}
          onDismiss={() => setToast(null)}
        />
      )}
    </div>
  );
}

// Browser-only projection of the native environment owner's workspace records.
type WorkspaceView = ApprovedWorkspace;

function WorkspaceSettings({
  projectId,
  command,
  subscribe,
  visible,
  refreshProject,
}: {
  projectId: string;
  command: Command;
  subscribe: Subscribe;
  visible: boolean;
  refreshProject(): Promise<void>;
}) {
  const [saved, setSaved] = useState<{
    folder: string;
    workspaces: WorkspaceView[];
  } | null>(null);
  const [draft, setDraft] = useState<{
    policyId: string;
    revision: number | null;
    folder: string;
    writable: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [toast, setToast] = useState<{ id: string; message: string } | null>(
    null,
  );
  const alive = useRef(true),
    sequence = useRef(0),
    action = useRef(false);
  const current = saved?.workspaces.find(
    (row) => row.policy.id === draft?.policyId,
  );
  const stale =
    draft !== null &&
    saved !== null &&
    (draft.folder !== saved.folder ||
      draft.revision !== (current?.policy.revision ?? null));
  const simple = (row: WorkspaceView) =>
    row.workspace.path === saved?.folder &&
    row.executableDirectories.length === 0 &&
    row.managedWorktreeRoot === null;
  const reload = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const [snapshot, folder] = await Promise.all([
        command<{ workspaces: WorkspaceView[] }>("environments.snapshot", {}),
        command<{ directory: string }>("environments.projectFolder", {}),
      ]);
      if (
        !folder ||
        typeof folder.directory !== "string" ||
        !folder.directory ||
        !Array.isArray(snapshot?.workspaces) ||
        snapshot.workspaces.some((row) => row.policy.projectId !== projectId)
      )
        throw new Error("Invalid workspace view");
      if (alive.current && request === sequence.current) {
        setSaved({ folder: folder.directory, workspaces: snapshot.workspaces });
        setError("");
      }
    } catch {
      if (alive.current && request === sequence.current)
        setError(
          "Workspace approval could not be refreshed. Your saved policies and open draft are retained.",
        );
    }
  }, [command, projectId]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      sequence.current++;
    };
  }, []);
  useEffect(() => {
    if (visible) void reload();
  }, [visible, reload]);
  useEffect(
    () =>
      subscribe(() => {
        if (visible && !action.current) void reload();
      }),
    [subscribe, visible, reload],
  );
  async function save() {
    if (!draft || !saved || stale || action.current) return;
    const submitted = draft;
    action.current = true;
    setBusy(true);
    setError("");
    try {
      await command("environments.approveWorkspace", {
        input: {
          policyId: submitted.policyId,
          workspaceDirectory: submitted.folder,
          writable: submitted.writable,
          executableDirectories: [],
        },
        expectedRevision: submitted.revision,
      });
      if (alive.current) {
        setDraft((value) => (value === submitted ? null : value));
        setToast({
          id: crypto.randomUUID(),
          message:
            "Workspace approved. Assign its policy to an agent's permission group in Connections & access.",
        });
      }
      await Promise.all([reload(), refreshProject()]);
    } catch {
      if (alive.current)
        setError(
          "Workspace approval was not confirmed. Refresh to check the saved policy before retrying; your draft is retained.",
        );
    } finally {
      action.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="space-y-5 py-6">
      <div>
        <h2 className="font-semibold tracking-tight">Project workspace</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Approve the registered project folder, then assign its policy to a
          permission group in Connections & access.
        </p>
      </div>
      {saved ? (
        <>
          <div className="grid items-start gap-3 border-y py-6 sm:grid-cols-[136px_minmax(0,1fr)_auto] sm:gap-6">
            <h3 className="text-sm font-medium">Project folder</h3>
            <p className="break-all text-sm text-muted-foreground">
              {saved.folder}
            </p>
            {!draft &&
              !saved.workspaces.some(
                (row) => row.workspace.path === saved.folder,
              ) && (
                <Button
                  variant="link"
                  className="h-auto p-0 text-sm font-semibold"
                  onClick={() =>
                    setDraft({
                      policyId: crypto.randomUUID(),
                      revision: null,
                      folder: saved.folder,
                      writable: false,
                    })
                  }
                >
                  Approve folder
                </Button>
              )}
          </div>
          {equivalentWorkspaceChoices(saved.workspaces).map(
            ({ workspace: row, policyIds }) => (
              <div
                key={row.policy.id}
                className="flex flex-wrap items-start justify-between gap-3 border-b pb-5"
              >
                <div className="min-w-0">
                  <p className="break-all text-sm">{row.workspace.path}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {workspaceConfigurationDescription(row)}
                  </p>
                  <details className="mt-2 text-xs text-muted-foreground">
                    <summary className="cursor-pointer">Policy details</summary>
                    {policyIds.map((id) => (
                      <p key={id} className="mt-2 break-all">
                        {id}
                      </p>
                    ))}
                    {policyIds.length > 1 && (
                      <p className="mt-2">
                        Equivalent legacy approvals retained for existing
                        assignments and environments. Update edits the first
                        listed policy.
                      </p>
                    )}
                  </details>
                </div>
                {!draft && simple(row) && (
                  <Button
                    variant="link"
                    className="h-auto p-0 text-sm font-semibold"
                    onClick={() =>
                      setDraft({
                        policyId: row.policy.id,
                        revision: row.policy.revision,
                        folder: row.workspace.path,
                        writable: row.writable,
                      })
                    }
                  >
                    Update
                  </Button>
                )}
              </div>
            ),
          )}
          {draft && (
            <div className="space-y-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="accent-primary"
                  disabled={busy || stale}
                  checked={draft.writable}
                  onChange={(event) =>
                    setDraft({ ...draft, writable: event.target.checked })
                  }
                />
                Allow writes in the project folder
              </label>
              <p className="text-xs leading-5 text-muted-foreground">
                Read-only is the default. Commands run within the local sandbox
                without network access. This approval adds no executable
                directories or managed worktree root and does not start an agent
                or command.
              </p>
              {stale && (
                <p role="alert" className="text-sm text-destructive">
                  The saved policy changed elsewhere.{" "}
                  <button className="underline" onClick={() => setDraft(null)}>
                    Reload the saved policy
                  </button>{" "}
                  before editing.
                </p>
              )}
              <div className="flex gap-2">
                <Button disabled={busy || stale} onClick={() => void save()}>
                  {busy ? "Saving…" : "Save approval"}
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setDraft(null);
                    setError("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          {error
            ? "Workspace settings unavailable."
            : "Loading workspace settings…"}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button variant="ghost" disabled={busy} onClick={() => void reload()}>
        Refresh workspace
      </Button>
      <EnvironmentTemplateEditor
        command={command}
        subscribe={subscribe}
        visible={visible}
      />
      {toast && visible && (
        <SettingsToast
          key={toast.id}
          message={toast.message}
          onDismiss={() => setToast(null)}
        />
      )}
    </section>
  );
}

function SchedulesSettings({
  client,
  snapshot,
  visible,
}: {
  client: AgentSchedulesClient;
  snapshot: AgentsSnapshot;
  visible: boolean;
}) {
  const [toast, setToast] = useState<{ id: string; message: string } | null>(
    null,
  );
  return (
    <>
      <AgentSchedulesPanel
        client={client}
        agents={snapshot.agents}
        primaryAgentId={primaryAgentId(snapshot)}
        visible={visible}
        onNotify={(message) => setToast({ id: crypto.randomUUID(), message })}
      />
      {toast && visible && (
        <SettingsToast
          key={toast.id}
          message={toast.message}
          onDismiss={() => setToast(null)}
        />
      )}
    </>
  );
}

function SubscriptionSettings({
  command,
  subscribe,
  visible,
  openLink,
  onStatus,
}: {
  command: Command;
  subscribe: Subscribe;
  visible: boolean;
  openLink?: (url: string) => Promise<unknown>;
  onStatus?: (signedIn: boolean) => void;
}) {
  const [status, setStatus] = useState<SubscriptionStatus | null>(null);
  const [login, setLogin] = useState<SignIn | null>(null);
  const [signInPending, setSignInPending] = useState(false);
  const [startFailed, setStartFailed] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const alive = useRef(true),
    sequence = useRef(0),
    action = useRef(false);
  const reload = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const next = await command<SubscriptionStatus>("subscription.status", {});
      if (
        !next ||
        !["signed_in", "sign_in_required", "blocked"].includes(next.state) ||
        (next.state === "signed_in" &&
          next.plan !== null &&
          typeof next.plan !== "string") ||
        (next.state === "blocked" && typeof next.reason !== "string") ||
        (next.state === "sign_in_required" &&
          next.signIn !== undefined &&
          !validSignInStatus(next.signIn))
      )
        throw new Error("Invalid subscription state");
      if (alive.current && request === sequence.current) {
        setStatus(next);
        onStatus?.(next.state === "signed_in");
        setStatusError("");
        if (next.state === "signed_in") {
          setLogin(null);
          setSignInPending(false);
          setStartFailed(false);
          setError("");
        } else if (
          next.state === "sign_in_required" &&
          next.signIn?.state === "failed"
        ) {
          setLogin(null);
          setSignInPending(false);
          setStartFailed(false);
          setError(next.signIn.reason);
        } else if (
          next.state === "sign_in_required" &&
          next.signIn?.state === "pending"
        ) {
          setSignInPending(true);
        }
      }
    } catch {
      if (alive.current && request === sequence.current) {
        onStatus?.(false);
        setStatusError(
          "Subscription status could not be checked. Retry when the native connection is available.",
        );
      }
    }
  }, [command, onStatus]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      sequence.current++;
    };
  }, []);
  useEffect(() => {
    if (visible) void reload();
  }, [visible, reload]);
  useEffect(
    () =>
      subscribe(() => {
        if (visible && !action.current) void reload();
      }),
    [subscribe, visible, reload],
  );
  useEffect(() => {
    if (!signInPending || startFailed || !visible || busy) return;
    const timer = setTimeout(() => void reload(), 3000);
    return () => clearTimeout(timer);
  }, [signInPending, startFailed, visible, busy, status, reload]);
  async function run(kind: "beginSignIn" | "cancelSignIn") {
    if (action.current) return;
    action.current = true;
    sequence.current++;
    setBusy(true);
    setError("");
    try {
      if (kind === "beginSignIn") {
        setSignInPending(true);
        setStartFailed(false);
        const result = await command<SignIn>("subscription.beginSignIn", {});
        if (!validSignIn(result))
          throw new Error("Unsupported verification result");
        if (alive.current) setLogin(result);
      } else {
        await command("subscription.cancelSignIn", {});
        if (alive.current) {
          setLogin(null);
          setSignInPending(false);
          setStartFailed(false);
        }
      }
      await reload();
    } catch {
      if (alive.current) {
        if (kind === "beginSignIn") setStartFailed(true);
        setError(
          kind === "beginSignIn"
            ? "Sign-in did not return a usable browser link. Check the status or cancel the pending attempt before starting again."
            : "Sign-in cancellation was not confirmed. Check the current status before trying again.",
        );
        // Read the provider's bounded stage classification after an action fails.
        // A generic status result must still retain the original action error.
        await reload();
      }
    } finally {
      action.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="space-y-5 py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold tracking-tight">ChatGPT subscription</h2>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
            Sign in with your existing ChatGPT account to use its subscription
            in Crew. Crew keeps its project profile and configuration separate
            from your personal Codex setup. Service connections and agent
            permissions are managed separately.
          </p>
        </div>
        <Button
          variant="link"
          className="h-auto p-0 text-sm font-semibold"
          disabled={busy}
          onClick={() => void reload()}
        >
          Refresh status
        </Button>
      </div>
      <div className="border-y py-5">
        <p className="text-sm">
          {status?.state === "signed_in"
            ? `Signed in${status.plan ? ` · ${status.plan}` : ""}`
            : status?.state === "sign_in_required"
              ? "Sign in to use your subscription."
              : status?.state === "blocked"
                ? "Subscription access needs attention."
                : "Checking subscription access…"}
        </p>
        {status?.state === "blocked" && (
          <p
            role="alert"
            className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground"
          >
            {status.reason.slice(0, 2000)}
          </p>
        )}
      </div>
      {login ? (
        <div className="space-y-4">
          <p className="text-sm">Continue sign-in in your browser.</p>
          <div className="flex flex-wrap gap-3">
            <Button
              disabled={!openLink || busy}
              onClick={() => {
                void openLink?.(login.authorizationUrl).catch(() =>
                  setError(
                    "The sign-in page could not be opened. Try Open sign-in page again.",
                  ),
                );
              }}
            >
              Open sign-in page
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void run("cancelSignIn")}
            >
              Cancel sign-in
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Finish sign-in in your browser, then return here. Starting sign-in
            does not start an agent or microphone.
          </p>
        </div>
      ) : signInPending ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {startFailed
              ? "Sign-in needs attention."
              : "Waiting for a confirmed sign-in result."}
          </p>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void run("cancelSignIn")}
          >
            Cancel sign-in
          </Button>
        </div>
      ) : (
        status?.state !== "signed_in" && (
          <Button disabled={busy} onClick={() => void run("beginSignIn")}>
            {busy ? "Starting sign-in…" : "Sign in with ChatGPT"}
          </Button>
        )
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {statusError && (
        <p role="alert" className="text-sm text-destructive">
          {statusError}
        </p>
      )}
    </section>
  );
}

function validSignIn(value: SignIn): boolean {
  if (
    !value ||
    value.type !== "browser" ||
    typeof value.loginId !== "string" ||
    !value.loginId ||
    value.loginId.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(value.loginId) ||
    typeof value.authorizationUrl !== "string" ||
    value.authorizationUrl.length > 4096
  )
    return false;
  try {
    const url = new URL(value.authorizationUrl);
    return (
      url.origin === "https://auth.openai.com" &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function validSignInStatus(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const signIn = value as Record<string, unknown>;
  if (signIn.state === "pending") return signIn.reason === null;
  return (
    signIn.state === "failed" &&
    typeof signIn.reason === "string" &&
    signIn.reason.length > 0 &&
    signIn.reason.length <= 2000 &&
    [
      "initialization",
      "configuration",
      "request",
      "response",
      "completion",
      "transport",
    ].includes(String(signIn.stage)) &&
    (signIn.code === null || Number.isSafeInteger(signIn.code))
  );
}
