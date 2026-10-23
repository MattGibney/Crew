import { MoreVertical, Pencil } from "lucide-react";
import {
  Table,
  TableCaption,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  AccessSection,
  Choice,
  ErrorMessage,
  FormActions,
  OwnerRequired,
  useAccessAction,
} from "./shared";
import type { OwnerRuntimeDefaults } from "../../../src/access/owner-contracts.mjs";
import type { OwnerPanelProps } from "./types";

type PresetDraft = Omit<AgentCreationPreset, "id" | "projectId" | "revision">;
export interface CreationPresetsPanelProps extends OwnerPanelProps {
  presets: AgentCreationPreset[];
  creationDefaults: { revision: number; presetId: string | null };
  agents: Agent[];
  runtimeDefaults: OwnerRuntimeDefaults | null;
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
      fullWidth
      title="Available templates"
      description="Approve a profile, groups and service identities that a manager may apply when creating a new agent. Managers cannot edit these approvals or grant themselves access."
      action={
        <Button
          disabled={
            editing !== null || (!props.agents.length && !props.runtimeDefaults)
          }
          onClick={() => setEditing("new")}
        >
          Create template
        </Button>
      }
    >
      {!props.agents.length && (
        <p className="text-sm text-muted-foreground">
          {props.runtimeDefaults
            ? "Create a template to choose the first agent's profile and access. It will use the configured project runtime."
            : "Configure project model access before creating the first template."}
        </p>
      )}
      <div className="max-w-sm space-y-2">
        <Label htmlFor={`${id}-default`}>Default for new agents</Label>
        <Select
          value={props.creationDefaults.presetId ?? ""}
          disabled={action.busy}
          onValueChange={(selectedValue) =>
            void action.run(
              () =>
                props.onSetDefault(
                  (selectedValue ?? "") || null,
                  props.creationDefaults.revision,
                ),
              "Default template saved.",
              "Could not change the default. Refresh and try again.",
            )
          }
          items={[
            { value: "", label: "No automatic default" },
            ...props.presets.map((preset) => ({
              value: preset.id,
              label: `${preset.name}${preset.enabled ? "" : " (disabled)"}`,
            })),
          ]}
        >
          <SelectTrigger id={`${id}-default`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">No automatic default</SelectItem>
            {props.presets.map((preset) => (
              <SelectItem
                key={preset.id}
                value={preset.id}
                disabled={!preset.enabled}
              >
                {preset.name}
                {preset.enabled ? "" : " (disabled)"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ErrorMessage>{action.error}</ErrorMessage>
      </div>
      {editing && (
        <PresetEditor
          key={editing === "new" ? "new" : editing.id}
          {...props}
          preset={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      <div className="overflow-x-auto rounded-lg border">
        <Table className="w-full text-left text-sm">
          <TableCaption className="sr-only">
            Agent templates and their starting configuration
          </TableCaption>
          <TableHeader className="border-b bg-muted/30 text-xs text-muted-foreground">
            <TableRow>
              <TableHead className="px-4 py-3 font-medium">Template</TableHead>
              <TableHead className="px-4 py-3 font-medium">Status</TableHead>
              <TableHead className="px-4 py-3 font-medium">Groups</TableHead>
              <TableHead className="px-4 py-3 font-medium">
                Connections
              </TableHead>
              <TableHead className="px-4 py-3 font-medium">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="divide-y">
            {!props.presets.length && (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="px-4 py-8 text-muted-foreground"
                >
                  No agent templates yet.
                </TableCell>
              </TableRow>
            )}
            {props.presets.map((preset) => (
              <TableRow key={preset.id}>
                <TableCell className="px-4 py-3 font-medium">
                  <span className="flex items-center gap-2">
                    {preset.name}
                    {props.creationDefaults.presetId === preset.id && (
                      <Badge variant="secondary">Default</Badge>
                    )}
                  </span>
                </TableCell>
                <TableCell className="px-4 py-3 text-muted-foreground">
                  {preset.enabled ? "Available" : "Disabled"}
                </TableCell>
                <TableCell className="px-4 py-3 tabular-nums text-muted-foreground">
                  {preset.permissionGroupIds.length}
                </TableCell>
                <TableCell className="px-4 py-3 tabular-nums text-muted-foreground">
                  {preset.serviceConnectionIds.length}
                </TableCell>
                <TableCell className="px-4 py-3 text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Actions for ${preset.name}`}
                          disabled={editing !== null}
                        />
                      }
                    >
                      <MoreVertical className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        aria-label={`Edit ${preset.name}`}
                        onClick={() => setEditing(preset)}
                      >
                        <Pencil className="size-4" />
                        Edit
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
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
          profile: first
            ? {
                name: first.profile.name,
                pictureRef: first.profile.pictureRef,
                personality: first.profile.personality,
                systemPrompt: first.profile.systemPrompt,
              }
            : { name: "", pictureRef: null, personality: "", systemPrompt: "" },
          skills: first ? structuredClone(first.skills) : [],
          modelAccessId:
            first?.runtime.modelAccessId ??
            props.runtimeDefaults!.modelAccessId,
          configRef:
            first?.runtime.configRef ?? props.runtimeDefaults!.configRef,
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
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !action.busy) onClose();
      }}
    >
      <DialogContent
        className="flex max-h-[85dvh] flex-col sm:max-w-2xl"
        showCloseButton={!action.busy}
      >
        <DialogHeader>
          <DialogTitle>
            {preset ? "Edit template" : "Create template"}
          </DialogTitle>
          <DialogDescription>
            {preset
              ? `Configure ${preset.name}.`
              : "Choose the starting profile and groups for new agents."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-col gap-5"
          onSubmit={async (event) => {
            event.preventDefault();
            const { name, pictureRef, personality, systemPrompt } =
              draft.profile;
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
                "Agent template saved.",
                "Could not save the template. Refresh its current revision and references.",
              )
            )
              onClose();
          }}
        >
          <div className="min-h-0 space-y-4 overflow-y-auto px-1">
            {preset &&
              props.presets.find((row) => row.id === preset.id)?.revision !==
                preset.revision && (
                <p role="alert" className="text-sm text-destructive">
                  The saved template changed. Your draft is retained. Cancel and
                  reopen Edit before saving.
                </p>
              )}
            <fieldset disabled={action.busy} className="space-y-4">
              <legend className="sr-only">
                {preset ? `Update ${preset.name}` : "Create template"}
              </legend>
              <div>
                <Label htmlFor={`${id}-name`}>Template name</Label>
                <Input
                  id={`${id}-name`}
                  required
                  value={draft.name}
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value })
                  }
                />
              </div>
              {!preset && first && (
                <div>
                  <Label htmlFor={`${id}-template`}>
                    Start from an existing agent
                  </Label>
                  <Select
                    defaultValue={first.id}
                    onValueChange={(selectedValue) => {
                      const agent = props.agents.find(
                        (row) => row.id === (selectedValue ?? ""),
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
                    items={props.agents.map((agent) => ({
                      value: agent.id,
                      label: agent.profile.name,
                    }))}
                  >
                    <SelectTrigger id={`${id}-template`} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {props.agents.map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>
                          {agent.profile.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Copies the profile and supported runtime. Skills and
                    services derive from groups. Choose access separately below.
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
                      profile: {
                        ...draft.profile,
                        personality: event.target.value,
                      },
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
                      profile: {
                        ...draft.profile,
                        systemPrompt: event.target.value,
                      },
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
            </fieldset>
            <ErrorMessage>{action.error}</ErrorMessage>
          </div>
          <DialogFooter>
            <FormActions
              label={preset ? "Save changes" : "Create template"}
              busy={action.busy}
              disabled={!draft.name.trim() || !draft.profile.name.trim()}
              onCancel={onClose}
            />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
