import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { AgentsApp } from "./AgentsApp";
import { ProjectBrowser } from "./ProjectBrowser";
import {
  createDesktopClient,
  type DesktopBridge,
  type DesktopSnapshot,
  type DesktopUpdateAction,
} from "./desktop-client";
import type { AgentSettingsPanel, AgentsAppProps } from "./AgentsApp";
import { Actions, Panel } from "../setup/components";
import crewMark from "../../../build/crew-mark.png";
import { ProjectSwitcher } from "../manager/ProjectSwitcher";
import type { WorkspaceSnapshot } from "../contracts/setup";
import type { UnifiedUpdateSnapshot } from "../../../src/desktop/unified-updates.mjs";
import type { PreparationReadiness } from "../../../src/agents/contracts.mjs";
import { WebLink } from "../manager/WebLink";

export interface ProjectPresentation {
  settingsPanels?: AgentSettingsPanel[];
  renderSetup?: AgentsAppProps["renderSetup"];
  renderVoice?: AgentsAppProps["renderVoice"];
}

/** The native host chooses the project and authenticates owner requests. This
 * surface owns no agent authority and never starts a session while opening. */
export function DesktopApplication({
  bridge,
  presentation,
}: {
  bridge: DesktopBridge;
  presentation?: (
    projectId: string,
    command: <T>(name: string, args: unknown) => Promise<T>,
  ) => ProjectPresentation;
}) {
  const [snapshot, setSnapshot] = useState<DesktopSnapshot | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [navigation, setNavigation] =
    useState<AgentsAppProps["navigationRequest"]>();
  const refresh = useCallback(async () => {
    setSnapshot((await bridge.request("snapshot")) as DesktopSnapshot);
  }, [bridge]);
  useEffect(() => {
    let live = true;
    void bridge
      .request("snapshot")
      .then((value) => {
        if (live) setSnapshot(value as DesktopSnapshot);
      })
      .catch(() => {
        if (live) setError("Crew could not open its project list.");
      });
    const unsubscribe = bridge.subscribe((value) => {
      const event = value as {
        type?: string;
        snapshot?: DesktopSnapshot;
        view?: string;
      };
      if (event?.type === "application" && event.snapshot)
        setSnapshot(event.snapshot);
      if (
        event?.type === "navigate" &&
        (event.view === "prepare" || event.view === "updates")
      ) {
        setAdding(false);
        setNavigation({ id: crypto.randomUUID(), view: event.view });
      }
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [bridge]);
  const projectId = snapshot?.selectedId ?? null;
  const transport = useMemo(
    () => (projectId ? createDesktopClient(bridge, projectId) : null),
    [bridge, projectId],
  );
  const panels = useMemo(
    () =>
      projectId && transport
        ? presentation?.(projectId, transport.command)
        : undefined,
    [presentation, projectId, transport],
  );
  const updateCommand = useCallback(
    async (action: DesktopUpdateAction) => {
      const updates = (await bridge.request("updates", {
        action,
      })) as UnifiedUpdateSnapshot;
      setSnapshot((current) => (current ? { ...current, updates } : current));
      return updates;
    },
    [bridge],
  );
  const projectSwitcher = useMemo(() => {
    const projectView = (value: DesktopSnapshot): WorkspaceSnapshot => ({
      ...(value.selectedId ? { selectedId: value.selectedId } : {}),
      projects: value.projects.map((project) => ({
        id: project.id,
        name: project.name,
        ...(project.error ? { error: project.error } : {}),
      })),
    });
    return {
      snapshot: async () =>
        projectView((await bridge.request("snapshot")) as DesktopSnapshot),
      subscribe: (listener: (value: WorkspaceSnapshot) => void) =>
        bridge.subscribe((value) => {
          const event = value as { type?: string; snapshot?: DesktopSnapshot };
          if (event?.type === "application" && event.snapshot)
            listener(projectView(event.snapshot));
        }),
      select: (projectId: string) =>
        bridge.request("selectProject", { projectId }),
      add: async () => setAdding(true),
    };
  }, [bridge]);
  async function act(method: string, value?: unknown) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await bridge.request(method, value);
      await refresh();
    } catch {
      setError(
        "Crew could not complete this action. Your saved work is retained.",
      );
    } finally {
      setPending(false);
    }
  }
  const selected = snapshot?.projects.find(
    (project) => project.id === projectId,
  );
  const header = (
    <ProjectSwitcher bridge={projectSwitcher} fallbackName={selected?.name} />
  );
  const headerUpdates = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label="Crew updates"
      onClick={() =>
        setNavigation({ id: crypto.randomUUID(), view: "updates" })
      }
    >
      <ArrowDownToLine aria-hidden="true" />
      <span className="hidden sm:inline">Updates</span>
      {snapshot?.updates &&
        ["available", "downloading", "downloaded"].includes(
          snapshot.updates.phase,
        ) && (
          <span
            className="size-1.5 rounded-full bg-primary"
            aria-label="Update available"
          />
        )}
    </Button>
  );
  const preparation = (
    <div className="mt-5 space-y-3 border-t pt-5">
      <h3 className="text-base font-semibold">Quit Crew across all projects</h3>
      <p className="text-sm text-muted-foreground">
        Closing the window keeps agents running. Quit prepares every open
        project and checks for work before stopping Crew.
      </p>
      {snapshot?.quit.detail && (
        <p
          role={snapshot.quit.recoveryRequired ? "alert" : "status"}
          className={`text-sm ${snapshot.quit.recoveryRequired ? "text-destructive" : ""}`}
        >
          {snapshot.quit.detail}
        </p>
      )}
      <ProjectReadiness projects={snapshot?.quit.projects ?? []} />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={pending || snapshot?.quit.recoveryRequired}
          onClick={() => void act("prepareQuit")}
        >
          Prepare all projects
        </Button>
        <Button
          variant="outline"
          type="button"
          disabled={pending || snapshot?.quit.recoveryRequired}
          onClick={() => void act("cancelQuit")}
        >
          Return to work
        </Button>
        <Button
          variant="outline"
          type="button"
          disabled={
            pending ||
            (!snapshot?.quit.recoveryRequired &&
              snapshot?.quit.state !== "ready") ||
            snapshot.updates?.holding
          }
          onClick={() => void act("quit")}
        >
          {snapshot?.quit.recoveryRequired ? "Retry Quit" : "Quit Crew"}
        </Button>
      </div>
    </div>
  );
  if (!snapshot)
    return (
      <div className="mx-auto max-w-lg space-y-4 p-10">
        <h1 className="text-xl font-semibold">Opening Crew</h1>
        {error && <p role="alert">{error}</p>}
        <Button variant="outline" onClick={() => void refresh()}>
          Retry
        </Button>
      </div>
    );
  if (adding || !projectId || !transport)
    return (
      <ProjectChooser
        bridge={bridge}
        canCancel={Boolean(projectId)}
        onCancel={() => setAdding(false)}
        onCreated={async () => {
          await refresh();
          setAdding(false);
        }}
      />
    );
  return (
    <>
      {error && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/5 px-5 py-3 text-sm text-destructive"
        >
          {error}
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => setError("")}
            aria-label="Dismiss error"
          >
            <X />
          </Button>
        </div>
      )}
      {selected?.error ? (
        <div className="mx-auto max-w-xl space-y-5 p-8">
          <h1 className="text-xl font-semibold">
            {selected.name} needs attention
          </h1>
          <p role="alert">{selected.error}</p>
          {header}
          <Button onClick={() => void act("selectProject", { projectId })}>
            Retry project
          </Button>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => void act("recoverProject", { projectId })}
          >
            Recover interrupted project
          </Button>
          <p className="text-sm text-muted-foreground">
            Recovery checks that this project is no longer in use, then retries
            opening it. Your sign-in, agents and chat history are kept.
          </p>
          {preparation}
        </div>
      ) : (
        <AgentsApp
          key={projectId}
          client={transport.client}
          renderBrowser={(context) => <ProjectBrowser {...context} />}
          nativeWindow={bridge.integratedTitlebar}
          headerActions={header}
          headerUpdates={headerUpdates}
          navigationRequest={navigation}
          settingsPanels={[
            ...(panels?.settingsPanels ?? []),
            {
              id: "crew-updates",
              label: "Updates",
              icon: ArrowDownToLine,
              description:
                "Signed Crew releases and update readiness across every project on this Mac.",
              render: ({ visible }) => (
                <DesktopUpdates
                  status={snapshot.updates}
                  visible={visible}
                  command={updateCommand}
                />
              ),
            },
          ]}
          renderSetup={panels?.renderSetup}
          renderVoice={panels?.renderVoice}
          renderPreparationActions={() => preparation}
        />
      )}
    </>
  );
}

function DesktopUpdates({
  status,
  visible,
  command,
}: {
  status: UnifiedUpdateSnapshot | null;
  visible: boolean;
  command(action: DesktopUpdateAction): Promise<UnifiedUpdateSnapshot>;
}) {
  const [pending, setPending] = useState<DesktopUpdateAction | null>(null);
  const [error, setError] = useState("");
  const locked = useRef(false);
  const request = useCallback(
    async (action: DesktopUpdateAction) => {
      if (locked.current) return;
      locked.current = true;
      setPending(action);
      setError("");
      try {
        await command(action);
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message.slice(0, 600)
            : "Crew could not complete the update request. Refresh status and retry.",
        );
      } finally {
        locked.current = false;
        setPending(null);
      }
    },
    [command],
  );
  useEffect(() => {
    if (visible) void request("status");
  }, [visible, request]);
  const phase = status?.phase ?? "unavailable";
  const preparing = status?.preparation;
  const working =
    Boolean(pending) ||
    ["checking", "downloading", "installing"].includes(phase);
  const downloaded = phase === "downloaded";
  const canPrepare =
    status?.supported &&
    downloaded &&
    !working &&
    !status.holding &&
    !status.recoveryRequired &&
    preparing?.state !== "preparing";
  const canInstall =
    status?.supported &&
    downloaded &&
    !working &&
    !status.installBlocked &&
    !status.holding &&
    !status.recoveryRequired &&
    preparing?.state === "ready";
  const canCancel =
    preparing &&
    preparing.state !== "idle" &&
    !working &&
    !status?.recoveryRequired &&
    !["reserving", "closing"].includes(preparing.state);
  const messages: Record<string, string> = {
    idle: "Check for a newer Crew release.",
    checking: "Checking GitHub Releases…",
    current: "Crew is up to date.",
    available: `Crew ${status?.availableVersion} is available.`,
    downloading: `Downloading${status?.downloadPercent == null ? "…" : ` ${Math.round(status.downloadPercent)}%…`}`,
    downloaded: `Crew ${status?.availableVersion} is downloaded. Prepare every project before installing.`,
    installing: "Restarting Crew to install the update…",
    error: "The update could not be verified or retrieved.",
    unavailable: "Update status is unavailable. Refresh to retry.",
  };
  return (
    <div className="space-y-6">
      <section className="space-y-4" aria-label="Crew update status">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-base font-semibold">Crew updates</h3>
          {status?.currentVersion && (
            <Badge variant="secondary">{status.currentVersion}</Badge>
          )}
        </div>
        <p role="status" aria-live="polite" className="text-sm leading-6">
          {messages[phase] ?? "Update status is unavailable."}
        </p>
        {(error || status?.error) && (
          <p role="alert" className="break-words text-sm text-destructive">
            {error || status?.error}
          </p>
        )}
        {phase === "downloading" && status?.downloadPercent != null && (
          <progress
            aria-label="Update download"
            value={status.downloadPercent}
            max={100}
            className="h-2 w-full accent-primary"
          />
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={working || !status?.supported}
            onClick={() => void request("check")}
          >
            {pending === "check" ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <RefreshCw />
            )}
            Check for updates
          </Button>
          {phase === "available" && (
            <Button
              type="button"
              size="sm"
              disabled={working || !status?.supported}
              onClick={() => void request("download")}
            >
              <Download />
              Download update
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={Boolean(pending) || phase === "installing"}
            onClick={() => void request("status")}
          >
            Refresh status
          </Button>
        </div>
      </section>
      {(downloaded || (preparing && preparing.state !== "idle")) && (
        <section
          className="space-y-4 border-t pt-6"
          aria-label="Update preparation"
        >
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-base font-semibold">Prepare every project</h3>
            {preparing && (
              <Badge variant="outline" className="capitalize">
                {preparing.state}
              </Badge>
            )}
          </div>
          <p className="text-sm leading-6 text-muted-foreground">
            Agents save continuation notes and report readiness. Installation
            checks current execution and reserves every project again before
            stopping any session.
          </p>
          {preparing?.detail && (
            <p
              role={status?.recoveryRequired ? "alert" : "status"}
              className={`text-sm leading-6 ${status?.recoveryRequired ? "text-destructive" : ""}`}
            >
              {preparing.detail}
            </p>
          )}
          {status?.installBlocked && status.reasons.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {status.reasons.map((reason, index) => (
                <li key={index}>{reason}</li>
              ))}
            </ul>
          )}
          <ProjectReadiness projects={preparing?.projects ?? []} />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canPrepare}
              onClick={() => void request("prepare")}
            >
              {pending === "prepare" && (
                <LoaderCircle className="animate-spin" />
              )}
              Prepare all projects
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!canInstall}
              onClick={() => void request("install")}
            >
              <Check />
              Install and restart
            </Button>
            {preparing?.state !== "idle" && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!canCancel}
                onClick={() => void request("cancel")}
              >
                Cancel preparation
              </Button>
            )}
          </div>
          {status?.notices.map((notice, index) => (
            <p key={index} className="text-xs leading-5 text-muted-foreground">
              {notice}
            </p>
          ))}
        </section>
      )}
      <div className="space-y-3 border-t pt-5 text-xs leading-5 text-muted-foreground">
        <p>
          Downloading does not restart Crew. Install and restart is a separate
          action; your local settings and work history stay on this Mac.
        </p>
        <WebLink
          href={
            status?.releaseUrl ??
            "https://github.com/MattGibney/crew/releases/latest"
          }
        >
          View releases on GitHub
        </WebLink>
      </div>
    </div>
  );
}

function ProjectReadiness({
  projects,
}: {
  projects: {
    projectId: string;
    name: string;
    readiness: PreparationReadiness[];
    error: string | null;
    closeState?: string;
  }[];
}) {
  if (!projects.length) return null;
  return (
    <div className="space-y-3" aria-label="Project readiness">
      {projects.map((project) => (
        <section
          key={project.projectId}
          className="space-y-3 rounded-xl border p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-semibold">{project.name}</h4>
            {project.closeState && project.closeState !== "open" && (
              <Badge variant="outline">
                {project.closeState === "closed"
                  ? "Shutdown confirmed"
                  : project.closeState === "closing"
                    ? "Closing"
                    : "Shutdown unconfirmed"}
              </Badge>
            )}
          </div>
          {project.error && (
            <p role="alert" className="text-sm text-destructive">
              {project.error}
            </p>
          )}
          {!project.error && !project.readiness.length && (
            <p className="text-xs text-muted-foreground">
              No agent readiness records reported.
            </p>
          )}
          <ul className="divide-y">
            {project.readiness.map((agent) => (
              <li
                key={`${agent.agentId}:${agent.sessionId}`}
                className="space-y-2 py-3 first:pt-0 last:pb-0"
              >
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <span className="min-w-0 break-all text-xs">
                    Agent {agent.agentId}
                  </span>
                  <Badge variant="outline" className="shrink-0 capitalize">
                    {agent.state}
                  </Badge>
                </div>
                {agent.detail && (
                  <p className="text-sm leading-5 text-muted-foreground">
                    {agent.detail}
                  </p>
                )}
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer">
                    Preparation details
                  </summary>
                  <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                    <dt>Session</dt>
                    <dd className="break-all">{agent.sessionId}</dd>
                    <dt>Continuation saved</dt>
                    <dd className="break-all">
                      {agent.continuationSavedAt ?? "Not reported"}
                    </dd>
                    {"preparationId" in agent && (
                      <>
                        <dt>Request</dt>
                        <dd className="break-all">
                          {String(agent.preparationId)}
                        </dd>
                      </>
                    )}
                  </dl>
                </details>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function ProjectChooser({
  bridge,
  canCancel,
  onCancel,
  onCreated,
}: {
  bridge: DesktopBridge;
  canCancel: boolean;
  onCancel(): void;
  onCreated(): Promise<void>;
}) {
  const [name, setName] = useState("");
  const [directory, setDirectory] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function choose() {
    setError("");
    try {
      const result = (await bridge.request("chooseProjectDirectory")) as {
        directory: string;
        suggestedName: string;
      } | null;
      if (result) {
        setDirectory(result.directory);
        setName((current) => current || result.suggestedName);
      }
    } catch {
      setError("The project folder could not be selected.");
    }
  }
  return (
    <main className="min-h-dvh bg-muted/20 text-foreground">
      <div className="mx-auto max-w-6xl space-y-7 px-5 py-10 sm:px-8">
        <header className="flex items-center gap-4 border-b pb-6">
          <img
            src={crewMark}
            alt="Crew"
            width="44"
            height="44"
            className="size-11 shrink-0"
          />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Set up Crew
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Connect your project. Crew handles the local setup.
            </p>
          </div>
        </header>
        <form
          className="mx-auto w-full max-w-3xl"
          onSubmit={(event) => {
            event.preventDefault();
            if (pending) return;
            setPending(true);
            setError("");
            void bridge
              .request("createProject", { name, directory })
              .then(onCreated)
              .catch(() =>
                setError(
                  "The project could not be added. Check the folder and name; existing projects are retained.",
                ),
              )
              .finally(() => setPending(false));
          }}
        >
          <Panel
            title={canCancel ? "Add a project" : "Start with your project"}
            description="Choose where your project lives. Next, configure your primary agent, subscription access and the connections it can use."
          >
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="project-name">
                Project name
              </label>
              <Input
                id="project-name"
                value={name}
                maxLength={100}
                onChange={(event) => setName(event.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="project-folder">
                Project folder
              </label>
              <div className="flex gap-2">
                <Input
                  id="project-folder"
                  value={directory}
                  readOnly
                  placeholder="Choose a folder"
                  required
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void choose()}
                >
                  Choose
                </Button>
              </div>
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Actions>
              <Button
                type="submit"
                disabled={pending || !name.trim() || !directory}
              >
                {pending ? "Adding project…" : "Continue"}
              </Button>
              {canCancel && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={onCancel}
                >
                  Cancel
                </Button>
              )}
            </Actions>
            <p className="text-xs text-muted-foreground">
              Setup does not start agents, project commands or your microphone.
            </p>
          </Panel>
        </form>
      </div>
    </main>
  );
}
