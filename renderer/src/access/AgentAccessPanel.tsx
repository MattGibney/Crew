import { useState } from "react";
import type {
  Agent,
  PermissionGroup,
  Revision,
  ServiceConnectionView,
} from "../../../src/agents/contracts.mjs";
import { Button } from "@/components/ui/button";
import type { AssignmentSave, OwnerPanelProps } from "./types";
import {
  AccessSection,
  Choice,
  ErrorMessage,
  FormActions,
  OwnerRequired,
  ServiceIdentity,
  useAccessAction,
} from "./shared";

export interface AgentAccessPanelProps extends OwnerPanelProps {
  agent: Agent;
  /** Revision of #89's assignment record, not the agent profile revision. */
  assignmentRevision: Revision | null;
  groups: readonly PermissionGroup[];
  connections: readonly ServiceConnectionView[];
  onSave: (change: AssignmentSave) => Promise<void>;
}

export function AgentAccessPanel(props: AgentAccessPanelProps) {
  return props.isOwner ? (
    <AgentAccessContent key={props.agent.id} {...props} />
  ) : (
    <OwnerRequired />
  );
}

function AgentAccessContent(props: AgentAccessPanelProps) {
  const [draft, setDraft] = useState<AssignmentSave | null>(null);
  const action = useAccessAction(props.onNotify);
  const access = draft ?? props.agent.access;
  return (
    <AccessSection
      title={`Access for ${props.agent.profile.name}`}
      description="Choose group memberships. Skills, service identities and operations derive from these groups."
      action={
        !draft && (
          <Button
            variant="link"
            onClick={() =>
              setDraft({
                agentId: props.agent.id,
                expectedRevision: props.assignmentRevision,
                permissionGroupIds: [...props.agent.access.permissionGroupIds],
              })
            }
          >
            Update
          </Button>
        )
      }
    >
      <form
        className="space-y-5"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!draft) return;
          if (
            await action.run(
              () => props.onSave(draft),
              "Agent access saved.",
              "Could not save agent access. Refresh the current assignments and try again.",
            )
          )
            setDraft(null);
        }}
      >
        {draft && draft.expectedRevision !== props.assignmentRevision && (
          <p role="alert" className="text-sm text-destructive">
            Saved assignments changed while you were editing. Your draft is
            retained. Cancel and reopen Update to use the current revision.
          </p>
        )}
        <fieldset disabled={!draft || action.busy} className="space-y-4">
          <legend className="mb-2 text-sm font-medium">
            Permission groups
          </legend>
          {!props.groups.length && (
            <p className="text-sm text-muted-foreground">
              No groups are available.
            </p>
          )}
          {props.groups.map((group) => (
            <Choice
              key={group.id}
              checked={access.permissionGroupIds.includes(group.id)}
              onChange={(checked) =>
                draft &&
                setDraft({
                  ...draft,
                  permissionGroupIds: checked
                    ? [...draft.permissionGroupIds, group.id]
                    : draft.permissionGroupIds.filter(
                        (value) => value !== group.id,
                      ),
                })
              }
              description={group.description}
            >
              {group.name}
            </Choice>
          ))}
          {access.permissionGroupIds
            .filter((id) => !props.groups.some((group) => group.id === id))
            .map((id) => (
              <Choice
                key={id}
                checked
                onChange={() =>
                  draft &&
                  setDraft({
                    ...draft,
                    permissionGroupIds: draft.permissionGroupIds.filter(
                      (value) => value !== id,
                    ),
                  })
                }
                description="Unavailable group. Remove this membership or refresh to inspect it."
              >
                {id}
              </Choice>
            ))}
        </fieldset>
        <p className="text-xs text-muted-foreground">
          Services and skills follow current group memberships. Revoked service
          availability prevents later calls, including separately approved
          calls. Already admitted operations may finish. Explicit Restart
          refreshes native discovery.
        </p>
        <ErrorMessage>{action.error}</ErrorMessage>
        {draft && (
          <FormActions
            busy={action.busy}
            onCancel={() => {
              setDraft(null);
              action.setError("");
            }}
          />
        )}
      </form>
    </AccessSection>
  );
}
