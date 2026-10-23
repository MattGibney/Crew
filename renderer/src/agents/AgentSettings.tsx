import { AgentEditorForm } from "./AgentEditorForm";
import { useEditorEnvironment } from "./useEditorEnvironment";
import { OnlineStatus } from "@/components/online-status";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, Plus, EllipsisVertical, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
} from "@/components/ui/table";
import { AgentPicture, type AgentImageClient } from "./AgentPicture";
import { ArchiveAgentDialog } from "./ArchiveAgentDialog";
import { readProfilePicture } from "../manager/profile";
import type { AgentConfigurationOptions } from "../../../src/application/agent-configuration-contracts.mjs";
import type { AccessOwnerView } from "../../../src/access/owner-contracts.mjs";
import type {
  AgentSetupDraft,
  AgentSetupRecord,
} from "../../../src/desktop/agent-setup-contracts.mjs";
import type { AgentsSnapshot } from "./client";

type Command = <T>(name: string, args: unknown) => Promise<T>;
type Subscribe = (listener: (event: unknown) => void) => () => void;
interface Props {
  snapshot: AgentsSnapshot;
  command: Command;
  subscribe: Subscribe;
  refresh(): Promise<void>;
  visible: boolean;
  firstUse?: boolean;
  onOpenConnections?(): void;
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
/** Durable non-secret intent; the host validates and applies one reviewed setup. */
export function AgentSettings(props: Props) {
  const {
    command,
    subscribe,
    snapshot,
    visible,
    firstUse = false,
    refresh,
  } = props;
  const [agentTab, setAgentTab] = useState("Team members");
  const [archiveTarget, setArchiveTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [record, setRecord] = useState<AgentSetupRecord | null>(null);
  const [draft, setDraft] = useState<AgentSetupDraft | null>(null);
  const [access, setAccess] = useState<AccessOwnerView | null>(null);
  const [directory, setDirectory] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [paused, setPaused] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
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
        "Agent settings changed in another window. Your edits are retained. Reload before saving.",
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
            setError("Access could not be refreshed. Your edits are retained."),
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
        "Your edits could not be saved. They remain on screen. Reload agent data to resolve a revision conflict, or retry Save.",
      );
    } finally {
      pendingSave.current = null;
      if (alive.current) setSaving(false);
    }
  }, [command, accept]);

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
      if (discard && pendingSave.current)
        await pendingSave.current.catch(() => {});
      if (
        !discard &&
        local.current &&
        current.current &&
        !same(local.current, current.current.draft)
      )
        await save();
      const latest = discard
        ? await command<AgentSetupRecord | null>("setup.read", {})
        : current.current;
      const next = await command<AgentSetupRecord>("setup.new", {
        expectedRevision: latest?.revision ?? null,
        mode,
        ...(agentId ? { agentId } : {}),
      });
      accept(next);
      change({ groupMode: "existing", step: 0 });
      setPaused(false);
      setConflict(false);
      setNotice("");
    });
  }
  function complete() {
    void run(async () => {
      let reviewed = current.current;
      if (reviewed?.phase !== "applying") {
        const saved = await save();
        reviewed = await command<AgentSetupRecord>("setup.review", {
          expectedRevision: saved.revision,
        });
        accept(reviewed);
      }
      const result = await command<AgentSetupRecord>("setup.complete", {
        expectedRevision: reviewed?.revision,
      });
      accept(result);
      if (result.error) setError(result.error);
      if (result.phase === "complete") {
        setPaused(true);
        setNotice(
          result.result?.mode === "repair"
            ? "Agent saved. Restart its session to apply changed instructions; chat history is retained."
            : "Agent created. Start it when you are ready.",
        );
        try {
          if (result.result) await environment.save(result.result.agentId);
        } catch {
          setError(
            "Agent saved, but its environment template could not be saved. Reopen the agent to retry the template assignment.",
          );
        }
        await refresh().catch(() =>
          setError("Agent saved. Refresh the project to see the updated list."),
        );
      }
    });
  }
  function cancel() {
    void run(async () => {
      const next = await command<AgentSetupRecord | null>("setup.discard", {
        expectedRevision: current.current?.revision,
      });
      accept(next);
      setPaused(true);
      setConflict(false);
      setNotice("");
    });
  }
  const agents = snapshot.agents.filter((agent) => !agent.archivedAt);
  const agentSections = [
    {
      title: "Team members",
      description: "Agents who report directly to you.",
      rows: agents.filter((agent) => agent.reportsTo.type === "user"),
    },
    {
      title: "Worker agents",
      description: "Agents who report to another agent.",
      rows: agents.filter((agent) => agent.reportsTo.type === "agent"),
    },
  ];
  const active =
    record &&
    record.phase !== "complete" &&
    draft &&
    (!paused || record.phase === "applying");
  const environment = useEditorEnvironment(
    command,
    active ? record.id : null,
    draft?.agentId ?? null,
  );
  const locked = busy || conflict || record?.phase === "applying";
  const dirty = !same(draft, record?.draft);

  return (
    <div
      className={`${firstUse ? "mx-auto max-w-3xl px-5 py-8 sm:px-8" : ""} min-w-0 space-y-6`}
    >
      <ArchiveAgentDialog
        agent={archiveTarget}
        busy={busy}
        error={error}
        onCancel={() => setArchiveTarget(null)}
        onConfirm={() => {
          if (!archiveTarget) return;
          const target = archiveTarget;
          void run(async () => {
            await command("archiveAgent", { agentId: target.id });
            setArchiveTarget(null);
            setNotice(
              `${target.name} archived. Restore them from Archived agents settings when needed.`,
            );
            await refresh().catch(() =>
              setError(
                "Agent archived. Refresh the project to see the updated list.",
              ),
            );
          });
        }}
      />
      <div
        className={`flex flex-wrap items-start justify-between gap-3 ${active ? "sticky -top-10 z-20 -mx-4 -mt-10 bg-background px-4 pb-4 pt-10 supports-backdrop-filter:bg-background/70 supports-backdrop-filter:backdrop-blur-md" : ""}`}
      >
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {firstUse
              ? "Create your first agent"
              : active
                ? draft.mode === "repair"
                  ? "Edit agent"
                  : "Create an agent"
                : "Agents"}
          </h1>
          {(firstUse || active) && (
            <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
              {active && draft.mode === "repair"
                ? `Configure ${draft.name}, its skills and the access it can use.`
                : "Choose how your agent can help, the files it can use and any services it needs."}
            </p>
          )}
        </div>
        {!firstUse && !active && (
          <Button
            disabled={!loaded || busy || record?.phase === "applying"}
            onClick={() => begin("create")}
          >
            <Plus /> Create agent
          </Button>
        )}
        {active && (
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={busy || saving || record.phase === "applying"}
              onClick={cancel}
            >
              Cancel
            </Button>
            <Button
              disabled={
                busy || saving || conflict || !draft.name.trim() || !access
              }
              onClick={complete}
            >
              {busy || saving
                ? "Saving…"
                : record.phase === "applying"
                  ? "Retry save"
                  : draft.mode === "repair"
                    ? "Save changes"
                    : "Create agent"}
            </Button>
          </div>
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
              : "Refresh agent data"}
          </Button>
          {active && dirty && !conflict && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => complete()}
            >
              Retry save
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
        <p className="text-sm text-muted-foreground">Loading agents…</p>
      ) : !active ? (
        <div className="space-y-6">
          {firstUse && (
            <Button
              disabled={busy || record?.phase === "applying"}
              onClick={() => begin("create")}
            >
              <Plus />
              Create agent
            </Button>
          )}

          {!firstUse && (
            <Tabs
              value={agentTab}
              onValueChange={(value) => setAgentTab(String(value))}
              className="space-y-4"
            >
              <TabsList variant="line" aria-label="Agent types">
                {agentSections.map(({ title, rows }) => (
                  <TabsTrigger key={title} value={title}>
                    {title} <span className="text-xs">({rows.length})</span>
                  </TabsTrigger>
                ))}
              </TabsList>
              {agentSections.map(({ title, description, rows }) => (
                <TabsContent
                  key={title}
                  value={title}
                  keepMounted
                  className="space-y-3"
                >
                  <div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {description}
                    </p>
                  </div>
                  <div className="overflow-x-auto rounded-lg border">
                    <Table className="w-full text-left text-sm">
                      <TableCaption className="sr-only">
                        {title} and their saved configuration
                      </TableCaption>
                      <TableHeader className="border-b bg-muted/30 text-xs text-muted-foreground">
                        <TableRow>
                          <TableHead className="px-4 py-3 font-medium">
                            Agent
                          </TableHead>
                          <TableHead className="px-4 py-3 font-medium">
                            Reports to
                          </TableHead>
                          <TableHead className="px-4 py-3 font-medium">
                            Status
                          </TableHead>
                          <TableHead className="px-4 py-3 font-medium">
                            Voice
                          </TableHead>
                          <TableHead className="px-4 py-3 font-medium">
                            <span className="sr-only">Actions</span>
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody className="divide-y">
                        {rows.map((agent) => (
                          <TableRow key={agent.id}>
                            <TableCell className="px-4 py-3">
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
                            </TableCell>
                            <TableCell className="px-4 py-3 text-muted-foreground">
                              {agent.reportsTo.type === "user"
                                ? "You"
                                : (snapshot.agents.find(
                                    (parent) =>
                                      parent.id ===
                                      (agent.reportsTo.type === "agent"
                                        ? agent.reportsTo.agentId
                                        : null),
                                  )?.profile.name ?? "Unavailable agent")}
                            </TableCell>
                            <TableCell className="px-4 py-3 text-muted-foreground">
                              <OnlineStatus
                                online={
                                  agent.runtime.session.observedState ===
                                  "started"
                                }
                                title={`Session: ${agent.runtime.session.observedState}`}
                              />
                            </TableCell>
                            <TableCell className="px-4 py-3 text-muted-foreground">
                              {agent.profile.voice ?? "Native default"}
                            </TableCell>
                            <TableCell className="px-4 py-3 text-right">
                              <DropdownMenu>
                                <DropdownMenuTrigger
                                  render={
                                    <Button variant="ghost" size="icon" />
                                  }
                                  aria-label={`Actions for ${agent.profile.name}`}
                                  disabled={
                                    busy ||
                                    saving ||
                                    record?.phase === "applying"
                                  }
                                >
                                  <EllipsisVertical
                                    aria-hidden="true"
                                    className="size-4"
                                  />
                                </DropdownMenuTrigger>
                                <DropdownMenuContent>
                                  <DropdownMenuItem
                                    disabled={
                                      busy || record?.phase === "applying"
                                    }
                                    onClick={() => begin("repair", agent.id)}
                                  >
                                    <Pencil
                                      aria-hidden="true"
                                      className="size-4"
                                    />{" "}
                                    Edit
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    variant="destructive"
                                    disabled={
                                      busy ||
                                      saving ||
                                      record?.phase === "applying"
                                    }
                                    title="Stop its session and archive the agent. Its records are retained."
                                    onClick={() => {
                                      setError("");
                                      setArchiveTarget({
                                        id: agent.id,
                                        name: agent.profile.name,
                                      });
                                    }}
                                  >
                                    <Archive
                                      aria-hidden="true"
                                      className="size-4"
                                    />
                                    Archive
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    {!rows.length && (
                      <p className="px-4 py-8 text-sm text-muted-foreground">
                        {title === "Team members"
                          ? "No team members yet."
                          : "No worker agents yet."}
                      </p>
                    )}
                  </div>
                </TabsContent>
              ))}
            </Tabs>
          )}
        </div>
      ) : (
        <>
          {record.phase === "applying" && (
            <p role="status" className="rounded-lg border p-4 text-sm">
              Some changes have already been saved. Retry save to finish safely.
            </p>
          )}
          <AgentEditorForm
            draft={draft}
            access={access}
            snapshot={snapshot}
            directory={directory}
            options={options}
            optionsError={optionsError}
            locked={locked}
            imageClient={imageClient}
            environment={environment}
            onChange={(patch) => change({ ...patch, groupMode: "existing" })}
            onPicture={(file) => {
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
            onRefreshVoices={() => {
              void reloadOptions();
            }}
            onOpenAccess={props.onOpenConnections}
          />
        </>
      )}
    </div>
  );
}

function message(cause: unknown) {
  return cause instanceof Error
    ? cause.message.slice(0, 1500)
    : "Agent could not be saved. Your edits are retained.";
}
