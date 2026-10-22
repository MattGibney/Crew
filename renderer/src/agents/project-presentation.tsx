import { useCallback, useEffect, useRef, useState } from "react";
import {
  BookOpen,
  CalendarClock,
  FolderOpen,
  LogIn,
  ShieldCheck,
  Volume2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import type { AccessOwnerView } from "../../../src/access/owner-contracts.mjs";
import type {
  Agent,
  AgentCreationPreset,
  EnvironmentPolicy,
  RuntimeBinding,
} from "../../../src/agents/contracts.mjs";
import { OwnerAccessSettings } from "../access/OwnerAccessSettings";
import { ProjectSkillsPanel } from "../skills/ProjectSkillsPanel";
import type { ProjectSkillsClient } from "../skills/client";
import { SettingsToast } from "../manager/settings/SettingsToast";
import {
  AgentSchedulesPanel,
  type AgentSchedulesClient,
} from "./AgentSchedulesPanel";
import { PrimaryAgentVoice } from "./voice/PrimaryAgentVoice";
import type {
  PrimaryVoiceCatalog,
  PrimaryVoiceClient,
  PrimaryVoiceEvent,
} from "./voice/client";
import type { ProjectPresentation } from "./DesktopApplication";
import type { AgentsAppProps } from "./AgentsApp";
import type { AgentsSnapshot } from "./client";

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
  loginId: string;
  verificationUrl: string;
  userCode: string;
}
interface ProjectEvent {
  type?: string;
  projectId?: string;
  event?: unknown;
}
interface SetupDraft {
  presetId: string;
  name: string;
  selectedId: string;
}
type SetupContext = Parameters<NonNullable<AgentsAppProps["renderSetup"]>>[0];

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
  // Setup can leave its page to use the persistent Settings panels. This small
  // non-secret form draft belongs to the project presentation across that visit.
  const setupDraft: SetupDraft = { presetId: "", name: "", selectedId: "" };
  return {
    settingsPanels: [
      {
        id: "subscription",
        label: "Model access",
        icon: LogIn,
        description: "Use your ChatGPT subscription for this project's agents.",
        render: ({ visible }) => (
          <SubscriptionSettings
            command={command}
            subscribe={onOwnerChange}
            visible={visible}
            openLink={openLink}
          />
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
        id: "voice",
        label: "Voice",
        icon: Volume2,
        description: "Choose the voice for your primary agent's next call.",
        render: ({ snapshot, visible }) => (
          <VoiceSettings
            command={command}
            client={voice}
            snapshot={snapshot}
            visible={visible}
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
      return <PrimarySetup {...context} command={command} draft={setupDraft} />;
    },
    renderVoice: ({ primaryAgent, visible, mode, controlsTarget }) => (
      <PrimaryAgentVoice
        client={voice}
        agent={primaryAgent}
        visible={visible}
        mode={mode}
        controlsTarget={controlsTarget}
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
    (event.kind === "closed" || event.kind === "error") &&
    (event.message === undefined || typeof event.message === "string"),
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
  const [error, setError] = useState("");
  const [toast, setToast] = useState<{ id: string; message: string } | null>(
    null,
  );
  const sequence = useRef(0),
    alive = useRef(true);
  const reload = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const next = await command<AccessOwnerView>("access.snapshot", {});
      if (next.projectId !== projectId) throw new Error("Project mismatch");
      if (alive.current && request === sequence.current) {
        setAccess(next);
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
            onClick={() => void reload().catch(() => {})}
          >
            Retry
          </Button>
        </div>
      )}
      <PrimarySelection
        snapshot={snapshot}
        command={command}
        refresh={refreshProject}
        onNotify={notify}
      />
      {access ? (
        <OwnerAccessSettings
          snapshot={access}
          isOwner
          onNotify={notify}
          onCommand={async (name, args) => {
            await command(`access.${name}`, args);
            await Promise.all([reload(), refreshProject()]);
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

function PrimarySelection({
  snapshot,
  command,
  refresh,
  onNotify,
}: {
  snapshot: AgentsSnapshot;
  command: Command;
  refresh(): Promise<void>;
  onNotify(message: string): void;
}) {
  const savedId = primaryAgentId(snapshot);
  const revision = snapshot.projectSettings?.revision;
  const [draft, setDraft] = useState<{
    id: string;
    revision: number | undefined;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const selectedId = draft?.id ?? savedId ?? "";
  const stale = draft !== null && draft.revision !== revision;
  const agents = snapshot.agents.filter((agent) => !agent.archivedAt);
  const save = async () => {
    if (busy || !draft || !revision || stale) return;
    const submitted = draft;
    setBusy(true);
    setError("");
    try {
      await command("setPrimaryAgent", {
        agentId: submitted.id,
        expectedRevision: submitted.revision,
      });
      setDraft((current) => (current === submitted ? null : current));
      await refresh();
      onNotify("Primary agent saved. Existing sessions are unchanged.");
    } catch {
      setError(
        "The primary agent could not be selected. Refresh to check the saved choice before trying again.",
      );
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-4 border-b py-6">
      <div>
        <h2 className="font-semibold tracking-tight">Primary agent</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          The agent you talk to as your manager. Changing this choice does not
          start or stop a session.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <Label htmlFor="primary-agent-setting">Agent</Label>
          <NativeSelect
            id="primary-agent-setting"
            value={selectedId}
            disabled={busy || !agents.length}
            onChange={(event) =>
              setDraft(
                event.target.value === savedId
                  ? null
                  : { id: event.target.value, revision },
              )
            }
          >
            <option value="">Choose an agent</option>
            {agents.map((agent) => (
              <option
                key={agent.id}
                value={agent.id}
                disabled={provisioningProblem(snapshot, agent.id)}
              >
                {agent.profile.name}
                {provisioningProblem(snapshot, agent.id)
                  ? " (setup needs attention)"
                  : ""}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button
          disabled={busy || !draft || !selectedId || stale || !revision}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save choice"}
        </Button>
      </div>
      {!agents.length && (
        <p className="text-sm text-muted-foreground">
          Approve a new agent preset below, then return to setup to create your
          manager.
        </p>
      )}
      {stale && (
        <p role="alert" className="text-sm text-destructive">
          The primary-agent choice changed elsewhere.{" "}
          <button
            type="button"
            className="underline"
            onClick={() => setDraft(null)}
          >
            Reload the saved choice
          </button>{" "}
          before saving.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

// Browser-only projection of the native environment owner's workspace records.
interface WorkspaceView {
  policy: EnvironmentPolicy;
  workspace: { path: string };
  writable: boolean;
  executableDirectories: { path: string }[];
  managedWorktreeRoot: { path: string } | null;
}
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
          {saved.workspaces.map((row) => (
            <div
              key={row.policy.id}
              className="flex flex-wrap items-start justify-between gap-3 border-b pb-5"
            >
              <div className="min-w-0">
                <p className="break-all text-sm">{row.workspace.path}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {row.writable
                    ? "Local reads and writes approved"
                    : "Read-only access approved"}
                </p>
                <details className="mt-2 text-xs text-muted-foreground">
                  <summary className="cursor-pointer">Policy details</summary>
                  <p className="mt-2 break-all">{row.policy.id}</p>
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
          ))}
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

function VoiceSettings({
  command,
  client,
  snapshot,
  visible,
}: {
  command: Command;
  client: PrimaryVoiceClient;
  snapshot: AgentsSnapshot;
  visible: boolean;
}) {
  const primary = snapshot.agents.find(
    (agent) => agent.id === primaryAgentId(snapshot) && !agent.archivedAt,
  );
  const session = primary?.runtime.session;
  const binding: RuntimeBinding | null =
    primary &&
    session?.observedState === "started" &&
    session.sessionId &&
    primary.runtime.threadId
      ? {
          projectId: primary.projectId,
          agentId: primary.id,
          sessionId: session.sessionId,
          threadId: primary.runtime.threadId,
        }
      : null;
  const key = binding ? JSON.stringify(binding) : "";
  const [result, setResult] = useState<{
    key: string;
    catalog: PrimaryVoiceCatalog;
  } | null>(null);
  const [draft, setDraft] = useState<{
    key: string;
    voice: string;
    baseChoice: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [toast, setToast] = useState<{ id: string; message: string } | null>(
    null,
  );
  const sequence = useRef(0),
    alive = useRef(true),
    action = useRef(false);
  const catalog = result?.key === key ? result.catalog : null;
  const selected = catalog?.selectedVoice ?? catalog?.defaultVoice;
  const stale =
    draft !== null &&
    (draft.key !== key ||
      (catalog !== null && draft.baseChoice !== catalog.selectedVoice));
  const supported = catalog?.voices.some((voice) => voice.id === selected);
  const reload = useCallback(async () => {
    const request = ++sequence.current;
    if (!key) return;
    try {
      const next = await client.listVoices(JSON.parse(key) as RuntimeBinding);
      if (!validVoiceCatalog(next)) throw new Error("Invalid voice catalog");
      if (alive.current && request === sequence.current) {
        setResult({ key, catalog: next });
        setError("");
      }
    } catch {
      if (alive.current && request === sequence.current)
        setError(
          "Voices could not be loaded for the current primary-agent session. Retry when it is connected.",
        );
    }
  }, [client, key]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      sequence.current++;
    };
  }, []);
  useEffect(() => {
    sequence.current++;
    if (visible) void reload();
  }, [visible, reload]);
  useEffect(
    () =>
      client.subscribeCatalog?.(() => {
        if (visible) void reload();
      }),
    [client, visible, reload],
  );
  async function save() {
    if (
      !draft ||
      !catalog ||
      stale ||
      !binding ||
      action.current ||
      !catalog.voices.some((voice) => voice.id === draft.voice)
    )
      return;
    const submitted = draft;
    action.current = true;
    setBusy(true);
    setError("");
    try {
      await command("voice.select", { binding, voice: submitted.voice });
      if (alive.current) {
        setDraft((current) => (current === submitted ? null : current));
        setToast({
          id: crypto.randomUUID(),
          message: "Voice saved for your next call.",
        });
      }
      await reload();
    } catch {
      if (alive.current)
        setError(
          "The voice could not be saved. Refresh the available voices and try again.",
        );
    } finally {
      action.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="space-y-5 py-6">
      <div>
        <h2 className="font-semibold tracking-tight">Primary agent voice</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Your saved choice applies to the next call. Changing it does not
          connect voice or start microphone capture.
        </p>
      </div>
      <div className="grid items-start gap-3 border-y py-6 sm:grid-cols-[136px_minmax(0,1fr)_auto] sm:gap-6">
        <h3 className="text-sm font-medium">Voice</h3>
        <div className="min-w-0 space-y-4">
          {draft ? (
            <>
              <Label htmlFor="primary-voice-choice" className="sr-only">
                Primary agent voice
              </Label>
              <NativeSelect
                id="primary-voice-choice"
                value={draft.voice}
                disabled={busy || !catalog || stale}
                onChange={(event) =>
                  setDraft({ ...draft, voice: event.target.value })
                }
              >
                {!catalog?.voices.some((voice) => voice.id === draft.voice) && (
                  <option value={draft.voice} disabled>
                    Saved voice unavailable
                  </option>
                )}
                {catalog?.voices.map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.name}
                  </option>
                ))}
              </NativeSelect>
              <p className="text-xs text-muted-foreground">
                Available voices come from your current native session.
              </p>
              <div className="flex gap-2">
                <Button
                  disabled={
                    busy ||
                    stale ||
                    !catalog?.voices.some((voice) => voice.id === draft.voice)
                  }
                  onClick={() => void save()}
                >
                  {busy ? "Saving…" : "Save"}
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
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {!binding
                ? "Start your primary agent in Sessions to load its available voices."
                : !catalog
                  ? "Loading voices…"
                  : supported
                    ? catalog.voices.find((voice) => voice.id === selected)
                        ?.name
                    : "Your saved voice is unavailable. Choose an available voice."}
            </p>
          )}
          {stale && (
            <p role="alert" className="text-sm text-destructive">
              The session or saved voice changed elsewhere.{" "}
              <button className="underline" onClick={() => setDraft(null)}>
                Reload the saved choice
              </button>{" "}
              before editing.
            </p>
          )}
        </div>
        {!draft && (
          <Button
            variant="link"
            className="h-auto p-0 text-sm font-semibold"
            disabled={!binding || !catalog?.voices.length}
            onClick={() =>
              catalog &&
              setDraft({
                key,
                voice: supported ? selected! : "",
                baseChoice: catalog.selectedVoice,
              })
            }
          >
            Update
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {binding && (
        <Button variant="ghost" disabled={busy} onClick={() => void reload()}>
          Refresh voices
        </Button>
      )}
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

function validVoiceCatalog(value: PrimaryVoiceCatalog): boolean {
  return Boolean(
    value &&
    Array.isArray(value.voices) &&
    value.voices.length <= 1000 &&
    value.voices.every(
      (voice) =>
        voice &&
        typeof voice.id === "string" &&
        voice.id.length > 0 &&
        typeof voice.name === "string",
    ) &&
    typeof value.defaultVoice === "string" &&
    (value.selectedVoice === null || typeof value.selectedVoice === "string"),
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
}: {
  command: Command;
  subscribe: Subscribe;
  visible: boolean;
  openLink?: (url: string) => Promise<unknown>;
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
      if (alive.current && request === sequence.current)
        setStatusError(
          "Subscription status could not be checked. Retry when the native connection is available.",
        );
    }
  }, [command]);
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
            ? "Sign-in did not return a usable code. Check the status or cancel the pending attempt before starting again."
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
          <p className="text-sm">
            Open the official sign-in page and enter this code:
          </p>
          <code className="block select-all text-xl font-semibold tracking-wider">
            {login.userCode}
          </code>
          <div className="flex flex-wrap gap-3">
            <Button
              disabled={!openLink || busy}
              onClick={() => {
                void openLink?.(login.verificationUrl).catch(() =>
                  setError(
                    "The sign-in page could not be opened. Use the official address shown below.",
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
          <p className="break-all text-xs text-muted-foreground">
            {login.verificationUrl}
          </p>
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
    typeof value.loginId !== "string" ||
    !value.loginId ||
    value.loginId.length > 512 ||
    typeof value.userCode !== "string" ||
    !value.userCode ||
    value.userCode.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(value.userCode)
  )
    return false;
  try {
    const url = new URL(value.verificationUrl);
    return url.href === "https://auth.openai.com/codex/device";
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

function provisioningProblem(snapshot: AgentsSnapshot, agentId: string) {
  const rows = (
    snapshot as AgentsSnapshot & {
      provisioning?: { agentId: string; state: string }[];
    }
  ).provisioning;
  const entry = rows?.find((item) => item.agentId === agentId);
  return Boolean(entry && entry.state !== "ready");
}

function PrimarySetup({
  snapshot,
  refresh,
  openSettings,
  command,
  draft: retained,
}: SetupContext & { command: Command; draft: SetupDraft }) {
  const [draft, setDraft] = useState({ ...retained });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false);
  const change = (patch: Partial<SetupDraft>) => {
    Object.assign(retained, patch);
    setDraft((value) => ({ ...value, ...patch }));
  };
  const presets = (snapshot.creationPresets ?? []).filter(
    (preset) => preset.enabled && preset.projectId === snapshot.projectId,
  );
  const preset = presets.find((item) => item.id === draft.presetId);
  const agents = snapshot.agents.filter((agent) => !agent.archivedAt);
  const selected = agents.find((agent) => agent.id === draft.selectedId);
  async function choose(agentId: string) {
    const revision = snapshot.projectSettings?.revision;
    if (!revision) throw new Error("Project settings unavailable");
    await command("setPrimaryAgent", { agentId, expectedRevision: revision });
  }
  async function run(operation: () => Promise<void>, failure: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch {
      setError(failure);
    } finally {
      await refresh().catch(() =>
        setError(
          "Project setup could not be refreshed. Your saved work is retained.",
        ),
      );
      lock.current = false;
      setBusy(false);
    }
  }
  async function create(preset: AgentCreationPreset) {
    const created = await command<Agent>("createAgent", {
      input: {
        presetId: preset.id,
        expectedPresetRevision: preset.revision,
        ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
      },
    });
    if (created.projectId !== snapshot.projectId)
      throw new Error("Project mismatch");
    change({ selectedId: created.id });
    try {
      await choose(created.id);
    } catch {
      throw new Error("Agent created; primary selection needs refresh");
    }
  }
  return (
    <div className="mx-auto max-w-3xl space-y-8 px-5 py-10 sm:px-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Set up your manager
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Choose your primary agent and the access it can use. Agents stay
          stopped until you explicitly Start them.
        </p>
      </div>
      <div className="divide-y border-y">
        <div className="flex flex-wrap items-start justify-between gap-4 py-6">
          <div className="max-w-lg">
            <h2 className="font-medium">Model subscription</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Connect your ChatGPT subscription through Crew's supported
              sign-in.
            </p>
          </div>
          <Button
            variant="link"
            className="h-auto p-0 font-semibold"
            onClick={() => openSettings("subscription")}
          >
            Configure
          </Button>
        </div>
        <div className="flex flex-wrap items-start justify-between gap-4 py-6">
          <div className="max-w-lg">
            <h2 className="font-medium">Connections and approved presets</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Create permission groups and approve the profile and access for
              new agents. Add external connections only when you need them; a
              tracker is optional.
            </p>
          </div>
          <Button
            variant="link"
            className="h-auto p-0 font-semibold"
            onClick={() => openSettings("access")}
          >
            Configure
          </Button>
        </div>
      </div>
      <section className="space-y-5">
        <h2 className="font-semibold tracking-tight">
          Create your primary agent
        </h2>
        {!presets.length ? (
          <p className="text-sm text-muted-foreground">
            Approve a new agent preset in Connections & access first, then
            return here. Crew uses that saved profile and access without manual
            per-worker credential setup.
          </p>
        ) : (
          <>
            <div className="space-y-2">
              <Label htmlFor="setup-agent-preset">Approved preset</Label>
              <NativeSelect
                id="setup-agent-preset"
                value={draft.presetId}
                disabled={busy}
                onChange={(event) => change({ presetId: event.target.value })}
              >
                <option value="">Choose an approved preset</option>
                {presets.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
                {draft.presetId && !preset && (
                  <option value={draft.presetId} disabled>
                    Preset unavailable
                  </option>
                )}
              </NativeSelect>
            </div>
            <div className="space-y-2">
              <Label htmlFor="setup-agent-name">Name (optional)</Label>
              <Input
                id="setup-agent-name"
                value={draft.name}
                maxLength={200}
                placeholder={preset?.profile.name ?? "Use the preset name"}
                onChange={(event) => change({ name: event.target.value })}
              />
            </div>
            <Button
              disabled={busy || !preset}
              onClick={() =>
                preset &&
                void run(
                  () => create(preset),
                  "The manager was not fully configured. Refresh and inspect any retained agent below before creating another; you can retry its setup or select it once ready.",
                )
              }
            >
              {busy ? "Saving…" : "Create and select manager"}
            </Button>
          </>
        )}
      </section>
      {agents.length > 0 && (
        <section className="space-y-4 border-t pt-6">
          <h2 className="font-semibold tracking-tight">
            Use an existing agent
          </h2>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-0 flex-1 space-y-2">
              <Label htmlFor="setup-existing-agent">Agent</Label>
              <NativeSelect
                id="setup-existing-agent"
                value={draft.selectedId}
                disabled={busy}
                onChange={(event) => change({ selectedId: event.target.value })}
              >
                <option value="">Choose an agent</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.profile.name}
                    {provisioningProblem(snapshot, agent.id)
                      ? " (setup needs attention)"
                      : ""}
                  </option>
                ))}
              </NativeSelect>
            </div>
            {selected && provisioningProblem(snapshot, selected.id) ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await command("retryProvisioning", {
                      agentId: selected.id,
                    });
                  }, "Agent access is still incomplete. Check the approved preset and groups in Connections & access.")
                }
              >
                Retry agent setup
              </Button>
            ) : (
              <Button
                variant="outline"
                disabled={busy || !selected}
                onClick={() =>
                  selected &&
                  void run(
                    () => choose(selected.id),
                    "The primary-agent choice changed or could not be saved. Refresh and try again.",
                  )
                }
              >
                Use as manager
              </Button>
            )}
          </div>
        </section>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button
        variant="ghost"
        disabled={busy}
        onClick={() =>
          void refresh().catch(() =>
            setError("Project setup could not be refreshed."),
          )
        }
      >
        Refresh setup
      </Button>
    </div>
  );
}
