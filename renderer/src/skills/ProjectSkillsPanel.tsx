import { ChevronDown as DisclosureChevronDown } from "lucide-react";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SettingsToast } from "../manager/settings/SettingsToast";
import type { Skill } from "../../../src/agents/contracts.mjs";
import type {
  SkillDocument,
  SkillResource,
} from "../../../src/skills/types.mjs";
import { skillErrorMessage, type ProjectSkillsClient } from "./client";

interface Draft {
  base: SkillDocument | null;
  markdown: string;
  resources: SkillResource[];
  stale: boolean;
}
const initialMarkdown =
  "---\nname: my-skill\ndescription: Describe when this project skill should be used.\n---\n\nWrite the reusable instructions here.\n";
const signature = (draft: Pick<Draft, "markdown" | "resources">) =>
  JSON.stringify([draft.markdown, draft.resources]);
const fromSaved = (base: SkillDocument): Draft => ({
  base,
  markdown: base.markdown,
  resources: base.resources,
  stale: false,
});
const dirty = (draft: Draft) =>
  !draft.base || signature(draft) !== signature(draft.base);

export interface ProjectSkillsPanelProps {
  client: ProjectSkillsClient;
  /** Keep this component mounted while hidden to preserve all editing drafts. */
  visible?: boolean;
  onNotify?: (message: string) => void;
}

export function ProjectSkillsPanel({
  client,
  visible = true,
  onNotify,
}: ProjectSkillsPanelProps) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const alive = useRef(true),
    generation = useRef(0),
    saveLock = useRef(false);
  const readGenerations = useRef(new Map<string, number>());
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;

  const loadSelected = useCallback(
    async (id: string, discard = false) => {
      const request = (readGenerations.current.get(id) ?? 0) + 1;
      readGenerations.current.set(id, request);
      const before = draftsRef.current[id];
      const saved = await client.read(id);
      if (!alive.current || readGenerations.current.get(id) !== request) return;
      setDrafts((current) => {
        const draft = current[id];
        if (draft?.base && draft.base.skill.revision > saved.skill.revision)
          return current;
        const changedDuringRead =
          draft && before && signature(draft) !== signature(before);
        if ((!discard || changedDuringRead) && draft && dirty(draft))
          return {
            ...current,
            [id]: {
              ...draft,
              stale: draft.base?.skill.revision !== saved.skill.revision,
            },
          };
        return { ...current, [id]: fromSaved(saved) };
      });
    },
    [client],
  );

  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    try {
      const next = await client.list();
      if (!alive.current || request !== generation.current) return;
      setSkills(next);
      setDrafts((current) =>
        Object.fromEntries(
          Object.entries(current).map(([id, draft]) => {
            if (!draft.base) return [id, draft];
            const saved = next.find((skill) => skill.id === id);
            return [
              id,
              {
                ...draft,
                stale: !saved || draft.base.skill.revision !== saved.revision,
              },
            ];
          }),
        ),
      );
      const id = selectedRef.current;
      if (id && id !== "new" && next.some((skill) => skill.id === id))
        await loadSelected(id);
    } catch (cause) {
      if (alive.current && request === generation.current)
        setError(skillErrorMessage(cause));
    } finally {
      if (alive.current && request === generation.current) setLoading(false);
    }
  }, [client, loadSelected]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    if (visible) void refresh();
  }, [visible, refresh]);
  useEffect(
    () =>
      client.subscribe?.(() => {
        if (visible) void refresh();
      }),
    [client, visible, refresh],
  );

  const draft = selected ? drafts[selected] : null;
  const edit = (update: (current: Draft) => Draft) => {
    if (!selected) return;
    setDrafts((current) =>
      current[selected]
        ? { ...current, [selected]: update(current[selected]) }
        : current,
    );
    setNotice("");
  };
  async function openSkill(id: string) {
    setSelected(id);
    setError("");
    setNotice("");
    try {
      await loadSelected(id);
    } catch (cause) {
      setError(skillErrorMessage(cause));
    }
  }
  function newSkill() {
    setDrafts((current) =>
      current.new
        ? current
        : {
            ...current,
            new: {
              base: null,
              markdown: initialMarkdown,
              resources: [],
              stale: false,
            },
          },
    );
    setSelected("new");
    setError("");
    setNotice("");
  }
  async function save() {
    if (!selected || !draft || saveLock.current) return;
    const key = selected,
      submitted = structuredClone(draft);
    saveLock.current = true;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const input = {
        markdown: submitted.markdown,
        resources: submitted.resources,
      };
      const saved = submitted.base
        ? await client.update({
            ...input,
            skillId: submitted.base.skill.id,
            expectedRevision: submitted.base.skill.revision,
          })
        : await client.create(input);
      if (!alive.current) return;
      generation.current++;
      setLoading(false);
      setDrafts((current) => {
        const latest = current[key];
        const next = { ...current };
        if (key === "new") delete next.new;
        next[saved.skill.id] =
          latest && signature(latest) !== signature(submitted)
            ? { ...latest, base: saved, stale: false }
            : fromSaved(saved);
        return next;
      });
      if (selectedRef.current === key) setSelected(saved.skill.id);
      setSkills((current) => [
        ...current.filter((skill) => skill.id !== saved.skill.id),
        saved.skill,
      ]);
      const message =
        "Skill saved. Started agents keep their applied version until Restart.";
      setNotice(message);
      onNotify?.(message);
    } catch (cause) {
      if (alive.current) {
        setError(skillErrorMessage(cause));
        if (submitted.base) await refresh();
      }
    } finally {
      saveLock.current = false;
      if (alive.current) setSaving(false);
    }
  }

  return (
    <section
      hidden={!visible}
      aria-label="Project skills"
      className="min-w-0 space-y-10 pb-8"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            Project skills
          </h2>
          <p className="mt-1 max-w-prose text-sm leading-6 text-muted-foreground">
            Reusable instructions for this project's agents. Skills do not grant
            permissions or connect accounts.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              setError("");
              void refresh();
            }}
            disabled={loading}
          >
            <RefreshCw className={loading ? "animate-spin" : ""} />
            <span className="sr-only sm:not-sr-only">Refresh</span>
          </Button>
          <Button onClick={newSkill}>
            <Plus />
            New skill
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!onNotify && notice && (
        <SettingsToast message={notice} onDismiss={() => setNotice("")} />
      )}
      <div className="min-w-0 space-y-6">
        <div aria-label="Saved project skills" className="min-w-0">
          {!skills.length && (
            <p className="py-3 text-sm text-muted-foreground">
              {loading ? "Loading skills…" : "No saved skills yet."}
            </p>
          )}
          {skills.map((skill) => (
            <div key={skill.id}>
              <Separator />
              <div className="flex min-w-0 items-start justify-between gap-4 py-5">
                <div className="min-w-0 break-words">
                  <p className="text-sm font-medium">{skill.name}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {skill.description}
                  </p>
                  {drafts[skill.id] && dirty(drafts[skill.id]) && (
                    <span className="block text-xs text-muted-foreground">
                      Unsaved draft
                    </span>
                  )}
                </div>
                <Button
                  type="button"
                  variant="link"
                  className="h-auto shrink-0 p-0 text-sm font-semibold"
                  aria-label={`Update ${skill.name}`}
                  onClick={() => void openSkill(skill.id)}
                >
                  Edit
                </Button>
              </div>
            </div>
          ))}
          {drafts.new && (
            <Button
              variant="ghost"
              className="w-full justify-start"
              onClick={() => setSelected("new")}
            >
              New skill draft
            </Button>
          )}
        </div>
        {selected && draft ? (
          <form
            className="min-w-0 space-y-6"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="font-medium">
                {draft.base?.skill.name ?? "New skill"}
              </h3>
              {draft.base && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={saving}
                  onClick={() => {
                    setError("");
                    void loadSelected(selected, true).catch((cause) =>
                      setError(skillErrorMessage(cause)),
                    );
                  }}
                >
                  {dirty(draft)
                    ? "Discard draft and reload"
                    : "Reload saved version"}
                </Button>
              )}
            </div>
            {draft.stale && (
              <Alert>
                <AlertDescription>
                  The saved skill changed while this editor was open. Your draft
                  is preserved. Copy any changes you want to keep, then discard
                  the draft and reload before saving.
                </AlertDescription>
              </Alert>
            )}
            <div className="space-y-2">
              <Label
                htmlFor="project-skill-markdown"
                className="text-sm font-medium"
              >
                SKILL.md
              </Label>
              <Textarea
                id="project-skill-markdown"
                value={draft.markdown}
                maxLength={131072}
                spellCheck={false}
                className="min-h-80 resize-y font-mono text-xs [field-sizing:fixed]"
                onChange={(event) =>
                  edit((value) => ({ ...value, markdown: event.target.value }))
                }
              />
            </div>
            <Collapsible className="text-sm text-muted-foreground">
              <CollapsibleTrigger
                type="button"
                className="group flex w-full items-center gap-2 text-left cursor-pointer font-medium text-foreground"
              >
                <DisclosureChevronDown
                  className="size-4 shrink-0 transition-transform group-aria-expanded:rotate-180"
                  aria-hidden="true"
                />
                Writing a skill
              </CollapsibleTrigger>
              <CollapsibleContent keepMounted>
                <div className="mt-3 space-y-2 leading-6">
                  <p>
                    Keep the YAML name and description between the opening ---
                    lines. Use a short lowercase name with hyphens, and describe
                    when the skill should be used. Put reusable instructions
                    below the metadata.
                  </p>
                  <p>
                    Save here or ask a permitted agent to create or edit the
                    same project skill. Select it in an agent's profile, then
                    Start or Restart that agent. Saving does not replace
                    instructions already loaded by an active session.
                  </p>
                  <p>
                    Files remain in Crew's project storage, outside personal
                    Codex folders and source repositories. Limit: 128 KiB
                    instructions, 64 text resources of up to 256 KiB each, and 2
                    MiB total. Binary resource upload is not supported.
                  </p>
                </div>
              </CollapsibleContent>
            </Collapsible>
            <Separator />
            <div className="space-y-5">
              <div className="flex items-center justify-between gap-3">
                <h4 className="text-sm font-medium">Supporting resources</h4>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={draft.resources.length >= 64}
                  onClick={() =>
                    edit((value) => ({
                      ...value,
                      resources: [
                        ...value.resources,
                        {
                          path: "references/notes.md",
                          content: "",
                          executable: false,
                        },
                      ],
                    }))
                  }
                >
                  <Plus />
                  Add text file
                </Button>
              </div>
              {draft.resources.map((resource, index) => (
                <div key={index} className="space-y-3 py-4">
                  <Separator />
                  <div className="flex min-w-0 items-center gap-2">
                    <Input
                      aria-label={`Resource ${index + 1} path`}
                      value={resource.path}
                      placeholder="references/notes.md"
                      onChange={(event) =>
                        edit((value) => ({
                          ...value,
                          resources: value.resources.map((item, position) =>
                            position === index
                              ? {
                                  ...item,
                                  path: event.target.value,
                                  executable:
                                    event.target.value.startsWith("scripts/") &&
                                    item.executable === true,
                                }
                              : item,
                          ),
                        }))
                      }
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove resource ${index + 1}`}
                      onClick={() =>
                        edit((value) => ({
                          ...value,
                          resources: value.resources.filter(
                            (_, position) => position !== index,
                          ),
                        }))
                      }
                    >
                      <Trash2 />
                    </Button>
                  </div>
                  <Textarea
                    aria-label={`Resource ${index + 1} content`}
                    value={resource.content}
                    maxLength={262144}
                    spellCheck={false}
                    className="min-h-40 resize-y font-mono text-xs [field-sizing:fixed]"
                    onChange={(event) =>
                      edit((value) => ({
                        ...value,
                        resources: value.resources.map((item, position) =>
                          position === index
                            ? { ...item, content: event.target.value }
                            : item,
                        ),
                      }))
                    }
                  />
                  {resource.path.startsWith("scripts/") && (
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Checkbox
                        checked={resource.executable === true}
                        onCheckedChange={(checked) =>
                          edit((value) => ({
                            ...value,
                            resources: value.resources.map((item, position) =>
                              position === index
                                ? { ...item, executable: checked }
                                : item,
                            ),
                          }))
                        }
                      />
                      Mark this script executable. Execution still requires the
                      agent's access.
                    </label>
                  )}
                </div>
              ))}
              {!draft.resources.length && (
                <p className="text-sm text-muted-foreground">
                  Optional scripts, references, assets and native agent
                  metadata.
                </p>
              )}
            </div>
            <Separator />
            <div className="flex items-center justify-end gap-3">
              <span className="text-xs text-muted-foreground">
                {dirty(draft) ? "Unsaved changes" : "Saved"}
              </span>
              <Button
                type="submit"
                disabled={saving || draft.stale || !dirty(draft)}
              >
                {saving ? "Saving…" : "Save skill"}
              </Button>
            </div>
          </form>
        ) : (
          <div className="py-8 text-sm text-muted-foreground">
            {selected
              ? "Loading skill…"
              : "Choose a skill to inspect or edit, or create a new one."}
          </div>
        )}
      </div>
    </section>
  );
}
