import { ChevronDown as DisclosureChevronDown } from "lucide-react";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { AccessSection } from "../access/shared";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type {
  EnvironmentTemplate,
  EnvironmentTemplateDraft,
  EnvironmentTemplateInspection,
  EnvironmentTemplateSnapshot,
} from "../../../src/agents/environment-templates.mjs";
import { SettingsToast } from "../manager/settings/SettingsToast";

type Command = <T>(name: string, input: unknown) => Promise<T>;
type EditorDraft = {
  id: string | null;
  expectedRevision: number | null;
  name: string;
  description: string;
  node: boolean;
  nodeVersion: string;
  nodeVersionArguments?: string[];
  npm: boolean;
  npmVersion: string;
  npmVersionArguments?: string[];
  executableDirectories: string;
  readableDirectories: string;
  network: boolean;
  packageDownloads: boolean;
  localhostPorts: string;
  inboundPorts: string;
  docker: boolean;
  socketPath: string;
  dockerAcknowledged: boolean;
  additionalTools: string;
  advanced: string;
};
// Transient, project-command-scoped drafts survive Settings navigation.
const retainedDrafts = new WeakMap<Command, EditorDraft>();
const uncertainSaves = new WeakSet<Command>();
function edit(template?: EnvironmentTemplate): EditorDraft {
  return {
    id: template?.id ?? null,
    expectedRevision: template?.revision ?? null,
    name: template?.name ?? "",
    description: template?.description ?? "",
    node: template?.tools.some((tool) => tool.name === "node") ?? false,
    nodeVersion:
      template?.tools.find((tool) => tool.name === "node")
        ?.versionRequirement ?? "",
    nodeVersionArguments: template?.tools.find((tool) => tool.name === "node")
      ?.versionArguments,
    npmVersionArguments: template?.tools.find((tool) => tool.name === "npm")
      ?.versionArguments,
    npm: template?.tools.some((tool) => tool.name === "npm") ?? false,
    npmVersion:
      template?.tools.find((tool) => tool.name === "npm")?.versionRequirement ??
      "",
    executableDirectories: template?.executableDirectories.join("\n") ?? "",
    readableDirectories: template?.readableDirectories.join("\n") ?? "",
    network: template?.capabilities.network ?? false,
    packageDownloads: template?.capabilities.packageDownloads ?? false,
    localhostPorts: template?.capabilities.localhostPorts.join(", ") ?? "",
    inboundPorts: template?.capabilities.inboundPorts?.join(", ") ?? "",
    docker: Boolean(template?.hostDocker),
    socketPath: template?.hostDocker?.socketPath ?? "",
    dockerAcknowledged: template?.hostDocker?.hostAccessAcknowledged ?? false,
    additionalTools: JSON.stringify(
      template?.tools.filter((tool) => !["node", "npm"].includes(tool.name)) ??
        [],
      null,
      2,
    ),
    advanced: JSON.stringify(
      {
        environment: template?.environment ?? {},
        preparation: template?.preparation ?? {
          instructions: "",
          commands: [],
        },
      },
      null,
      2,
    ),
  };
}
const lines = (value: string) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
function definition(value: EditorDraft): EnvironmentTemplateDraft {
  if (!value.name.trim()) throw new Error("Enter a template name.");
  const advanced = JSON.parse(value.advanced);
  if (
    !advanced ||
    typeof advanced !== "object" ||
    Array.isArray(advanced) ||
    Object.keys(advanced).some(
      (key) => !["environment", "preparation"].includes(key),
    ) ||
    !advanced.environment ||
    !advanced.preparation
  )
    throw new Error(
      "Advanced configuration needs environment and preparation fields only.",
    );
  if (value.docker && (!value.socketPath.trim() || !value.dockerAcknowledged))
    throw new Error(
      "Enter the Docker socket path and acknowledge its broad host authority.",
    );
  return {
    name: value.name.trim(),
    description: value.description,
    tools: [
      ...JSON.parse(value.additionalTools),
      ...(value.node
        ? [
            {
              name: "node" as const,
              versionRequirement: value.nodeVersion.trim() || null,
              ...(value.nodeVersionArguments
                ? { versionArguments: value.nodeVersionArguments }
                : {}),
            },
          ]
        : []),
      ...(value.npm
        ? [
            {
              name: "npm" as const,
              versionRequirement: value.npmVersion.trim() || null,
              ...(value.npmVersionArguments
                ? { versionArguments: value.npmVersionArguments }
                : {}),
            },
          ]
        : []),
    ],
    executableDirectories: lines(value.executableDirectories),
    readableDirectories: lines(value.readableDirectories),
    environment: advanced.environment,
    preparation: advanced.preparation,
    capabilities: {
      network: value.network,
      packageDownloads: value.packageDownloads,
      localhostPorts: [],
      inboundPorts: [],
    },
    ...(value.docker
      ? {
          hostDocker: {
            socketPath: value.socketPath.trim(),
            hostAccessAcknowledged: true as const,
          },
        }
      : {}),
  };
}

/** Owner configuration only. Save never inspects, installs or prepares tools. */
export function EnvironmentTemplateEditor({
  command,
  subscribe,
  visible,
}: {
  command: Command;
  subscribe: (listener: (event: unknown) => void) => () => void;
  visible: boolean;
}) {
  const id = useId();
  const [templates, setTemplates] = useState<EnvironmentTemplate[] | null>(
    null,
  );
  const [draft, setDraftState] = useState<EditorDraft | null>(
    () => retainedDrafts.get(command) ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertainState] = useState(() =>
    uncertainSaves.has(command),
  );
  function setUncertain(value: boolean) {
    if (value) uncertainSaves.add(command);
    else uncertainSaves.delete(command);
    setUncertainState(value);
  }
  const [inspection, setInspection] =
    useState<EnvironmentTemplateInspection | null>(null);
  const [toast, setToast] = useState<{ id: string; message: string } | null>(
    null,
  );
  const alive = useRef(true),
    sequence = useRef(0),
    action = useRef(false);
  function setDraft(value: EditorDraft | null) {
    if (value) retainedDrafts.set(command, value);
    else retainedDrafts.delete(command);
    setDraftState(value);
  }
  const reload = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const snapshot = await command<EnvironmentTemplateSnapshot>(
        "environments.templates.snapshot",
        {},
      );
      if (
        !Array.isArray(snapshot?.templates) ||
        snapshot.templates.some(
          (row) =>
            !row ||
            typeof row.id !== "string" ||
            !Number.isSafeInteger(row.revision) ||
            !Array.isArray(row.tools) ||
            !Array.isArray(row.executableDirectories) ||
            !Array.isArray(row.readableDirectories) ||
            !row.capabilities ||
            !row.preparation,
        )
      )
        throw new Error("Invalid template snapshot");
      if (alive.current && request === sequence.current)
        setTemplates(snapshot.templates);
    } catch {
      if (alive.current && request === sequence.current)
        setError(
          "Environment templates could not be refreshed. Your draft is retained.",
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
  const stale = Boolean(
    draft?.id &&
    templates &&
    templates.find((row) => row.id === draft.id)?.revision !==
      draft.expectedRevision,
  );
  function open(template?: EnvironmentTemplate) {
    setDraft(edit(template));
    setError("");
    setUncertain(false);
    setInspection(null);
  }
  async function save() {
    if (!draft || action.current || stale || uncertain || !templates) return;
    let input: {
      id: string | null;
      expectedRevision: number | null;
      draft: EnvironmentTemplateDraft;
    };
    try {
      input = {
        id: draft.id,
        expectedRevision: draft.expectedRevision,
        draft: definition(draft),
      };
    } catch (cause) {
      setError(
        cause instanceof SyntaxError
          ? "Advanced configuration must be valid JSON."
          : (cause as Error).message,
      );
      return;
    }
    action.current = true;
    setUncertain(true);
    setBusy(true);
    setError("");
    try {
      const saved = await command<EnvironmentTemplate>(
        "environments.templates.save",
        input,
      );
      if (
        !saved ||
        typeof saved.id !== "string" ||
        !Number.isSafeInteger(saved.revision)
      )
        throw new Error("Save was not confirmed");
      retainedDrafts.delete(command);
      uncertainSaves.delete(command);
      if (alive.current) {
        setUncertain(false);
        setDraft(null);
        setInspection(null);
        setToast({
          id: crypto.randomUUID(),
          message:
            "Environment template saved. Assign it from the agent's settings; preparation is a separate action.",
        });
      }
      await reload();
    } catch {
      if (alive.current) {
        setUncertain(true);
        setError(
          "Save was not confirmed. Your draft is retained. Refresh and review the saved templates before discarding or retrying this draft; no save will be repeated automatically.",
        );
      }
      await reload();
    } finally {
      action.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function inspect(template: EnvironmentTemplate) {
    if (action.current) return;
    action.current = true;
    setBusy(true);
    setError("");
    setInspection(null);
    try {
      const result = await command<EnvironmentTemplateInspection>(
        "environments.templates.inspect",
        { templateId: template.id, templateRevision: template.revision },
      );
      if (
        !result ||
        result.templateId !== template.id ||
        result.templateRevision !== template.revision ||
        !Array.isArray(result.tools) ||
        !Array.isArray(result.limitations)
      )
        throw new Error("Invalid inspection");
      if (alive.current) setInspection(result);
    } catch {
      if (alive.current)
        setError(
          "Tool inspection could not be confirmed. Availability remains unknown.",
        );
    } finally {
      action.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function field(
    label: string,
    key: keyof EditorDraft,
    multiline = false,
    help?: string,
  ) {
    if (!draft) return null;
    const props = {
      id: `${id}-${key}`,
      value: String(draft[key]),
      onChange: (
        event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
      ) => setDraft({ ...draft, [key]: event.target.value }),
    };
    return (
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor={props.id}>
          {label}
        </label>
        {multiline ? <Textarea {...props} /> : <Input {...props} />}
        {help && (
          <p className="text-xs leading-5 text-muted-foreground">{help}</p>
        )}
      </div>
    );
  }
  function toggle(
    label: string,
    key:
      | "node"
      | "npm"
      | "network"
      | "packageDownloads"
      | "docker"
      | "dockerAcknowledged",
  ) {
    if (!draft) return null;
    return (
      <label className="flex items-start gap-2 text-sm">
        <Checkbox
          className="mt-1"
          checked={draft[key]}
          onCheckedChange={(checked) =>
            setDraft({
              ...draft,
              [key]: checked,
              ...(key === "docker" ? { dockerAcknowledged: false } : {}),
            })
          }
        />
        {label}
      </label>
    );
  }
  return (
    <AccessSection
      title="Environment templates"
      description="Define the tools, setup and network access available to agents. Agents prepare their own environments and receive a notice when their template changes."
    >
      {templates === null ? (
        <p className="text-sm text-muted-foreground">
          Templates are not loaded.
        </p>
      ) : templates.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No environment templates yet.
        </p>
      ) : (
        templates.map((template) => (
          <div
            key={template.id}
            className="flex flex-wrap items-start justify-between gap-3 border-b pb-4"
          >
            <div className="min-w-0 flex-1">
              <p className="break-words text-sm font-medium">{template.name}</p>
              <p className="break-words text-xs leading-5 text-muted-foreground">
                {template.description}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                disabled={busy || Boolean(draft)}
                onClick={() => open(template)}
              >
                Update
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void inspect(template)}
              >
                Inspect tools
              </Button>
            </div>
          </div>
        ))
      )}
      {!draft && (
        <Button
          variant="outline"
          disabled={busy || !templates}
          onClick={() => open()}
        >
          New template
        </Button>
      )}
      {draft && (
        <fieldset disabled={busy} className="min-w-0 space-y-5">
          <legend className="mb-4 text-base font-semibold">
            {draft.id ? "Update template" : "New template"}
          </legend>
          <Separator />
          {field("Name", "name")}
          {field("Description", "description", true)}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-3">
              {toggle("Require Node.js", "node")}
              {draft.node &&
                field(
                  "Node.js version requirement (optional)",
                  "nodeVersion",
                  false,
                  "For example: >=22",
                )}
            </div>
            <div className="space-y-3">
              {toggle("Require npm", "npm")}
              {draft.npm &&
                field("npm version requirement (optional)", "npmVersion")}
            </div>
          </div>
          {field(
            "Additional executable requirements (JSON)",
            "additionalTools",
            true,
            'For example: [{"name":"git","versionRequirement":">=2"},{"name":"ffmpeg","versionRequirement":null,"versionArguments":["-version"]}]. Existing approved tools only; no installation on save.',
          )}
          {field(
            "Executable directories",
            "executableDirectories",
            true,
            "One narrow absolute directory per line, containing existing tool installations. No credentials or personal configuration.",
          )}
          {field(
            "Readable tool directories",
            "readableDirectories",
            true,
            "One narrow absolute directory per line for tool support files.",
          )}
          <div className="space-y-3">
            {toggle("Allow outbound network access", "network")}
            {toggle("Allow package downloads", "packageDownloads")}
          </div>
          <Separator />
          <div className="space-y-3">
            {toggle("Enable host Docker access", "docker")}
            {draft.docker && (
              <>
                {field(
                  "Absolute Docker socket path",
                  "socketPath",
                  false,
                  "Enter the existing host daemon socket explicitly.",
                )}
                {toggle(
                  "I acknowledge Docker grants daemon-wide control and host mounts beyond the workspace filesystem restrictions.",
                  "dockerAcknowledged",
                )}
                <p className="text-xs leading-5 text-muted-foreground">
                  This is broad trusted host authority. Crew uses private Docker
                  configuration and does not copy personal Docker credentials.
                </p>
              </>
            )}
          </div>
          <Collapsible>
            <CollapsibleTrigger
              type="button"
              className="group flex w-full items-center gap-2 text-left cursor-pointer text-sm font-medium"
            >
              <DisclosureChevronDown
                className="size-4 shrink-0 transition-transform group-aria-expanded:rotate-180"
                aria-hidden="true"
              />
              Advanced nonsecret configuration
            </CollapsibleTrigger>
            <CollapsibleContent keepMounted>
              <div className="mt-3 space-y-2">
                {field(
                  "Environment and preparation (JSON)",
                  "advanced",
                  true,
                  'Use environment for nonsecret string values. Preparation has instructions and suggested commands as argument arrays, for example [["npm", "ci"]]. Agents explicitly run those commands after preparation. Never enter credentials.',
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>
          {stale && (
            <p role="alert" className="text-sm text-destructive">
              The saved template changed elsewhere. Your draft is retained.
              Discard it and reopen the saved template before editing its
              current revision.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={stale || uncertain || !templates}
              onClick={() => void save()}
            >
              Save template
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setDraft(null);
                setError("");
                setUncertain(false);
              }}
            >
              Discard draft
            </Button>
          </div>
        </fieldset>
      )}
      {uncertain && !busy && !error && (
        <p role="alert" className="text-sm text-destructive">
          A previous save has not been confirmed. Refresh and review saved
          templates before discarding this retained draft. Saving again is
          blocked to avoid duplicates.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button variant="ghost" disabled={busy} onClick={() => void reload()}>
        Refresh templates
      </Button>
      {inspection && (
        <div className="space-y-3 border-t pt-6" role="status">
          <h3 className="text-sm font-medium">
            Tool inspection:{" "}
            {templates?.find((row) => row.id === inspection.templateId)?.name ??
              "Saved template"}
          </h3>
          <p className="text-xs text-muted-foreground">
            Checked {inspection.checkedAt}. Inspection observes tools; it does
            not prepare an agent environment.
          </p>
          {inspection.tools.length === 0 && (
            <p className="text-sm">No tool requirements configured.</p>
          )}
          {inspection.tools.map((tool) => (
            <div key={tool.name} className="space-y-1 text-sm">
              <p>
                {tool.name}: {tool.state.replaceAll("_", " ")}
                {tool.observedVersion ? ` (${tool.observedVersion})` : ""}
              </p>
              {tool.executablePath && (
                <p className="break-all text-xs text-muted-foreground">
                  {tool.executablePath}
                </p>
              )}
              {tool.reason && (
                <p className="text-xs text-muted-foreground">{tool.reason}</p>
              )}
            </div>
          ))}
          {inspection.limitations.map((limitation, index) => (
            <p key={index} className="text-xs leading-5 text-muted-foreground">
              {limitation}
            </p>
          ))}
        </div>
      )}
      {toast && visible && (
        <SettingsToast
          key={toast.id}
          message={toast.message}
          onDismiss={() => setToast(null)}
        />
      )}
    </AccessSection>
  );
}
