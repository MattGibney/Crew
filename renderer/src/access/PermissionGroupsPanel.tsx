import { ChevronDown as DisclosureChevronDown } from "lucide-react";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { useId, useState } from "react";
import type {
  Agent,
  CrewPermission,
  PermissionGroup,
  ServiceCapability,
  ServiceConnectionView,
  Skill,
} from "../../../src/agents/contracts.mjs";
import { groupWorkspaceChoices } from "./workspace-choices";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type {
  CrewPermissionChoice,
  GroupDraft,
  GroupSave,
  OwnerPanelProps,
  WorkspacePermissionChoice,
} from "./types";
import {
  AccessSection,
  Choice,
  ErrorMessage,
  FormActions,
  OwnerRequired,
  useAccessAction,
} from "./shared";

export interface PermissionGroupsPanelProps extends OwnerPanelProps {
  groups: readonly PermissionGroup[];
  skills?: readonly Skill[];
  connections: readonly ServiceConnectionView[];
  capabilities: readonly ServiceCapability[];
  crewCapabilities: readonly CrewPermissionChoice[];
  agents: readonly Agent[];
  workspaces?: readonly WorkspacePermissionChoice[];
  onSave: (change: GroupSave) => Promise<void>;
}

export function PermissionGroupsPanel(props: PermissionGroupsPanelProps) {
  return props.isOwner ? (
    <PermissionGroupsContent {...props} />
  ) : (
    <OwnerRequired />
  );
}

function PermissionGroupsContent(props: PermissionGroupsPanelProps) {
  const [editing, setEditing] = useState<PermissionGroup | "new" | null>(null);
  return (
    <AccessSection
      title="Permission groups"
      description="Assign groups to agents to enable their capabilities. Multiple groups add permissions together. Groups also select the skills and service identities available to their members."
      action={
        <Button disabled={editing !== null} onClick={() => setEditing("new")}>
          Create group
        </Button>
      }
    >
      {editing === "new" && (
        <GroupEditor {...props} group={null} onClose={() => setEditing(null)} />
      )}
      <div className="divide-y">
        {props.groups.length === 0 && (
          <p className="py-5 text-sm text-muted-foreground">
            No permission groups yet.
          </p>
        )}
        {props.groups.map((group) => (
          <div key={group.id} className="py-5">
            {editing !== "new" && editing?.id === group.id ? (
              <GroupEditor
                {...props}
                group={editing}
                onClose={() => setEditing(null)}
              />
            ) : (
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 space-y-1">
                  <h3 className="break-words text-sm font-medium">
                    {group.name}
                  </h3>
                  <p className="break-words text-sm text-muted-foreground">
                    {group.description || "No description"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {group.grants.crew.length} Crew permissions ·{" "}
                    {group.grants.services.reduce(
                      (count, service) => count + service.capabilities.length,
                      0,
                    )}{" "}
                    service capabilities ·{" "}
                    {groupWorkspaceChoices(props.workspaces ?? []).filter(
                      (workspace) =>
                        workspace.policyIds.some((id) =>
                          group.grants.environmentPolicyIds.includes(id),
                        ),
                    ).length +
                      group.grants.environmentPolicyIds.filter(
                        (id) =>
                          !(props.workspaces ?? []).some(
                            (workspace) => workspace.policy.id === id,
                          ),
                      ).length}{" "}
                    workspaces
                  </p>
                </div>
                <Button
                  variant="link"
                  disabled={editing !== null}
                  aria-label={`Update ${group.name}`}
                  onClick={() => setEditing(group)}
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

function GroupEditor({
  group,
  onClose,
  ...props
}: PermissionGroupsPanelProps & {
  group: PermissionGroup | null;
  onClose: () => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<GroupDraft>(() =>
    group
      ? structuredClone({
          name: group.name,
          description: group.description,
          grants: group.grants,
        })
      : {
          name: "",
          description: "",
          grants: { crew: [], services: [], environmentPolicyIds: [] },
        },
  );
  const action = useAccessAction(props.onNotify);
  const setCrew = (
    actionId: CrewPermission["action"],
    permission: CrewPermission | null,
  ) =>
    setDraft((current) => ({
      ...current,
      grants: {
        ...current.grants,
        crew: [
          ...current.grants.crew.filter((item) => item.action !== actionId),
          ...(permission ? [permission] : []),
        ],
      },
    }));
  function setCapability(
    connectionId: string,
    capabilityId: string,
    selected: boolean,
  ) {
    setDraft((current) => {
      const previous =
        current.grants.services.find(
          (item) => item.connectionId === connectionId,
        )?.capabilities ?? [];
      const capabilities = selected
        ? [...new Set([...previous, capabilityId])]
        : previous.filter((value) => value !== capabilityId);
      return {
        ...current,
        grants: {
          ...current.grants,
          services: [
            ...current.grants.services.filter(
              (item) => item.connectionId !== connectionId,
            ),
            ...(capabilities.length ? [{ connectionId, capabilities }] : []),
          ],
        },
      };
    });
  }
  const unknownServices = draft.grants.services.flatMap((service) =>
    service.capabilities
      .filter(
        (capability) =>
          !props.capabilities.some(
            (item) =>
              item.id === capability &&
              item.connectionId === service.connectionId,
          ),
      )
      .map((capability) => ({
        connectionId: service.connectionId,
        capability,
      })),
  );
  const workspaces = groupWorkspaceChoices(props.workspaces ?? []);
  const setWorkspace = (policyIds: readonly string[], selected: boolean) =>
    setDraft((current) => ({
      ...current,
      grants: {
        ...current.grants,
        environmentPolicyIds: selected
          ? policyIds.some((id) =>
              current.grants.environmentPolicyIds.includes(id),
            )
            ? current.grants.environmentPolicyIds
            : [...current.grants.environmentPolicyIds, policyIds[0]]
          : current.grants.environmentPolicyIds.filter(
              (id) => !policyIds.includes(id),
            ),
      },
    }));
  return (
    <form
      className="space-y-5"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!draft.name.trim()) return;
        const saved = await action.run(
          () =>
            props.onSave({
              id: group?.id ?? null,
              expectedRevision: group?.revision ?? null,
              draft: {
                ...draft,
                name: draft.name.trim(),
                description: draft.description.trim(),
              },
            }),
          "Permission group saved.",
          "Could not save this group. Refresh its current permissions and try again.",
        );
        if (saved) onClose();
      }}
    >
      {group &&
        props.groups.find((row) => row.id === group.id)?.revision !==
          group.revision && (
          <p role="alert" className="text-sm text-destructive">
            This group changed while you were editing. Your draft is retained.
            Cancel and reopen Update to use the current revision.
          </p>
        )}
      <fieldset disabled={action.busy} className="space-y-5">
        <legend className="mb-4 text-sm font-semibold">
          {group ? `Update ${group.name}` : "Create permission group"}
        </legend>
        <div className="space-y-2">
          <Label htmlFor={`${id}-name`}>Name</Label>
          <Input
            id={`${id}-name`}
            required
            maxLength={120}
            value={draft.name}
            onChange={(event) =>
              setDraft({ ...draft, name: event.target.value })
            }
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${id}-description`}>Description</Label>
          <Textarea
            id={`${id}-description`}
            maxLength={2000}
            value={draft.description}
            onChange={(event) =>
              setDraft({ ...draft, description: event.target.value })
            }
          />
        </div>
        <fieldset className="space-y-3 border-t pt-4">
          <legend className="text-sm font-medium">Project skills</legend>
          <p className="text-xs text-muted-foreground">
            Members inherit these skills. Explicit Restart refreshes native
            skill discovery; saving never starts work.
          </p>
          {(props.skills ?? []).map((skill) => (
            <Choice
              key={skill.id}
              checked={(draft.grants.skillIds ?? []).includes(skill.id)}
              onChange={(checked) =>
                setDraft((current) => ({
                  ...current,
                  grants: {
                    ...current.grants,
                    skillIds: checked
                      ? [
                          ...new Set([
                            ...(current.grants.skillIds ?? []),
                            skill.id,
                          ]),
                        ]
                      : (current.grants.skillIds ?? []).filter(
                          (id) => id !== skill.id,
                        ),
                  },
                }))
              }
              description={skill.description}
            >
              {skill.name}
            </Choice>
          ))}
          {(draft.grants.skillIds ?? [])
            .filter(
              (id) => !(props.skills ?? []).some((skill) => skill.id === id),
            )
            .map((id) => (
              <Choice
                key={id}
                checked
                onChange={() =>
                  setDraft((current) => ({
                    ...current,
                    grants: {
                      ...current.grants,
                      skillIds: (current.grants.skillIds ?? []).filter(
                        (value) => value !== id,
                      ),
                    },
                  }))
                }
                description="Unavailable project skill; retained until explicitly removed."
              >
                {id}
              </Choice>
            ))}
        </fieldset>
        <fieldset className="space-y-3">
          <legend className="mb-2 text-sm font-medium">
            Service capabilities
          </legend>
          {props.capabilities.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No discovered capabilities are available. Connect a service and
              refresh its catalogue first.
            </p>
          )}
          {props.connections.map((connection) => {
            const capabilities = props.capabilities.filter(
              (item) => item.connectionId === connection.id,
            );
            if (!capabilities.length) return null;
            return (
              <div key={connection.id} className="border-t pt-3">
                <h4 className="text-sm font-medium">
                  {connection.name} · {connection.identity.displayName}
                </h4>
                {capabilities.map((capability) => (
                  <Choice
                    key={capability.id}
                    checked={draft.grants.services.some(
                      (item) =>
                        item.connectionId === connection.id &&
                        item.capabilities.includes(capability.id),
                    )}
                    onChange={(checked) =>
                      setCapability(connection.id, capability.id, checked)
                    }
                    description={
                      <>
                        {capability.description}
                        <span className="block font-mono">{capability.id}</span>
                      </>
                    }
                  >
                    {capability.upstreamName}
                  </Choice>
                ))}
              </div>
            );
          })}
          {unknownServices.map(({ connectionId, capability }) => (
            <div
              key={`${connectionId}:${capability}`}
              className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"
            >
              <span className="break-all">
                {capability} · unavailable in the current catalogue; retained
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setCapability(connectionId, capability, false)}
              >
                Remove
              </Button>
            </div>
          ))}
          <p className="text-xs leading-5 text-muted-foreground">
            A group capability permits all schema-valid arguments for that
            operation. Use an access request for a narrower, individually
            approved scope.
          </p>
        </fieldset>
        <Collapsible className="border-t pt-4">
          <CollapsibleTrigger
            type="button"
            className="group flex w-full items-center gap-2 text-left cursor-pointer text-sm font-medium"
          >
            <DisclosureChevronDown
              className="size-4 shrink-0 transition-transform group-aria-expanded:rotate-180"
              aria-hidden="true"
            />
            Crew permissions
          </CollapsibleTrigger>
          <CollapsibleContent keepMounted>
            <div className="mt-3 space-y-3">
              {props.crewCapabilities.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  The Crew permission catalogue is unavailable. Existing
                  permissions are retained.
                </p>
              )}
              {props.crewCapabilities.map((choice) => {
                const permission = draft.grants.crew.find(
                  (item) => item.action === choice.action,
                );
                return (
                  <div key={choice.action}>
                    <Choice
                      checked={!!permission}
                      onChange={(checked) =>
                        setCrew(
                          choice.action,
                          checked ? { action: choice.action } : null,
                        )
                      }
                      description={choice.description}
                    >
                      {choice.label}
                    </Choice>
                  </div>
                );
              })}
              {draft.grants.crew
                .filter(
                  (permission) =>
                    !props.crewCapabilities.some(
                      (choice) => choice.action === permission.action,
                    ),
                )
                .map((permission) => (
                  <p
                    key={permission.action}
                    className="break-words text-xs text-muted-foreground"
                  >
                    {permission.action} · existing permission retained
                  </p>
                ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
        <fieldset className="space-y-3 border-t pt-4">
          <legend className="text-sm font-medium">Workspaces</legend>
          <p className="text-sm text-muted-foreground">
            Choose the approved folders agents in this group can use. Configure
            folders in Workspace settings.
          </p>
          {workspaces.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No approved workspaces are available.
            </p>
          )}
          {workspaces.map((workspace) => (
            <Choice
              key={workspace.policy.id}
              checked={workspace.policyIds.some((id) =>
                draft.grants.environmentPolicyIds.includes(id),
              )}
              onChange={(checked) => setWorkspace(workspace.policyIds, checked)}
              description={workspace.description}
            >
              {workspace.label}
            </Choice>
          ))}
          {draft.grants.environmentPolicyIds
            .filter(
              (id) =>
                !workspaces.some((workspace) =>
                  workspace.policyIds.includes(id),
                ),
            )
            .map((id) => (
              <div
                key={id}
                className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"
              >
                <span className="break-all">
                  {id} · workspace unavailable; existing permission retained
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setWorkspace([id], false)}
                >
                  Remove
                </Button>
              </div>
            ))}
        </fieldset>
      </fieldset>
      <ErrorMessage>{action.error}</ErrorMessage>
      <FormActions
        busy={action.busy}
        disabled={!draft.name.trim()}
        onCancel={onClose}
      />
    </form>
  );
}
