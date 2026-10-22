import { useId, useState } from "react";
import type {
  Agent,
  AgentCreationPreset,
  PermissionGroup,
  ServiceConnectionView,
} from "../../../src/agents/contracts.mjs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import {
  AccessSection,
  Choice,
  ErrorMessage,
  FormActions,
  OwnerRequired,
  useAccessAction,
} from "./shared";
import type { OwnerPanelProps } from "./types";

type PresetDraft = Omit<AgentCreationPreset, "id" | "projectId" | "revision">;
export interface CreationPresetsPanelProps extends OwnerPanelProps {
  presets: AgentCreationPreset[];
  creationDefaults: { revision: number; presetId: string | null };
  agents: Agent[];
  groups: PermissionGroup[];
  connections: ServiceConnectionView[];
  onSave(change: {
    id: string | null;
    expectedRevision: number | null;
    draft: PresetDraft;
  }): Promise<void>;
  onSetDefault(
    presetId: string | null,
    expectedRevision: number,
  ): Promise<void>;
}
export function CreationPresetsPanel(props: CreationPresetsPanelProps) {
  const [editing, setEditing] = useState<AgentCreationPreset | "new" | null>(
    null,
  );
  const action = useAccessAction(props.onNotify);
  const id = useId();
  if (!props.isOwner) return <OwnerRequired />;
  return (
    <AccessSection
      title="New agent presets"
      description="Approve a profile, groups and service identities that a manager may apply when creating a new agent. Managers cannot edit these approvals or grant themselves access."
      action={
        <Button
          variant="outline"
          disabled={editing !== null || !props.agents.length}
          onClick={() => setEditing("new")}
        >
          Create preset
        </Button>
      }
    >
      {!props.agents.length && (
        <p className="text-sm text-muted-foreground">
          Create the primary agent first. Its supported runtime and skills can
          then be used as the starting point for a preset.
        </p>
      )}
      <div className="space-y-2">
        <Label htmlFor={`${id}-default`}>Default for new agents</Label>
        <NativeSelect
          id={`${id}-default`}
          value={props.creationDefaults.presetId ?? ""}
          disabled={action.busy}
          onChange={(event) =>
            void action.run(
              () =>
                props.onSetDefault(
                  event.target.value || null,
                  props.creationDefaults.revision,
                ),
              "Creation default saved.",
              "Could not change the default. Refresh and try again.",
            )
          }
        >
          <option value="">No automatic default</option>
          {props.presets.map((preset) => (
            <option
              key={preset.id}
              value={preset.id}
              disabled={!preset.enabled}
            >
              {preset.name}
              {preset.enabled ? "" : " (disabled)"}
            </option>
          ))}
        </NativeSelect>
        <ErrorMessage>{action.error}</ErrorMessage>
      </div>
      {editing === "new" && (
        <PresetEditor
          {...props}
          preset={null}
          onClose={() => setEditing(null)}
        />
      )}
      <div className="divide-y border-y">
        {!props.presets.length && (
          <p className="py-4 text-sm text-muted-foreground">
            No approved presets yet.
          </p>
        )}
        {props.presets.map((preset) => (
          <div key={preset.id} className="py-4">
            {editing !== "new" && editing?.id === preset.id ? (
              <PresetEditor
                {...props}
                preset={editing}
                onClose={() => setEditing(null)}
              />
            ) : (
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-medium">{preset.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {preset.enabled ? "Available" : "Disabled"} ·{" "}
                    {preset.permissionGroupIds.length} groups ·{" "}
                    {preset.serviceConnectionIds.length} connections
                  </p>
                </div>
                <Button
                  variant="link"
                  disabled={editing !== null}
                  onClick={() => setEditing(preset)}
                >
                  Update
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </AccessSection>
  );
}
function PresetEditor({
  preset,
  onClose,
  ...props
}: CreationPresetsPanelProps & {
  preset: AgentCreationPreset | null;
  onClose(): void;
}) {
  const id = useId();
  const first = props.agents[0];
  const [draft, setDraft] = useState<PresetDraft>(() =>
    preset
      ? {
          name: preset.name,
          enabled: preset.enabled,
          profile: structuredClone(preset.profile),
          skills: structuredClone(preset.skills),
          modelAccessId: preset.modelAccessId,
          configRef: preset.configRef,
          permissionGroupIds: [...preset.permissionGroupIds],
          serviceConnectionIds: [...preset.serviceConnectionIds],
        }
      : {
          name: "",
          enabled: true,
          profile: { ...first.profile },
          skills: structuredClone(first.skills),
          modelAccessId: first.runtime.modelAccessId,
          configRef: first.runtime.configRef,
          permissionGroupIds: [],
          serviceConnectionIds: [],
        },
  );
  const action = useAccessAction(props.onNotify);
  const toggle = (
    field: "permissionGroupIds" | "serviceConnectionIds",
    value: string,
    checked: boolean,
  ) =>
    setDraft((current) => ({
      ...current,
      [field]: checked
        ? [...current[field], value]
        : current[field].filter((item) => item !== value),
    }));
  return (
    <form
      className="space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        const { name, pictureRef, personality, systemPrompt } = draft.profile;
        if (
          await action.run(
            () =>
              props.onSave({
                id: preset?.id ?? null,
                expectedRevision: preset?.revision ?? null,
                draft: {
                  ...draft,
                  profile: { name, pictureRef, personality, systemPrompt },
                },
              }),
            "Creation preset saved.",
            "Could not save the preset. Refresh its current revision and references.",
          )
        )
          onClose();
      }}
    >
      {preset &&
        props.presets.find((row) => row.id === preset.id)?.revision !==
          preset.revision && (
          <p role="alert" className="text-sm text-destructive">
            The saved preset changed. Your draft is retained. Cancel and reopen
            Update before saving.
          </p>
        )}
      <fieldset disabled={action.busy} className="space-y-4">
        <legend className="font-medium">
          {preset ? `Update ${preset.name}` : "Create preset"}
        </legend>
        <div>
          <Label htmlFor={`${id}-name`}>Preset name</Label>
          <Input
            id={`${id}-name`}
            required
            value={draft.name}
            onChange={(event) =>
              setDraft({ ...draft, name: event.target.value })
            }
          />
        </div>
        {!preset && (
          <div>
            <Label htmlFor={`${id}-template`}>
              Start from an existing agent
            </Label>
            <NativeSelect
              id={`${id}-template`}
              defaultValue={first.id}
              onChange={(event) => {
                const agent = props.agents.find(
                  (row) => row.id === event.target.value,
                );
                if (agent)
                  setDraft((current) => ({
                    ...current,
                    profile: {
                      name: agent.profile.name,
                      pictureRef: agent.profile.pictureRef,
                      personality: agent.profile.personality,
                      systemPrompt: agent.profile.systemPrompt,
                    },
                    skills: structuredClone(agent.skills),
                    modelAccessId: agent.runtime.modelAccessId,
                    configRef: agent.runtime.configRef,
                  }));
              }}
            >
              {props.agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.profile.name}
                </option>
              ))}
            </NativeSelect>
            <p className="mt-1 text-xs text-muted-foreground">
              Copies the profile, selected skills and supported runtime. Choose
              access separately below.
            </p>
          </div>
        )}
        <div>
          <Label htmlFor={`${id}-agent-name`}>Default agent name</Label>
          <Input
            id={`${id}-agent-name`}
            required
            value={draft.profile.name}
            onChange={(event) =>
              setDraft({
                ...draft,
                profile: { ...draft.profile, name: event.target.value },
              })
            }
          />
        </div>
        <div>
          <Label htmlFor={`${id}-personality`}>Personality</Label>
          <Textarea
            id={`${id}-personality`}
            value={draft.profile.personality}
            onChange={(event) =>
              setDraft({
                ...draft,
                profile: { ...draft.profile, personality: event.target.value },
              })
            }
          />
        </div>
        <div>
          <Label htmlFor={`${id}-instructions`}>Instructions</Label>
          <Textarea
            id={`${id}-instructions`}
            rows={6}
            value={draft.profile.systemPrompt}
            onChange={(event) =>
              setDraft({
                ...draft,
                profile: { ...draft.profile, systemPrompt: event.target.value },
              })
            }
          />
        </div>
        <Choice
          checked={draft.enabled}
          onChange={(enabled) => setDraft({ ...draft, enabled })}
        >
          Available for new agents
        </Choice>
        <div>
          <p className="font-medium text-sm">Permission groups</p>
          {props.groups.map((group) => (
            <Choice
              key={group.id}
              checked={draft.permissionGroupIds.includes(group.id)}
              onChange={(checked) =>
                toggle("permissionGroupIds", group.id, checked)
              }
              description={group.description}
            >
              {group.name}
            </Choice>
          ))}
        </div>
        <div>
          <p className="font-medium text-sm">Service identities</p>
          {props.connections.map((connection) => (
            <Choice
              key={connection.id}
              checked={draft.serviceConnectionIds.includes(connection.id)}
              onChange={(checked) =>
                toggle("serviceConnectionIds", connection.id, checked)
              }
            >
              {connection.name} · {connection.identity.displayName}
            </Choice>
          ))}
        </div>
      </fieldset>
      <ErrorMessage>{action.error}</ErrorMessage>
      <FormActions
        busy={action.busy}
        disabled={!draft.name.trim() || !draft.profile.name.trim()}
        onCancel={onClose}
      />
    </form>
  );
}
