import { useCallback, useEffect, useId, useMemo, useReducer } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import type {
  AgentTemplateAssignmentInput,
  AgentTemplateAssignmentView,
  AgentTemplateDefinitionView,
  AgentTemplateSnapshotView,
} from "../../../src/application/agent-template-contracts.mjs";

type Command = <T>(name: string, input: unknown) => Promise<T>;
type Choice = { templateId: string | null; templateRevision: number | null };
interface Entry {
  snapshot: AgentTemplateSnapshotView | null;
  saved: AgentTemplateAssignmentView | null;
  draft: Choice;
  baseline: number | null;
  loaded: boolean;
  available: boolean;
  loading: boolean;
  busy: boolean;
  conflict: boolean;
  pending: AgentTemplateAssignmentInput | null;
  error: string;
  notice: string;
  sequence: number;
  listeners: Set<() => void>;
}
const none = (): Choice => ({ templateId: null, templateRevision: null });
const choice = (row: Choice | null): Choice =>
  row
    ? { templateId: row.templateId, templateRevision: row.templateRevision }
    : none();
const same = (a: Choice, b: Choice) =>
  a.templateId === b.templateId && a.templateRevision === b.templateRevision;
const key = (row: Choice) =>
  JSON.stringify([row.templateId, row.templateRevision]);
const dirty = (entry: Entry) => !same(entry.draft, choice(entry.saved));
const revision = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
const text = (value: unknown, max: number, empty = false): value is string =>
  typeof value === "string" &&
  value.length <= max &&
  (empty || value.length > 0) &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);

function assignment(value: unknown): AgentTemplateAssignmentView {
  if (!value || typeof value !== "object")
    throw new Error("Invalid assignment");
  const row = value as AgentTemplateAssignmentView;
  if (
    !text(row.agentId, 256) ||
    !revision(row.revision) ||
    !text(row.updatedAt, 64) ||
    !Number.isFinite(Date.parse(row.updatedAt)) ||
    (row.templateId === null
      ? row.templateRevision !== null
      : !text(row.templateId, 256) || !revision(row.templateRevision))
  )
    throw new Error("Invalid assignment");
  return {
    agentId: row.agentId,
    revision: row.revision,
    ...choice(row),
    updatedAt: row.updatedAt,
  };
}

/** Decode only the owner presentation subset; no commands or environment values. */
export function decodeAgentTemplateSnapshot(
  value: unknown,
): AgentTemplateSnapshotView {
  if (!value || typeof value !== "object") throw new Error("Invalid templates");
  const snapshot = value as AgentTemplateSnapshotView;
  if (
    !Array.isArray(snapshot.templates) ||
    snapshot.templates.length > 2048 ||
    !Array.isArray(snapshot.assignments) ||
    snapshot.assignments.length > 4096
  )
    throw new Error("Invalid templates");
  const templates = snapshot.templates.map(
    (row): AgentTemplateDefinitionView => {
      if (
        !row ||
        !text(row.id, 256) ||
        !revision(row.revision) ||
        !text(row.name, 120) ||
        !text(row.description, 4096, true) ||
        !Array.isArray(row.tools) ||
        row.tools.length > 32 ||
        !row.tools.every(
          (tool) =>
            tool &&
            text(tool.name, 64) &&
            /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(tool.name) &&
            (tool.versionRequirement === null ||
              text(tool.versionRequirement, 120)),
        ) ||
        !row.capabilities ||
        typeof row.capabilities.network !== "boolean" ||
        typeof row.capabilities.packageDownloads !== "boolean" ||
        !Array.isArray(row.capabilities.localhostPorts) ||
        row.capabilities.localhostPorts.length > 16 ||
        !row.capabilities.localhostPorts.every(
          (port) => Number.isSafeInteger(port) && port >= 1024 && port <= 65535,
        )
      )
        throw new Error("Invalid template");
      return {
        id: row.id,
        revision: row.revision,
        name: row.name,
        description: row.description,
        tools: row.tools.map((tool) => ({
          name: tool.name,
          versionRequirement: tool.versionRequirement,
        })),
        capabilities: {
          network: row.capabilities.network,
          packageDownloads: row.capabilities.packageDownloads,
          localhostPorts: [...row.capabilities.localhostPorts],
        },
      };
    },
  );
  const assignments = snapshot.assignments.map(assignment);
  if (
    new Set(templates.map((row) => row.id)).size !== templates.length ||
    new Set(assignments.map((row) => row.agentId)).size !== assignments.length
  )
    throw new Error("Duplicate template identities");
  return { templates, assignments };
}

/** Bounded transient drafts, scoped to the project command and exact agent.
 * This is not persisted configuration or a second assignment authority. */
const drafts = new WeakMap<Command, Map<string, Entry>>();
function entryFor(command: Command, agentId: string): Entry {
  let entries = drafts.get(command);
  if (!entries) drafts.set(command, (entries = new Map()));
  let entry = entries.get(agentId);
  if (!entry) {
    entry = {
      snapshot: null,
      saved: null,
      draft: none(),
      baseline: null,
      loaded: false,
      available: false,
      loading: false,
      busy: false,
      conflict: false,
      pending: null,
      error: "",
      notice: "",
      sequence: 0,
      listeners: new Set(),
    };
    // Keep the 128 most recently opened agents; never evict an in-flight save.
    if (entries.size >= 128) {
      const removable = [...entries].find(
        ([, value]) =>
          !value.busy && !value.pending && value.listeners.size === 0,
      );
      if (removable) entries.delete(removable[0]);
      else return entry;
    }
  }
  entries.delete(agentId);
  entries.set(agentId, entry);
  return entry;
}
function publish(entry: Entry) {
  for (const listener of entry.listeners) listener();
}
function adoptSaved(entry: Entry, saved: AgentTemplateAssignmentView | null) {
  entry.saved = saved;
  entry.draft = choice(saved);
  entry.baseline = saved?.revision ?? null;
  entry.conflict = false;
  entry.pending = null;
  entry.loaded = true;
}
function acceptSnapshot(
  entry: Entry,
  snapshot: AgentTemplateSnapshotView,
  agentId: string,
) {
  const current =
    snapshot.assignments.find((row) => row.agentId === agentId) ?? null;
  entry.snapshot = snapshot;
  entry.available = true;
  if (entry.pending) {
    const attempt = entry.pending;
    if (
      current?.revision === (attempt.expectedRevision ?? 0) + 1 &&
      same(current, attempt)
    ) {
      adoptSaved(entry, current);
      entry.error = "";
      entry.notice = "Template saved. Preparation remains a separate action.";
      return;
    }
    entry.saved = current;
    entry.conflict = (current?.revision ?? null) !== attempt.expectedRevision;
    entry.error = entry.conflict
      ? "The saved template assignment changed. Your selection is retained. Cancel to use the current saved assignment before making another change."
      : "The save outcome is not confirmed. Refresh to check the saved assignment; Crew will not repeat the save automatically.";
    return;
  }
  if (!entry.loaded || !dirty(entry)) {
    adoptSaved(entry, current);
    entry.error = "";
  } else {
    entry.saved = current;
    entry.conflict = (current?.revision ?? null) !== entry.baseline;
    entry.error = entry.conflict
      ? "The saved template assignment changed. Your selection is retained. Cancel to use the current saved assignment before saving again."
      : "";
  }
}

/** Assignment only: loading, saving and cancellation never prepare an environment. */
export function AgentEnvironmentTemplate({
  agentId,
  command,
  subscribe,
  visible,
}: {
  agentId: string | null;
  command: Command;
  subscribe?: (listener: (event: unknown) => void) => () => void;
  visible: boolean;
}) {
  const id = useId();
  const [, redraw] = useReducer((value) => value + 1, 0);
  const entry = useMemo(
    () => (agentId ? entryFor(command, agentId) : null),
    [command, agentId],
  );
  const reload = useCallback(async () => {
    if (!entry || !agentId) return;
    const request = ++entry.sequence;
    entry.loading = true;
    publish(entry);
    try {
      const snapshot = decodeAgentTemplateSnapshot(
        await command("environments.templates.snapshot", {}),
      );
      if (request === entry.sequence) acceptSnapshot(entry, snapshot, agentId);
    } catch {
      if (request === entry.sequence) {
        entry.available = false;
        entry.error = entry.notice
          ? "The template was saved, but the latest catalogue could not be refreshed. Refresh repeats only the read."
          : entry.pending
            ? "The save outcome is not confirmed and the saved assignment could not be read. Your selection is retained. Refresh checks the outcome without repeating the save."
            : "Environment templates are unavailable. Your selection is retained. Refresh when the project connection is available.";
      }
    } finally {
      if (request === entry.sequence) entry.loading = false;
      publish(entry);
    }
  }, [command, entry, agentId]);
  useEffect(() => {
    if (!entry) return;
    const listener = () => redraw();
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
    };
  }, [entry]);
  useEffect(() => {
    if (visible && !entry?.busy) void reload();
  }, [visible, entry, reload]);
  useEffect(
    () =>
      subscribe?.(() => {
        if (visible && !entry?.busy) void reload();
      }),
    [subscribe, visible, entry, reload],
  );

  async function save() {
    if (
      !entry ||
      !agentId ||
      entry.busy ||
      entry.pending ||
      entry.conflict ||
      !entry.available ||
      !dirty(entry)
    )
      return;
    const submitted: AgentTemplateAssignmentInput = {
      agentId,
      expectedRevision: entry.baseline,
      ...choice(entry.draft),
    };
    entry.pending = submitted;
    entry.busy = true;
    entry.sequence++;
    entry.error = "";
    entry.notice = "";
    publish(entry);
    try {
      const saved = assignment(
        await command("environments.templates.assign", submitted),
      );
      if (
        saved.agentId !== agentId ||
        saved.revision !== (submitted.expectedRevision ?? 0) + 1 ||
        !same(saved, submitted)
      )
        throw new Error("Unexpected saved template");
      adoptSaved(entry, saved);
      entry.notice = "Template saved. Preparation remains a separate action.";
    } catch {
      // A read can prove the exact next committed assignment. Never replay an
      // unknown save merely because its response failed or an agent was switched.
    } finally {
      entry.busy = false;
      publish(entry);
      await reload();
    }
  }

  if (!agentId || !entry)
    return (
      <section className="space-y-2 border-t pt-5">
        <h3 className="text-sm font-medium">Environment template</h3>
        <p className="text-xs leading-5 text-muted-foreground">
          Save this agent first, then reopen it to assign an environment
          template. Preparation remains a separate explicit action.
        </p>
      </section>
    );

  const latest = entry.snapshot?.templates ?? [];
  const selected = latest.find(
    (row) =>
      row.id === entry.draft.templateId &&
      row.revision === entry.draft.templateRevision,
  );
  const options = latest.map((row) => ({
    ...choice({ templateId: row.id, templateRevision: row.revision }),
    label: `${row.name} · revision ${row.revision}`,
  }));
  for (const [value, suffix] of [
    [choice(entry.saved), "saved pinned revision"],
    [entry.draft, "retained selected revision"],
  ] as const) {
    if (value.templateId && !options.some((row) => same(row, value))) {
      const name =
        latest.find((row) => row.id === value.templateId)?.name ??
        "Retained template";
      options.push({
        ...choice(value),
        label: `${name} · ${suffix} ${value.templateRevision}`,
      });
    }
  }
  const savedName = entry.saved?.templateId
    ? (latest.find((row) => row.id === entry.saved!.templateId)?.name ??
      "Retained template")
    : "No template";
  return (
    <section
      className="space-y-4 border-t pt-5"
      aria-label="Agent environment template"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Environment template</h3>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
            Assign tool requirements and preparation choices. This grants no
            folder permission and never installs tools or prepares an
            environment. Preparation remains explicit.
          </p>
        </div>
        <Button
          variant="link"
          size="sm"
          disabled={entry.busy || entry.loading}
          onClick={() => void reload()}
        >
          {entry.loading ? "Refreshing…" : "Refresh templates"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {entry.loaded
          ? `Saved: ${savedName}${entry.saved?.templateRevision ? ` · pinned revision ${entry.saved.templateRevision}` : ""}`
          : entry.loading
            ? "Loading saved template…"
            : "Saved template unavailable."}
      </p>
      {entry.notice && (
        <p role="status" className="text-sm">
          {entry.notice}
        </p>
      )}
      {entry.error && (
        <p role="alert" className="text-sm text-destructive">
          {entry.error}
        </p>
      )}
      <div className="max-w-lg space-y-2">
        <Label htmlFor={`${id}-template`}>Template for this agent</Label>
        <NativeSelect
          id={`${id}-template`}
          value={key(entry.draft)}
          disabled={!entry.loaded || entry.busy || Boolean(entry.pending)}
          onChange={(event) => {
            const value = options.find(
              (row) => key(row) === event.target.value,
            );
            entry.draft = value ? choice(value) : none();
            entry.notice = "";
            publish(entry);
          }}
        >
          <option value={key(none())}>No template</option>
          {options.map((row) => (
            <option key={key(row)} value={key(row)}>
              {row.label}
            </option>
          ))}
        </NativeSelect>
      </div>
      {selected ? (
        <TemplateSummary template={selected} />
      ) : (
        entry.draft.templateId && (
          <p className="text-xs leading-5 text-muted-foreground">
            This selection keeps its exact retained revision. The latest
            catalogue does not include that revision’s definition, so its tool
            and network summary is unavailable here. Choose a newer revision
            explicitly to change it.
          </p>
        )
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={
            entry.busy ||
            Boolean(entry.pending) ||
            entry.conflict ||
            !entry.available ||
            !dirty(entry)
          }
          onClick={() => void save()}
        >
          {entry.busy ? "Saving…" : "Save template"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={
            entry.busy ||
            (Boolean(entry.pending) && !entry.conflict) ||
            (!dirty(entry) && !entry.pending && !entry.conflict)
          }
          onClick={() => {
            adoptSaved(entry, entry.saved);
            entry.error = "";
            entry.notice = "";
            publish(entry);
          }}
        >
          Cancel
        </Button>
      </div>
    </section>
  );
}

function TemplateSummary({
  template,
}: {
  template: AgentTemplateDefinitionView;
}) {
  return (
    <div className="space-y-2 text-xs leading-5 text-muted-foreground">
      {template.description && <p>{template.description}</p>}
      <p>
        Tool requirements:{" "}
        {template.tools.length
          ? template.tools
              .map(
                (tool) =>
                  `${tool.name === "node" ? "Node.js" : tool.name}${tool.versionRequirement ? ` ${tool.versionRequirement}` : " (no version constraint)"}`,
              )
              .join(", ")
          : "none specified"}
        .
      </p>
      <p>
        Network: {template.capabilities.network ? "requested" : "not requested"}
        . Package downloads:{" "}
        {template.capabilities.packageDownloads ? "requested" : "not requested"}
        .
      </p>
      <p>
        These are saved requirements, not evidence that tools are installed or
        an environment is ready.
      </p>
    </div>
  );
}
