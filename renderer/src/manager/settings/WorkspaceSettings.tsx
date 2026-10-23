import type { WorkspaceSnapshot } from "../../contracts/setup.js";

import { errorText } from "../api.js";
import { useEffect, useState } from "react";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";

import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

export function useWorkspaceSettings() {
  const bridge = window.crewWorkspaces;
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    if (!bridge) return;
    let alive = true,
      changed = false;
    const unsubscribe = bridge.subscribe((value) => {
      changed = true;
      if (alive) setSnapshot(value);
    });
    bridge
      .snapshot()
      .then((value) => {
        if (alive && !changed) setSnapshot(value);
      })
      .catch((error) => {
        if (alive) setError(errorText(error));
      });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [bridge]);
  return { bridge, snapshot, setSnapshot, error };
}

export type NotifyProps = { onNotify: (message: string) => void };
type WorkspaceProps = NotifyProps & {
  workspace: ReturnType<typeof useWorkspaceSettings>;
};

export function ProjectGeneral({ workspace, onNotify }: WorkspaceProps) {
  const { bridge, snapshot } = workspace;
  const selected = snapshot?.projects.find(
    (project) => project.id === snapshot.selectedId,
  );
  const [draft, setDraft] = useState<string | null>(null),
    [editing, setEditing] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const value = draft ?? selected?.name ?? "";
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = value.trim();
    if (!selected || !name || saving) return;
    setSaving(true);
    setError("");
    try {
      await bridge!.rename({ id: selected.id, name });
      setDraft(null);
      setEditing(false);
      onNotify("Project name saved.");
    } catch (error) {
      setError(errorText(error) || "Could not save the project name.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <section aria-labelledby="project-name-heading" className="space-y-8 py-2">
      <form
        onSubmit={save}
        className="grid items-start gap-6 md:grid-cols-[minmax(0,0.8fr)_minmax(0,2fr)_auto] md:gap-8"
      >
        <h3 id="project-name-heading" className="text-base font-semibold">
          Project name
        </h3>
        <div className="min-w-0">
          {editing ? (
            <>
              <Label htmlFor="settings-project-name" className="sr-only">
                Project name
              </Label>
              <Input
                id="settings-project-name"
                maxLength={100}
                required
                value={value}
                disabled={saving}
                onChange={(event) => setDraft(event.target.value)}
              />
            </>
          ) : (
            <p className="break-words text-sm leading-6 text-muted-foreground">
              {selected?.name ||
                (!bridge ? "Available in the Crew desktop app" : "Loading…")}
            </p>
          )}
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            The name shown in Crew. Renaming keeps your project folder,
            conversation and work unchanged.
          </p>
          {(error || workspace.error) && (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {error || workspace.error}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          {editing ? (
            <>
              <Button
                type="button"
                variant="ghost"
                disabled={saving}
                onClick={() => {
                  setDraft(null);
                  setEditing(false);
                  setError("");
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={
                  saving || !value.trim() || value.trim() === selected?.name
                }
              >
                {saving ? "Saving…" : "Save"}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="link"
              aria-label="Update project name"
              className="h-auto p-0 text-sm font-semibold"
              disabled={!selected}
              onClick={() => setEditing(true)}
            >
              Update
            </Button>
          )}
        </div>
      </form>
      <Separator />
    </section>
  );
}

export function GlobalSettings({ workspace, onNotify }: WorkspaceProps) {
  const { bridge, snapshot, setSnapshot } = workspace;
  const [draft, setDraft] = useState<string | null>(null),
    [editing, setEditing] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = Number(draft ?? snapshot?.workerLimit);
    if (!Number.isInteger(value) || value < 1 || value > 64) {
      setError("Choose a whole number from 1 to 64.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await bridge!.setWorkerLimit(value);
      setSnapshot(await bridge!.snapshot());
      setDraft(null);
      setEditing(false);
      onNotify("Shared worker limit saved for all projects.");
    } catch (error) {
      setError(errorText(error) || "Could not save the shared worker limit.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <section
      aria-labelledby="global-capacity-heading"
      className="space-y-8 py-2"
    >
      <form
        onSubmit={save}
        className="grid items-start gap-6 md:grid-cols-[minmax(0,0.8fr)_minmax(0,2fr)_auto] md:gap-8"
      >
        <div>
          <h3 id="global-capacity-heading" className="text-base font-semibold">
            Worker limit
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Shared across all projects.
          </p>
        </div>
        <div className="min-w-0">
          {editing ? (
            <>
              <Label htmlFor="global-worker-limit" className="sr-only">
                Workers across all projects
              </Label>
              <Input
                id="global-worker-limit"
                type="number"
                min={1}
                max={64}
                step={1}
                required
                value={draft ?? snapshot?.workerLimit ?? ""}
                disabled={saving || !snapshot}
                onChange={(event) => setDraft(event.target.value)}
              />
            </>
          ) : (
            <p className="text-sm leading-6 text-muted-foreground">
              {!bridge
                ? "Available in the Crew desktop app"
                : snapshot
                  ? snapshot.workerLimit == null
                    ? "Unavailable"
                    : `${snapshot.workerLimit} concurrent workers`
                  : "Loading…"}
            </p>
          )}
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            One shared limit for this Mac. Running workers continue; waiting
            work starts as capacity becomes available.
          </p>
          {error && (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          {editing ? (
            <>
              <Button
                type="button"
                variant="ghost"
                disabled={saving}
                onClick={() => {
                  setDraft(null);
                  setEditing(false);
                  setError("");
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={
                  saving ||
                  !snapshot ||
                  draft === null ||
                  Number(draft) === snapshot.workerLimit
                }
              >
                {saving ? "Saving…" : "Save"}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="link"
              aria-label="Update shared worker limit"
              className="h-auto p-0 text-sm font-semibold"
              disabled={!bridge || !snapshot}
              onClick={() => setEditing(true)}
            >
              Update
            </Button>
          )}
        </div>
      </form>
      <Separator />
    </section>
  );
}
