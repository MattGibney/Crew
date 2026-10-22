import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowLeft, ArrowRight, Check, Plus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import { Choice } from "../access/shared";
import { AgentPicture, type AgentImageClient } from "./AgentPicture";
import { AgentManagerSelection } from "./AgentManagerSelection";
import { readProfilePicture } from "../manager/profile";
import type { AgentConfigurationOptions } from "../../../src/application/agent-configuration-contracts.mjs";
import type { AccessOwnerView } from "../../../src/access/owner-contracts.mjs";
import type {
  CrewAction,
  CrewPermission,
} from "../../../src/agents/contracts.mjs";
import type {
  AgentSetupDraft,
  AgentSetupRecord,
  AgentSetupReview,
} from "../../../src/desktop/agent-setup-contracts.mjs";
import type { AgentsSnapshot } from "./client";

type Command = <T>(name: string, args: unknown) => Promise<T>;
type Subscribe = (listener: (event: unknown) => void) => () => void;
export interface ConnectionWizardContext {
  snapshot: AccessOwnerView;
  onCommand(name: string, args: unknown): Promise<unknown>;
  onNotify(message: string): void;
  onComplete(connectionId: string): void;
  onCancel(): void;
  onSkip(): void;
}
interface Props {
  snapshot: AgentsSnapshot;
  command: Command;
  subscribe: Subscribe;
  refresh(): Promise<void>;
  visible: boolean;
  firstUse?: boolean;
  renderSignIn(
    visible: boolean,
    onStatus: (signedIn: boolean) => void,
  ): ReactNode;
  renderConnectionWizard?: (context: ConnectionWizardContext) => ReactNode;
}
const steps = [
  "Sign in",
  "Project folder",
  "Agent",
  "Access",
  "Connections",
  "Review",
];
const folderLabels = {
  none: "No folder access",
  read_only: "Read only",
  read_write: "Read and write",
} as const;
const bundles: { label: string; description: string; actions: CrewAction[] }[] =
  [
    {
      label: "Remember and organize work",
      description:
        "Read project history and skills, keep notes, manage jobs and ask for help.",
      actions: [
        "history.read",
        "scratchpad.read",
        "scratchpad.write",
        "jobs.read",
        "jobs.create",
        "jobs.update",
        "skills.read",
        "help.request",
      ],
    },
    {
      label: "Coordinate the team",
      description:
        "Create agents from approved defaults, manage their sessions, send messages, assign work and respond to questions.",
      actions: [
        "agents.read",
        "agents.create",
        "agents.update",
        "sessions.start",
        "sessions.stop",
        "sessions.restart",
        "messages.send",
        "jobs.assign",
        "help.respond",
      ],
    },
  ];
const permissionLabels: Partial<Record<CrewAction, string>> = {
  "agents.read": "View agents",
  "agents.create": "Create approved agents",
  "agents.update": "Update agents",
  "agents.archive": "Archive agents",
  "sessions.start": "Start agent sessions",
  "sessions.stop": "Stop agent sessions",
  "sessions.restart": "Restart agent sessions",
  "messages.send": "Send messages",
  "history.read": "Read conversation history",
  "help.request": "Ask for help",
  "help.respond": "Respond to questions",
  "jobs.read": "View jobs",
  "jobs.create": "Create jobs",
  "jobs.assign": "Assign jobs",
  "jobs.update": "Update jobs",
  "scratchpad.read": "Read notes",
  "scratchpad.write": "Write notes",
  "skills.read": "Read skills",
  "skills.write": "Edit skills",
  "skills.assign": "Assign skills",
  "environments.read": "View approved folders",
  "environments.create": "Create approved workspaces",
  "environments.attach": "Open approved folders",
  "environments.execute": "Run commands in approved folders",
  "environments.dispose": "Dispose owned workspaces",
  "groups.read": "View access groups",
  "connections.read": "View service connections",
  "grants.review": "Review access requests",
};
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const toggle = (values: string[], value: string, checked: boolean) =>
  checked
    ? [...new Set([...values, value])]
    : values.filter((entry) => entry !== value);

/** Durable non-secret intent; the host validates and applies one reviewed setup. */
export function AgentSetupWizard(props: Props) {
  const {
    command,
    subscribe,
    snapshot,
    visible,
    firstUse = false,
    refresh,
  } = props;
  const id = useId();
  const [record, setRecord] = useState<AgentSetupRecord | null>(null);
  const [draft, setDraft] = useState<AgentSetupDraft | null>(null);
  const [access, setAccess] = useState<AccessOwnerView | null>(null);
  const [directory, setDirectory] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [options, setOptions] = useState<AgentConfigurationOptions | null>(
    null,
  );
  const [optionsError, setOptionsError] = useState("");
  const imageClient = useMemo<AgentImageClient>(
    () => ({
      readImage: (imageRef) => command("images.read", { imageRef }),
      saveImage: (picture) => command("images.save", { picture }),
    }),
    [command],
  );
  const optionsSequence = useRef(0);
  const reloadOptions = useCallback(async () => {
    const request = ++optionsSequence.current;
    try {
      const next = await command<AgentConfigurationOptions>(
        "agents.options",
        {},
      );
      if (!next?.runtime || !next.voices || !Array.isArray(next.voices.values))
        throw new Error();
      if (alive.current && request === optionsSequence.current) {
        setOptions(next);
        setOptionsError("");
      }
    } catch {
      if (alive.current && request === optionsSequence.current)
        setOptionsError(
          "Voice choices could not be refreshed. Saved choices are retained.",
        );
    }
  }, [command]);
  const current = useRef<AgentSetupRecord | null>(null);
  const local = useRef<AgentSetupDraft | null>(null);
  const alive = useRef(true),
    action = useRef(false);
  const readSequence = useRef(0),
    accessSequence = useRef(0);
  const pendingSave = useRef<Promise<AgentSetupRecord> | null>(null);
  const accept = useCallback(
    (next: AgentSetupRecord | null, replaceDraft = true) => {
      current.current = next;
      if (alive.current) {
        setRecord(next);
        if (next?.error) setError(next.error);
      }
      if (replaceDraft) {
        local.current = next?.draft ?? null;
        if (alive.current) setDraft(next?.draft ?? null);
      }
    },
    [],
  );
  const reloadAccess = useCallback(async () => {
    const request = ++accessSequence.current;
    const [next, folder] = await Promise.all([
      command<AccessOwnerView>("access.snapshot", {}),
      command<{ directory: string }>("environments.projectFolder", {}),
    ]);
    if (next.projectId !== snapshot.projectId || !folder.directory)
      throw new Error("Project access unavailable.");
    if (alive.current && request === accessSequence.current) {
      setAccess(next);
      setDirectory(folder.directory);
    }
  }, [command, snapshot.projectId]);
  const reload = useCallback(async () => {
    const request = ++readSequence.current;
    const [next] = await Promise.all([
      command<AgentSetupRecord | null>("setup.read", {}),
      reloadAccess(),
    ]);
    if (!alive.current || request !== readSequence.current) return;
    const dirty = local.current && !same(local.current, current.current?.draft);
    if (dirty && next?.revision !== current.current?.revision) {
      setConflict(true);
      setError(
        "Setup changed in another window. Your typed choices are retained. Reload the saved setup before continuing.",
      );
    } else accept(next, !dirty);
    setLoaded(true);
  }, [command, reloadAccess, accept]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      readSequence.current++;
      accessSequence.current++;
    };
  }, []);
  useEffect(() => {
    if (visible) void reloadOptions();
  }, [visible, reloadOptions]);
  useEffect(() => {
    if (visible && !action.current)
      void reload().catch(() =>
        setError(
          "Setup could not be loaded. Retry to reconnect to the saved draft.",
        ),
      );
  }, [visible, reload]);
  useEffect(
    () =>
      subscribe(() => {
        if (visible && !action.current)
          void reloadAccess().catch(() =>
            setError(
              "Access could not be refreshed. Your setup draft is retained.",
            ),
          );
      }),
    [subscribe, visible, reloadAccess],
  );

  const change = (patch: Partial<AgentSetupDraft>) => {
    if (!local.current || current.current?.phase === "applying") return;
    const next = { ...local.current, ...patch };
    local.current = next;
    setDraft(next);
    setNotice("");
  };
  const save = useCallback(async (): Promise<AgentSetupRecord> => {
    if (pendingSave.current) await pendingSave.current;
    if (!local.current || !current.current)
      throw new Error("Open a setup draft first.");
    if (same(local.current, current.current.draft)) return current.current;
    const submitted = local.current;
    const previous = current.current;
    readSequence.current++;
    setSaving(true);
    const promise = command<AgentSetupRecord>("setup.save", {
      expectedRevision: previous.revision,
      draft: submitted,
    });
    pendingSave.current = promise;
    try {
      const next = await promise;
      accept(next, local.current === submitted);
      return next;
    } catch {
      // Read-only reconciliation handles a saved response lost in transport.
      const latest = await command<AgentSetupRecord | null>(
        "setup.read",
        {},
      ).catch(() => null);
      if (latest?.id === previous.id && same(latest.draft, submitted)) {
        accept(latest, local.current === submitted);
        return latest;
      }
      if (latest && latest.revision !== previous.revision) setConflict(true);
      throw new Error(
        "Your latest choices could not be saved. They remain on screen. Reload saved setup to resolve a revision conflict, or retry saving.",
      );
    } finally {
      pendingSave.current = null;
      if (alive.current) setSaving(false);
    }
  }, [command, accept]);
  useEffect(() => {
    if (
      !draft ||
      !record ||
      same(draft, record.draft) ||
      busy ||
      conflict ||
      record.phase === "applying" ||
      record.phase === "complete"
    )
      return;
    const timer = setTimeout(
      () => void save().catch((cause: unknown) => setError(message(cause))),
      600,
    );
    return () => clearTimeout(timer);
  }, [draft, record, busy, conflict, save]);

  async function run(operation: () => Promise<void>) {
    if (action.current) return;
    action.current = true;
    readSequence.current++;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (cause) {
      if (alive.current) setError(message(cause));
    } finally {
      action.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function begin(mode: "create" | "repair", agentId?: string, discard = false) {
    void run(async () => {
      if (
        local.current &&
        current.current &&
        !same(local.current, current.current.draft)
      )
        await save();
      const next = await command<AgentSetupRecord>(
        discard ? "setup.new" : "setup.open",
        {
          expectedRevision: current.current?.revision ?? null,
          mode,
          ...(agentId ? { agentId } : {}),
        },
      );
      accept(next);
      setPaused(false);
      setConflict(false);
      setNotice("");
    });
  }
  function go(step: number) {
    void run(async () => {
      change({ step });
      const saved = await save();
      if (step === 5) {
        const reviewed = await command<AgentSetupRecord>("setup.review", {
          expectedRevision: saved.revision,
        });
        accept(reviewed);
        await reloadAccess();
      }
    });
  }
  function complete() {
    void run(async () => {
      const result = await command<AgentSetupRecord>("setup.complete", {
        expectedRevision: current.current?.revision,
      });
      accept(result);
      if (result.error) setError(result.error);
      if (result.phase === "complete") {
        setNotice(
          result.result?.mode === "repair"
            ? "Agent saved. Access applies to the next tool call; restart its session to apply changed instructions. Your conversation is retained."
            : "Agent created and ready to start when you choose.",
        );
        await refresh().catch(() =>
          setError(
            "Setup completed. Refresh the project to see the saved agent.",
          ),
        );
      }
    });
  }
  const agents = snapshot.agents.filter((agent) => !agent.archivedAt);
  const active = record && record.phase !== "complete" && draft && !paused;
  const locked = busy || conflict || record?.phase === "applying";
  const dirty = !same(draft, record?.draft);
  const review = !dirty ? record?.review : null;
  return (
    <div
      className={`${firstUse ? "mx-auto max-w-3xl px-5 py-8 sm:px-8" : "py-6"} min-w-0 space-y-6`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {firstUse
              ? "Set up your manager"
              : active
                ? draft.mode === "repair"
                  ? "Edit agent"
                  : "Create an agent"
                : "Your agents"}
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
            {active && draft.mode === "repair"
              ? `Configure ${draft.name}, its skills and the access it can use.`
              : "Choose how your agent can help, the files it can use and any services it needs."}
          </p>
        </div>
        {active && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || saving || record.phase === "applying"}
            onClick={() =>
              void run(async () => {
                await save();
                setPaused(true);
              })
            }
          >
            Save and close
          </Button>
        )}
      </div>
      {notice && (
        <p role="status" className="rounded-lg border bg-muted/40 p-3 text-sm">
          {notice}
        </p>
      )}
      {error && (
        <div
          role="alert"
          className="space-y-2 rounded-lg border border-destructive/30 p-3 text-sm text-destructive"
        >
          <p>{error}</p>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || saving}
            onClick={() =>
              void run(async () => {
                if (!conflict) {
                  await reload();
                  return;
                }
                const next = await command<AgentSetupRecord | null>(
                  "setup.read",
                  {},
                );
                accept(next);
                setLoaded(true);
                setConflict(false);
                await reloadAccess();
              })
            }
          >
            {conflict
              ? "Discard typed choices and reload"
              : "Refresh saved progress"}
          </Button>
          {dirty && !conflict && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await save();
                })
              }
            >
              Retry saving choices
            </Button>
          )}
          {draft?.mode === "repair" &&
            draft.agentId &&
            record?.phase !== "applying" && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => begin("repair", draft.agentId!, true)}
              >
                Discard this draft and reload agent
              </Button>
            )}
        </div>
      )}
      {!loaded ? (
        <p className="text-sm text-muted-foreground">Loading saved setup…</p>
      ) : !active ? (
        <div className="space-y-6">
          {record && record.phase !== "complete" ? (
            <div className="space-y-3 rounded-lg border p-4">
              <p className="font-medium">
                Continue setting up {record.draft.name || "your agent"}
              </p>
              <p className="text-sm text-muted-foreground">
                Your progress is saved. Resume at{" "}
                {steps[record.draft.step]?.toLowerCase() ?? "review"}.
              </p>
              <Button onClick={() => setPaused(false)}>Resume setup</Button>
            </div>
          ) : null}
          {(!firstUse || !record || record.phase === "complete") && (
            <Button
              disabled={busy || record?.phase === "applying"}
              onClick={() => begin("create")}
            >
              <Plus />
              {firstUse ? "Get started" : "Create agent"}
            </Button>
          )}
          {!firstUse && (
            <AgentManagerSelection
              snapshot={snapshot}
              command={command}
              refresh={refresh}
              onNotify={setNotice}
            />
          )}
          {!firstUse && (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">
                  Project agents and their saved configuration
                </caption>
                <thead className="border-b bg-muted/30 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">Agent</th>
                    <th className="px-4 py-3 font-medium">Role</th>
                    <th className="px-4 py-3 font-medium">Session</th>
                    <th className="px-4 py-3 font-medium">Voice</th>
                    <th className="px-4 py-3 font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {agents.map((agent) => (
                    <tr key={agent.id}>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <AgentPicture
                            client={imageClient}
                            imageRef={agent.profile.pictureRef}
                            className="size-9"
                          />
                          <span className="font-medium">
                            {agent.profile.name}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {agent.id ===
                        (snapshot.projectSettings?.primaryAgentId ??
                          snapshot.primaryAgentId)
                          ? "Manager"
                          : "Agent"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {agent.runtime.session.observedState}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {agent.profile.voice ?? "Native default"}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy || record?.phase === "applying"}
                          onClick={() => begin("repair", agent.id)}
                        >
                          Edit {agent.profile.name}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!agents.length && (
                <p className="px-4 py-8 text-sm text-muted-foreground">
                  Create your first agent to choose a manager.
                </p>
              )}
            </div>
          )}
        </div>
      ) : (
        <>
          <ol
            aria-label="Setup progress"
            className="flex flex-wrap gap-x-4 gap-y-2 border-b pb-4 text-xs"
          >
            {steps.map((label, index) => (
              <li key={label}>
                <button
                  type="button"
                  disabled={locked || connecting}
                  aria-current={draft.step === index ? "step" : undefined}
                  onClick={() => go(index)}
                  className={`flex items-center gap-1.5 py-1 ${draft.step === index ? "font-semibold text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                  <span
                    className={`flex size-5 items-center justify-center rounded-full ${draft.step === index ? "bg-primary text-primary-foreground" : "bg-muted"}`}
                  >
                    {index < draft.step && (index !== 0 || signedIn) ? (
                      <Check className="size-3" />
                    ) : (
                      index + 1
                    )}
                  </span>
                  {label}
                </button>
              </li>
            ))}
          </ol>
          <div hidden={draft.step !== 0}>
            {props.renderSignIn(visible, setSignedIn)}
          </div>
          {draft.step === 1 && (
            <section className="space-y-5">
              <StepTitle title="Project folder">
                Choose what your agent may do in this project’s folder.
              </StepTitle>
              <p className="break-all rounded-lg border bg-muted/30 px-4 py-3 text-sm">
                {directory || "Loading folder…"}
              </p>
              <fieldset disabled={locked} className="space-y-3">
                <legend className="sr-only">Folder access</legend>
                {(["none", "read_only", "read_write"] as const).map((value) => (
                  <label
                    key={value}
                    className={`flex cursor-pointer items-start gap-3 rounded-lg border p-4 ${draft.folderAccess === value ? "border-primary bg-primary/5" : ""}`}
                  >
                    <input
                      className="mt-1 accent-primary"
                      type="radio"
                      name={`${id}-folder`}
                      checked={draft.folderAccess === value}
                      onChange={() => change({ folderAccess: value })}
                    />
                    <span>
                      <span className="block text-sm font-medium">
                        {folderLabels[value]}
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                        {value === "none"
                          ? "Work in Crew without opening project files."
                          : value === "read_only"
                            ? "Inspect and explain files. Project files cannot be changed."
                            : "Read, create and edit files within this folder."}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <p className="text-xs leading-5 text-muted-foreground">
                Access applies to this exact folder. Existing shared groups are
                included in the final review.
              </p>
            </section>
          )}
          {draft.step === 2 && (
            <section className="space-y-5">
              <StepTitle
                title={draft.mode === "repair" ? draft.name : "Meet your agent"}
              >
                Give your agent a name, choose its voice and tell it how you
                want to work together.
              </StepTitle>
              <div className="space-y-2">
                <Label htmlFor={`${id}-name`}>Name</Label>
                <Input
                  id={`${id}-name`}
                  value={draft.name}
                  maxLength={200}
                  disabled={locked}
                  onChange={(event) => change({ name: event.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${id}-picture`}>Picture</Label>
                <div className="flex flex-wrap items-center gap-3">
                  <AgentPicture
                    client={imageClient}
                    imageRef={draft.pictureRef}
                    className="size-12"
                  />
                  <Input
                    id={`${id}-picture`}
                    className="max-w-xs text-xs"
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    disabled={locked}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (!file) return;
                      const targetId = current.current?.id;
                      void run(async () => {
                        const picture = await readProfilePicture(file);
                        const result = await command<{ imageRef: string }>(
                          "images.save",
                          { picture },
                        );
                        if (current.current?.id === targetId)
                          change({ pictureRef: result.imageRef });
                      });
                    }}
                  />
                  {draft.pictureRef && (
                    <Button
                      variant="link"
                      size="sm"
                      disabled={locked}
                      onClick={() => change({ pictureRef: null })}
                    >
                      Remove picture
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  PNG, JPEG or WebP, up to 512 KB and 2048 × 2048 pixels. Stored
                  privately in this project.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${id}-personality`}>Personality</Label>
                <Textarea
                  id={`${id}-personality`}
                  value={draft.personality}
                  rows={3}
                  maxLength={100000}
                  disabled={locked}
                  onChange={(event) =>
                    change({ personality: event.target.value })
                  }
                  placeholder="How should this colleague communicate and approach work?"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${id}-voice`}>Voice</Label>
                <div className="flex flex-wrap gap-2">
                  <NativeSelect
                    id={`${id}-voice`}
                    value={draft.voice ?? ""}
                    disabled={locked}
                    onChange={(event) =>
                      change({ voice: event.target.value || null })
                    }
                  >
                    <option value="">Native default</option>
                    {draft.voice &&
                      !options?.voices.values.some(
                        (voice) => voice.id === draft.voice,
                      ) && (
                        <option value={draft.voice} disabled>
                          Saved voice: {draft.voice}
                        </option>
                      )}
                    {options?.voices.values.map((voice) => (
                      <option key={voice.id} value={voice.id}>
                        {voice.name}
                      </option>
                    ))}
                  </NativeSelect>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={locked}
                    onClick={() => void reloadOptions()}
                  >
                    Refresh voices
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Saved for this agent’s next call. Choosing a manager keeps
                  each agent’s own voice.
                </p>
                {options?.voices.state !== "available" && (
                  <p className="text-xs text-muted-foreground">
                    A started native session supplies the voice catalogue. You
                    can keep the native default or a saved voice until one is
                    available.
                  </p>
                )}
                {optionsError && (
                  <p role="alert" className="text-xs text-destructive">
                    {optionsError}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label>Model access</Label>
                <p className="rounded-md border px-3 py-2 text-sm">
                  {options?.runtime.label ??
                    "ChatGPT subscription · Crew isolated Codex profile"}
                </p>
                <p className="text-xs text-muted-foreground">
                  This is the supported runtime for this project. Subscription
                  sign-in is shared by its agents and remains separate from
                  service credentials.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${id}-instructions`}>Instructions</Label>
                <Textarea
                  id={`${id}-instructions`}
                  rows={6}
                  maxLength={100000}
                  value={draft.instructions}
                  disabled={locked}
                  onChange={(event) =>
                    change({ instructions: event.target.value })
                  }
                />
              </div>
              <details className="rounded-lg border px-4 py-3 text-sm">
                <summary className="font-medium">
                  Writing useful instructions
                </summary>
                <p className="mt-3 text-xs leading-5 text-muted-foreground">
                  Describe responsibilities, project context and how decisions
                  should reach you. Permissions are reviewed separately. Saving
                  keeps the chat and does not start work. For an existing chat,
                  explicit Restart applies changed instructions by summarizing
                  active context while retaining readable history; this uses
                  model allowance.
                </p>
              </details>
              <fieldset className="space-y-3 border-t pt-5">
                <legend className="pr-2 text-sm font-medium">Skills</legend>
                {snapshot.skills?.length ? (
                  snapshot.skills.map((skill) => (
                    <Choice
                      key={skill.id}
                      checked={draft.skills.some(
                        (item) => item.skillId === skill.id && item.enabled,
                      )}
                      disabled={locked}
                      onChange={(enabled) =>
                        change({
                          skills: [
                            ...draft.skills.filter(
                              (item) => item.skillId !== skill.id,
                            ),
                            { skillId: skill.id, enabled },
                          ],
                        })
                      }
                      description={skill.description}
                    >
                      {skill.name}
                    </Choice>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No project skills yet. Add reusable instructions in Skills,
                    then select them here.
                  </p>
                )}
              </fieldset>
              <Choice
                checked={draft.makePrimary}
                disabled={
                  locked ||
                  (draft.mode === "repair" &&
                    draft.agentId ===
                      (snapshot.projectSettings?.primaryAgentId ??
                        snapshot.primaryAgentId))
                }
                onChange={(value) => change({ makePrimary: value })}
                description={
                  draft.mode === "repair" &&
                  draft.agentId ===
                    (snapshot.projectSettings?.primaryAgentId ??
                      snapshot.primaryAgentId)
                    ? "This agent is your manager. Choose a different manager from the Agents table when needed."
                    : "The manager is the agent you talk to in the main conversation."
                }
              >
                Use as my manager
              </Choice>
            </section>
          )}
          {draft.step === 3 && access && (
            <section className="space-y-5">
              <StepTitle title="How can it help?">
                Access groups are shared, named collections of permissions. You
                can reuse and update them later.
              </StepTitle>
              {access.groups.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium">Existing groups</h3>
                  {access.groups.map((group) => (
                    <Choice
                      key={group.id}
                      checked={draft.groupIds.includes(group.id)}
                      disabled={locked}
                      onChange={(checked) =>
                        change({
                          groupIds: toggle(draft.groupIds, group.id, checked),
                        })
                      }
                      description={
                        group.description ||
                        `${group.grants.crew.length} Crew permissions · ${group.grants.environmentPolicyIds.length} folders · ${group.grants.services.length} services`
                      }
                    >
                      {group.name}
                    </Choice>
                  ))}
                </div>
              )}
              <Choice
                checked={draft.groupMode === "new"}
                disabled={locked}
                onChange={(checked) =>
                  change({
                    groupMode: checked ? "new" : "existing",
                    ...(!checked
                      ? { crewActions: [], serviceCapabilities: [] }
                      : {}),
                  })
                }
                description="Save the choices below in a group that other agents can also use."
              >
                Create a shared access group
              </Choice>
              {draft.groupMode === "new" && (
                <div className="space-y-4 rounded-lg border p-4">
                  <div className="space-y-2">
                    <Label htmlFor={`${id}-group`}>Group name</Label>
                    <Input
                      id={`${id}-group`}
                      value={draft.groupName}
                      maxLength={200}
                      disabled={locked}
                      onChange={(event) =>
                        change({ groupName: event.target.value })
                      }
                    />
                  </div>
                  <p className="text-xs leading-5 text-muted-foreground">
                    The selected Crew permissions apply across this project.
                    Folder access:{" "}
                    {folderLabels[draft.folderAccess].toLowerCase()}.
                  </p>
                  {bundles.map((bundle) => (
                    <Choice
                      key={bundle.label}
                      checked={bundle.actions.every((value) =>
                        draft.crewActions.includes(value),
                      )}
                      disabled={locked}
                      onChange={(checked) =>
                        change({
                          crewActions: checked
                            ? [
                                ...new Set([
                                  ...draft.crewActions,
                                  ...bundle.actions,
                                ]),
                              ]
                            : draft.crewActions.filter(
                                (value) => !bundle.actions.includes(value),
                              ),
                        })
                      }
                      description={bundle.description}
                    >
                      {bundle.label}
                    </Choice>
                  ))}
                  <details>
                    <summary className="cursor-pointer text-sm font-medium">
                      Choose individual permissions
                    </summary>
                    <div className="mt-3">
                      {access.crewCapabilities
                        .filter(
                          (capability) =>
                            ![
                              "environments.read",
                              "environments.attach",
                              "environments.execute",
                            ].includes(capability.action),
                        )
                        .map((capability) => (
                          <Choice
                            key={capability.action}
                            checked={draft.crewActions.includes(
                              capability.action,
                            )}
                            disabled={locked}
                            onChange={(checked) =>
                              change({
                                crewActions: toggle(
                                  draft.crewActions,
                                  capability.action,
                                  checked,
                                ) as CrewAction[],
                              })
                            }
                            description={capability.description}
                          >
                            {permissionLabels[capability.action] ??
                              capability.label}
                          </Choice>
                        ))}
                    </div>
                  </details>
                </div>
              )}
            </section>
          )}
          {draft.step === 4 && access && (
            <section className="space-y-5">
              <StepTitle title="Connections are optional">
                Connect the services your agent needs, or continue with local
                work in Crew.
              </StepTitle>
              {connecting && props.renderConnectionWizard ? (
                props.renderConnectionWizard({
                  snapshot: access,
                  onCommand: (name, args) => command(`access.${name}`, args),
                  onNotify: setNotice,
                  onComplete: (connectionId) => {
                    setConnecting(false);
                    change({
                      serviceConnectionIds: toggle(
                        local.current?.serviceConnectionIds ?? [],
                        connectionId,
                        true,
                      ),
                    });
                    void reloadAccess().catch(() =>
                      setError(
                        "Connection saved. Refresh access to select its permissions.",
                      ),
                    );
                  },
                  onCancel: () => setConnecting(false),
                  onSkip: () => setConnecting(false),
                })
              ) : (
                <>
                  {access.connections.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      No services connected. You can add one now or later.
                    </p>
                  )}
                  {access.connections.map((connection) => (
                    <div key={connection.id} className="rounded-lg border p-4">
                      <Choice
                        checked={draft.serviceConnectionIds.includes(
                          connection.id,
                        )}
                        disabled={locked}
                        onChange={(checked) =>
                          change({
                            serviceConnectionIds: toggle(
                              draft.serviceConnectionIds,
                              connection.id,
                              checked,
                            ),
                            serviceCapabilities: checked
                              ? draft.serviceCapabilities
                              : draft.serviceCapabilities.filter(
                                  (entry) =>
                                    entry.connectionId !== connection.id,
                                ),
                          })
                        }
                        description={`${connection.service} · ${connection.identity.displayName || "Account identity unavailable"} · ${connection.observedState === "connected" ? "Connected" : "Needs verification"}`}
                      >
                        {connection.name}
                      </Choice>
                      {draft.serviceConnectionIds.includes(connection.id) &&
                        draft.groupMode === "new" && (
                          <div className="mt-2 border-t pt-2">
                            <p className="text-xs text-muted-foreground">
                              Choose the actions this group can use.
                            </p>
                            {access.capabilities
                              .filter(
                                (capability) =>
                                  capability.connectionId === connection.id,
                              )
                              .map((capability) => (
                                <Choice
                                  key={capability.id}
                                  checked={
                                    draft.serviceCapabilities
                                      .find(
                                        (entry) =>
                                          entry.connectionId === connection.id,
                                      )
                                      ?.capabilities.includes(capability.id) ??
                                    false
                                  }
                                  disabled={locked}
                                  onChange={(checked) => {
                                    const existing =
                                      draft.serviceCapabilities.find(
                                        (entry) =>
                                          entry.connectionId === connection.id,
                                      )?.capabilities ?? [];
                                    change({
                                      serviceCapabilities: [
                                        ...draft.serviceCapabilities.filter(
                                          (entry) =>
                                            entry.connectionId !==
                                            connection.id,
                                        ),
                                        {
                                          connectionId: connection.id,
                                          capabilities: toggle(
                                            existing,
                                            capability.id,
                                            checked,
                                          ),
                                        },
                                      ],
                                    });
                                  }}
                                  description={capability.description}
                                >
                                  {capability.upstreamName}
                                </Choice>
                              ))}
                            {!access.capabilities.some(
                              (capability) =>
                                capability.connectionId === connection.id,
                            ) && (
                              <p className="mt-2 text-sm text-muted-foreground">
                                No verified actions are available for this
                                connection yet.
                              </p>
                            )}
                          </div>
                        )}
                    </div>
                  ))}
                  {props.renderConnectionWizard && (
                    <Button
                      variant="outline"
                      disabled={locked}
                      onClick={() => setConnecting(true)}
                    >
                      <Plus />
                      Add connection
                    </Button>
                  )}
                  {draft.serviceConnectionIds.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      Local-only setup selected.
                    </p>
                  )}
                </>
              )}
            </section>
          )}
          {draft.step === 5 && (
            <section className="space-y-5">
              <StepTitle title="Review your choices">
                {draft.mode === "repair"
                  ? "Save this agent’s profile, voice, skills and reviewed access."
                  : "Create your agent with the access shown below. It will be ready for you to start."}
              </StepTitle>
              {review ? (
                <Review draft={draft} review={review} access={access} />
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    Review the current configuration and access before
                    continuing.
                  </p>
                  <Button
                    variant="outline"
                    disabled={busy || conflict}
                    onClick={() => go(5)}
                  >
                    Refresh review
                  </Button>
                </div>
              )}
              {!signedIn && draft.mode === "create" && (
                <p className="text-sm text-muted-foreground">
                  Sign in with ChatGPT in the first step before creating your
                  agent.
                </p>
              )}
              {record.phase === "applying" && (
                <p role="status" className="text-sm">
                  Setup has saved partial progress. Continue to finish the same
                  agent safely.
                </p>
              )}
            </section>
          )}
          {!connecting && (
            <footer className="flex flex-wrap items-center justify-between gap-3 border-t pt-5">
              <span className="text-xs text-muted-foreground" role="status">
                {saving
                  ? "Saving choices…"
                  : dirty
                    ? "Unsaved choices"
                    : "Progress saved"}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  disabled={locked || draft.step === 0}
                  onClick={() => go(draft.step - 1)}
                >
                  <ArrowLeft />
                  Back
                </Button>
                {draft.step < 5 ? (
                  <Button
                    disabled={
                      locked ||
                      saving ||
                      (draft.step === 2 && !draft.name.trim()) ||
                      (draft.step === 3 &&
                        draft.groupMode === "new" &&
                        !draft.groupName.trim())
                    }
                    onClick={() => go(draft.step + 1)}
                  >
                    Continue
                    <ArrowRight />
                  </Button>
                ) : (
                  <Button
                    disabled={
                      busy ||
                      conflict ||
                      !review ||
                      (draft.mode === "create" && !signedIn)
                    }
                    onClick={complete}
                  >
                    {busy
                      ? "Saving…"
                      : record.phase === "applying"
                        ? "Continue setup"
                        : draft.mode === "repair"
                          ? "Save agent"
                          : draft.makePrimary
                            ? "Create manager"
                            : "Create agent"}
                  </Button>
                )}
              </div>
            </footer>
          )}
        </>
      )}
    </div>
  );
}

function StepTitle({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div>
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">{children}</p>
    </div>
  );
}
function scopeLabel(
  permission: CrewPermission,
  snapshot: AccessOwnerView | null,
) {
  return permission.scope.type === "self"
    ? "This agent"
    : permission.scope.type === "project"
      ? "Project"
      : permission.scope.agentIds
          .map(
            (id) =>
              snapshot?.agents.find((agent) => agent.id === id)?.profile.name ??
              "Unavailable agent",
          )
          .join(", ");
}
function Review({
  draft,
  review,
  access,
}: {
  draft: AgentSetupDraft;
  review: AgentSetupReview;
  access: AccessOwnerView | null;
}) {
  return (
    <div className="divide-y rounded-lg border px-4">
      <div className="py-4">
        <p className="text-sm font-medium">
          {draft.name}
          {draft.makePrimary ? " · Your manager" : ""}
        </p>
        <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">
          {draft.personality || "No personality guidance."}
        </p>
        <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">
          {draft.instructions || "No additional instructions."}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Voice: {draft.voice ?? "Native default"} ·{" "}
          {draft.skills.filter((item) => item.enabled).length} skills selected
        </p>
        {draft.mode === "repair" && (
          <p className="mt-2 text-xs text-muted-foreground">
            Changed instructions apply after explicit Restart. Your chat is
            retained.
          </p>
        )}
      </div>
      <div className="space-y-2 py-4">
        <p className="text-sm font-medium">
          Project folder · {folderLabels[review.folderAccess]}
        </p>
        <p className="break-all text-xs text-muted-foreground">
          {review.directory}
        </p>
        {review.workspaces
          .filter((workspace) => workspace.directory !== review.directory)
          .map((workspace) => (
            <p key={workspace.policyId} className="break-all text-xs">
              {workspace.directory} · {folderLabels[workspace.access]}
            </p>
          ))}
      </div>
      <div className="space-y-2 py-4">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Users className="size-4" />
          Shared access groups
        </p>
        {review.groups.map((group) => (
          <p key={group.id} className="text-sm">
            {group.name}
          </p>
        ))}
        {review.newGroup && (
          <p className="text-sm">
            {review.newGroup.name}{" "}
            <span className="text-xs text-muted-foreground">(new)</span>
          </p>
        )}
        {!review.newGroup && !review.groups.length && (
          <p className="text-sm text-muted-foreground">No groups selected.</p>
        )}
        <ul className="space-y-1 text-xs text-muted-foreground">
          {review.crewGrants.map((grant, index) => (
            <li key={`${grant.action}-${index}`}>
              {permissionLabels[grant.action] ??
                access?.crewCapabilities.find(
                  (entry) => entry.action === grant.action,
                )?.label ??
                grant.action}{" "}
              · {scopeLabel(grant, access)}
            </li>
          ))}
        </ul>
      </div>
      <div className="space-y-2 py-4">
        <p className="text-sm font-medium">Connections</p>
        {review.connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Local work only. No service accounts.
          </p>
        ) : (
          review.connections.map((connection) => (
            <div key={connection.id}>
              <p className="text-sm">{connection.name}</p>
              <ul className="mt-1 text-xs text-muted-foreground">
                {review.serviceCapabilities
                  .find((entry) => entry.connectionId === connection.id)
                  ?.capabilities.map((capabilityId) => (
                    <li key={capabilityId}>
                      {access?.capabilities.find(
                        (entry) => entry.id === capabilityId,
                      )?.upstreamName ?? "Previously approved action"}
                    </li>
                  ))}
              </ul>
            </div>
          ))
        )}
      </div>
      {review.warnings.length > 0 && (
        <div className="space-y-2 py-4">
          {review.warnings.map((warning) => (
            <p key={warning} className="text-sm text-muted-foreground">
              {warning}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
function message(cause: unknown) {
  return cause instanceof Error
    ? cause.message.slice(0, 1500)
    : "Setup could not complete. Your saved progress is retained.";
}
