import type { SettingsState } from "../../contracts/manager.js";
import type { ManagerProps } from "../../contracts/manager.js";
import { errorText } from "../api.js";
import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  CircleHelp,
  LoaderCircle,
  RotateCcw,
  Save,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

import { Alert, AlertDescription } from "@/components/ui/alert";

import type { NotifyProps } from "./WorkspaceSettings.js";
export function PromptEditor({
  role,
  data,
  manager,
  onNotify,
}: ManagerProps &
  NotifyProps & {
    role: "manager" | "worker";
    data: SettingsState["manager"];
  }) {
  const [draft, setDraft] = useState<string | null>(null),
    [editing, setEditing] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const [baseVersion, setBaseVersion] = useState<string | null>(null);
  const text = draft ?? data.saved.text;
  const draftRef = useRef(text);
  draftRef.current = text;
  const dirty = draft !== null && draft !== data.saved.text;
  const stale = dirty && baseVersion !== data.saved.version;
  const managerRole = role === "manager";
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const edit = (value: string) => {
    if (draft === null) setBaseVersion(data.saved.version);
    setDraft(value);
    setError("");
  };
  const cancel = () => {
    setEditing(false);
    setDraft(null);
    setBaseVersion(null);
    setError("");
    onNotify("Unsaved changes discarded.");
  };
  const save = async () => {
    if (!dirty || saving) return;
    const submitted = text;
    setSaving(true);
    setError("");
    try {
      const saved = await manager.savePrompt(
        role,
        submitted,
        baseVersion || data.saved.version,
      );
      if (draftRef.current === submitted) {
        setDraft(null);
        setBaseVersion(null);
        setEditing(false);
      } else setBaseVersion(saved[role].saved.version);
      onNotify(
        draftRef.current !== submitted
          ? "Instructions saved. Your newer edits are still unsaved."
          : managerRole
            ? "Instructions saved."
            : "Worker instructions saved for new workers.",
      );
    } catch (error) {
      setError(errorText(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section aria-labelledby={`${role}-instructions-heading`} className="pt-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id={`${role}-instructions-heading`}
            className="font-semibold tracking-tight"
          >
            {managerRole ? "Manager instructions" : "Worker instructions"}
          </h2>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
            {managerRole
              ? "Set how your manager communicates, plans work and helps you make decisions."
              : "Set how workers approach agreed tasks and report their findings."}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {dirty && <Badge variant="secondary">Unsaved changes</Badge>}
          {!editing && (
            <Button
              variant="link"
              className="h-auto p-0 text-sm font-semibold"
              aria-label={`Update ${role} instructions`}
              onClick={() => setEditing(true)}
            >
              Update
            </Button>
          )}
        </div>
      </div>
      {managerRole && data.pendingRestart && (
        <Alert role="status" className="mt-4">
          <AlertDescription>
            {manager.managerLifecycle.state === "stopped" ? "Start" : "Restart"}{" "}
            your manager in Sessions to apply these saved instructions.
          </AlertDescription>
        </Alert>
      )}
      {editing ? (
        <>
          <Label htmlFor={`${role}-prompt`} className="sr-only">
            {managerRole ? "Manager" : "Worker"} prompt
          </Label>
          <Textarea
            id={`${role}-prompt`}
            value={text}
            onChange={(event) => edit(event.target.value)}
            aria-describedby={`${role}-prompt-hint`}
            className="mt-6 min-h-64 resize-y font-mono text-xs leading-6"
            spellCheck={false}
          />
        </>
      ) : (
        <div className="mt-6 border-y py-6">
          <p className="line-clamp-5 whitespace-pre-wrap text-sm leading-7 text-muted-foreground">
            {data.saved.text}
          </p>
        </div>
      )}
      {editing && (
        <p
          id={`${role}-prompt-hint`}
          className="mt-2 text-xs leading-5 text-muted-foreground"
        >
          Applies only to this project. Don’t include passwords, API keys or
          other secrets.
        </p>
      )}
      <details className="group mt-5">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-2 rounded text-xs font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <CircleHelp
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          What to include and how it’s used
          <ChevronDown
            className="ml-auto size-3.5 shrink-0 transition-transform group-open:rotate-180"
            aria-hidden="true"
          />
        </summary>
        <div className="mt-4 space-y-4 border-l-2 pl-4 text-xs leading-6 text-muted-foreground">
          <div>
            <h3 className="font-medium text-foreground">What to include</h3>
            <ul className="mt-1 list-disc space-y-1 pl-4">
              {(managerRole
                ? [
                    "Project context, priorities and any terminology your manager should understand.",
                    "Your preferred tone, level of detail and format for updates.",
                    "How to plan work, explain trade-offs and raise decisions that need your input.",
                  ]
                : [
                    "Project conventions and quality standards to follow during agreed tasks.",
                    "How to check changes and record findings, decisions and limitations.",
                    "When to raise a question or blocker with the manager.",
                  ]
              ).map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p className="mt-2">
              Keep these instructions reusable. Put individual tasks and
              changing requirements in the manager conversation.
            </p>
          </div>
          <div>
            <h3 className="font-medium text-foreground">Example</h3>
            <blockquote className="mt-2 border-l-2 border-primary/30 pl-3 text-foreground">
              {managerRole
                ? "Keep updates concise and use plain language. Explain the options before recommending a direction. Ask me about unclear priorities, and distinguish verified results from assumptions."
                : "Follow the project’s existing conventions. Check the agreed behaviour, record what was verified and describe any remaining limitations. Raise unclear requirements with the manager before changing scope."}
            </blockquote>
          </div>
          <div>
            <h3 className="font-medium text-foreground">How it’s used</h3>
            <p className="mt-1">
              {managerRole
                ? "This text replaces Crew’s default manager instructions for this project and guides both typed and voice conversations. Save your edits, then explicitly start or restart the manager in Sessions to apply them. Worker instructions are configured separately."
                : "This text replaces Crew’s default worker instructions for this project. Saved changes apply to newly launched workers; existing workers keep the instructions they started with."}
            </p>
            <p className="mt-2">
              Crew still supplies project and task context. These instructions
              don’t change Codex permissions or approval requirements.
            </p>
          </div>
        </div>
      </details>
      {stale && (
        <Alert className="mt-3" role="alert">
          <AlertDescription>
            The saved version changed while you were editing. Your draft is
            preserved. Copy it before cancelling to load the latest saved
            instructions.
          </AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive" className="mt-3" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {editing && (
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <Button
            variant="ghost"
            disabled={saving || text === data.defaultText}
            onClick={() => edit(data.defaultText)}
          >
            <RotateCcw aria-hidden="true" />
            Reset to default
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" disabled={saving} onClick={cancel}>
              Cancel changes
            </Button>
            <Button
              disabled={
                !dirty || saving || stale || !text.trim() || !manager.eventReady
              }
              onClick={() => void save()}
            >
              {saving ? (
                <LoaderCircle
                  className="animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <Save aria-hidden="true" />
              )}
              {saving ? "Saving…" : "Save instructions"}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
