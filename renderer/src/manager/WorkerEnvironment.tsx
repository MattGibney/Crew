import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "../components/ui/collapsible.js";
import { Checkbox } from "@/components/ui/checkbox";
import type { FormEvent } from "react";
import { errorText } from "./api.js";
import type {
  ManagerProps,
  WorkerEnvironmentConfig,
  EnvironmentHooks,
  EnvironmentPhase,
} from "../contracts/manager.js";
import { useEffect, useRef, useState } from "react";
import { Plus, Trash2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import { Alert, AlertDescription } from "@/components/ui/alert";

const projectPhases: [EnvironmentPhase, string, string][] = [
  [
    "setup",
    "Set up",
    "Existing project setup command for the agent to use when needed.",
  ],
  ["start", "Start", "Existing project command for starting the application."],
  [
    "resume",
    "Resume",
    "Project command for continuing a retained environment.",
  ],
  [
    "ready",
    "Check readiness",
    "Project check the agent can use to assess application readiness.",
  ],
  ["stop", "Stop", "Project command for stopping the intended runtime."],
  [
    "teardown",
    "Tear down",
    "Scoped resource cleanup; explicit archive can use configured teardown.",
  ],
];
const directPhases: [EnvironmentPhase, string, string][] = [
  [
    "bootstrap",
    "Set up",
    "Existing project setup command for the agent to use when needed.",
  ],
  ["start", "Start", "Existing project command for starting the application."],
  [
    "ready",
    "Check readiness",
    "Project check the agent can use to assess application readiness.",
  ],
  [
    "resume",
    "Resume",
    "Project command for continuing a retained environment.",
  ],
  [
    "cleanup",
    "Clean up",
    "Scoped resource cleanup; explicit archive can use configured cleanup.",
  ],
];

export function WorkerEnvironment({
  manager,
  onNotify,
}: ManagerProps & { onNotify: (message: string) => void }) {
  const saved = manager.settings?.workerEnvironment;
  const [draft, setDraft] = useState<WorkerEnvironmentConfig | null>(null),
    [baseRevision, setBaseRevision] = useState<string | null>(null),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const current: WorkerEnvironmentConfig = draft ?? saved?.environment ?? {};
  const plan = current.executionPlan,
    phases = plan ? projectPhases : directPhases,
    hooks = plan || current;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const editing = draft !== null,
    stale = editing && baseRevision !== saved?.revision;
  useEffect(() => {
    if (!editing) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [editing]);
  function update(change: (hooks: EnvironmentHooks) => void) {
    setDraft((previous) => {
      if (!previous) return previous;
      const next = structuredClone(previous);
      change(next.executionPlan || next);
      return next;
    });
    setError("");
  }
  function cancel() {
    setDraft(null);
    setBaseRevision(null);
    setError("");
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving || stale || !draft || !baseRevision) return;
    const submitted = draft;
    setSaving(true);
    setError("");
    try {
      const result = await manager.saveWorkerEnvironment(
        submitted,
        baseRevision,
      );
      if (draftRef.current === submitted) cancel();
      else setBaseRevision(result.workerEnvironment?.revision || null);
      onNotify(
        "Worker environment saved for upcoming directions and launches.",
      );
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setSaving(false);
    }
  }
  if (!saved)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading worker environment…
      </p>
    );
  return (
    <form
      onSubmit={save}
      className="space-y-6"
      aria-label="Worker environment configuration"
    >
      <div className="flex items-start justify-between gap-4 border-t pt-6">
        <div>
          <h3 className="font-semibold">Lifecycle commands</h3>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Saving runs nothing. These commands are context for your manager and
            workers to run through native tools when needed. Worker dispatch
            does not run setup, start or readiness checks. Explicit archive can
            use configured cleanup; earlier evidence and worktrees are
            preserved.
          </p>
        </div>
        {!editing && (
          <Button
            type="button"
            variant="link"
            className="shrink-0"
            disabled={saved.available === false}
            onClick={() => {
              setDraft(structuredClone(saved.environment));
              setBaseRevision(saved.revision);
            }}
          >
            Update
          </Button>
        )}
      </div>
      <div className="space-y-2 text-xs leading-5 text-muted-foreground">
        <p>
          {plan
            ? "Project execution plan · shell scripts are command context for native tools."
            : "Direct commands · executable and ordered arguments are saved as command context."}
        </p>
        {saved.available === false && <p>{saved.detail}</p>}
        <p>Worker context: the retained worktree.</p>
        <p className="break-all">
          Saved in {saved.configPath || "Crew project configuration"}.
        </p>
        <p>
          {plan
            ? "Project-file references identify the dependencies captured when this plan was configured. Edits here are Crew overrides; they do not edit those files or automatically import later file changes."
            : "These commands are explicit Crew configuration. Project instructions and Codex settings remain independently in effect."}
        </p>
      </div>
      {phases.map(([phase, label, hint]) => {
        const hook = hooks[phase];
        return (
          <section
            key={phase}
            className="border-t pt-5"
            aria-labelledby={`environment-${phase}`}
          >
            <div className="flex items-center justify-between gap-4">
              <h4 id={`environment-${phase}`} className="text-sm font-medium">
                {label}
              </h4>
              {editing && (
                <label className="flex items-center gap-2 text-xs">
                  <Checkbox
                    checked={Boolean(hook)}
                    disabled={saving}
                    onCheckedChange={(checked) =>
                      update((value) => {
                        if (checked)
                          value[phase] = plan
                            ? {
                                command: "",
                                timeoutMs: 600000,
                                source: structuredClone(plan.sources[0]),
                              }
                            : { command: "", args: [], timeoutMs: 600000 };
                        else delete value[phase];
                      })
                    }
                  />
                  Configured
                </label>
              )}
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {hint}
            </p>
            {!hook ? (
              <p className="mt-3 text-sm text-muted-foreground">
                Not configured
              </p>
            ) : (
              <div className="mt-4 space-y-4">
                <label className="block space-y-2 text-xs font-medium">
                  <span>{plan ? "Shell script" : "Executable"}</span>
                  {editing ? (
                    plan ? (
                      <Textarea
                        aria-label={`${label} shell script`}
                        required
                        maxLength={32000}
                        spellCheck={false}
                        className="min-h-24 font-mono text-xs"
                        value={hook.command}
                        disabled={saving}
                        onChange={(event) =>
                          update((value) => {
                            configured(value, phase).command =
                              event.target.value;
                          })
                        }
                      />
                    ) : (
                      <Input
                        aria-label={`${label} executable`}
                        required
                        maxLength={4096}
                        value={hook.command}
                        disabled={saving}
                        onChange={(event) =>
                          update((value) => {
                            configured(value, phase).command =
                              event.target.value;
                          })
                        }
                      />
                    )
                  ) : (
                    <pre className="whitespace-pre-wrap break-all rounded-md bg-muted/50 p-3 font-mono text-xs font-normal">
                      {hook.command}
                    </pre>
                  )}
                </label>
                {!plan && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium">Arguments, in order</p>
                    {(hook.args || []).map((argument, index) => (
                      <div key={index} className="flex items-start gap-2">
                        {editing ? (
                          <>
                            <Textarea
                              aria-label={`${label} argument ${index + 1}`}
                              value={argument}
                              maxLength={8192}
                              disabled={saving}
                              className="min-h-9 font-mono text-xs"
                              onChange={(event) =>
                                update((value) => {
                                  argumentsOf(value, phase)[index] =
                                    event.target.value;
                                })
                              }
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={`Remove ${label} argument ${index + 1}`}
                              disabled={saving}
                              onClick={() =>
                                update((value) => {
                                  argumentsOf(value, phase).splice(index, 1);
                                })
                              }
                            >
                              <Trash2 />
                            </Button>
                          </>
                        ) : (
                          <pre className="whitespace-pre-wrap break-all font-mono text-xs">
                            {index + 1}: {JSON.stringify(argument)}
                          </pre>
                        )}
                      </div>
                    ))}
                    {editing && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={saving || (hook.args || []).length >= 64}
                        onClick={() =>
                          update((value) => {
                            argumentsOf(value, phase).push("");
                          })
                        }
                      >
                        <Plus />
                        Add argument
                      </Button>
                    )}
                    {(hook.args || []).length === 0 && (
                      <p className="text-xs text-muted-foreground">
                        No arguments
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      One field per exact argument. Spaces, quotes, line breaks
                      and empty arguments are preserved.
                    </p>
                  </div>
                )}
                <label className="block space-y-2 text-xs font-medium">
                  <span>Timeout (milliseconds)</span>
                  {editing ? (
                    <Input
                      aria-label={`${label} timeout (milliseconds)`}
                      type="number"
                      required
                      min={1000}
                      max={600000}
                      step={1}
                      value={hook.timeoutMs}
                      disabled={saving}
                      onChange={(event) =>
                        update((value) => {
                          configured(value, phase).timeoutMs = Number(
                            event.target.value,
                          );
                        })
                      }
                    />
                  ) : (
                    <p className="font-normal text-muted-foreground">
                      {hook.timeoutMs} ms
                    </p>
                  )}
                </label>
                {plan && (
                  <div className="space-y-2 text-xs">
                    <label className="block space-y-2">
                      <span className="font-medium">Project dependency</span>
                      {editing ? (
                        <NativeSelect
                          aria-label={`${label} project dependency`}
                          className="w-full"
                          value={plan.sources.findIndex(
                            (source) =>
                              source.path === hook.source?.path &&
                              source.sha256 === hook.source?.sha256,
                          )}
                          disabled={saving}
                          onChange={(event) =>
                            update((value) => {
                              configured(value, phase).source = structuredClone(
                                plan.sources[Number(event.target.value)],
                              );
                            })
                          }
                        >
                          {plan.sources.map((source, index) => (
                            <option key={index} value={index}>
                              {source.path}
                            </option>
                          ))}
                        </NativeSelect>
                      ) : (
                        <p className="break-all text-muted-foreground">
                          {hook.source?.path}
                        </p>
                      )}
                    </label>
                    <p className="text-muted-foreground">
                      This reference records command provenance. Agents choose
                      how to run current project tooling.
                    </p>
                  </div>
                )}
              </div>
            )}
          </section>
        );
      })}
      {plan && (
        <section className="space-y-4 border-t pt-5">
          <h4 className="text-sm font-medium">Environment and permissions</h4>
          <div className="space-y-2 text-xs">
            <p className="font-medium">Legacy PATH snapshot</p>
            <p className="break-all text-muted-foreground">
              {plan.env?.PATH || "Not recorded"}
            </p>
            <p className="leading-5 text-muted-foreground">
              Kept for compatibility; this snapshot does not change command
              execution. Workers use the inherited environment and native tools.
              Normal Codex configuration and shell settings remain in effect.
            </p>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            Recorded network preference:{" "}
            {typeof plan.networkAccess === "boolean"
              ? plan.networkAccess
                ? "enabled"
                : "disabled"
              : "not recorded"}
            . Codex’s effective configuration and approvals remain
            authoritative. Permissions cannot be changed here.
          </p>
          {plan.permissionsSource && (
            <p className="break-all text-xs text-muted-foreground">
              Permissions reference: {plan.permissionsSource.path}
            </p>
          )}
          <Collapsible className="text-xs">
            <CollapsibleTrigger className="text-left cursor-pointer font-medium">
              Captured project dependencies
            </CollapsibleTrigger>
            <CollapsibleContent keepMounted>
              <ul className="mt-3 space-y-3">
                {plan.sources.map((source) => (
                  <li
                    key={source.path}
                    className="break-all text-muted-foreground"
                  >
                    {source.path}
                    <br />
                    SHA-256: {source.sha256}
                  </li>
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        </section>
      )}
      {stale && (
        <Alert role="alert">
          <AlertDescription>
            Configuration changed while you were editing. Your draft is
            preserved. Copy your edits, then cancel and reload settings before
            saving.
          </AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {(stale || error) && (
        <Button
          type="button"
          variant="outline"
          disabled={saving}
          onClick={() =>
            void manager
              .loadSettings()
              .catch((failure) => setError(errorText(failure)))
          }
        >
          Reload saved settings
        </Button>
      )}
      {editing && (
        <div className="flex justify-end gap-2 border-t pt-5">
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={cancel}
          >
            Cancel changes
          </Button>
          <Button
            type="submit"
            disabled={
              saving ||
              stale ||
              JSON.stringify(draft) === JSON.stringify(saved.environment)
            }
          >
            <Save />
            {saving ? "Saving…" : "Save environment"}
          </Button>
        </div>
      )}
    </form>
  );
}

function configured(hooks: EnvironmentHooks, phase: EnvironmentPhase) {
  const hook = hooks[phase];
  if (!hook) throw new Error("The command is no longer configured.");
  return hook;
}
function argumentsOf(hooks: EnvironmentHooks, phase: EnvironmentPhase) {
  const hook = configured(hooks, phase);
  return hook.args ?? (hook.args = []);
}
