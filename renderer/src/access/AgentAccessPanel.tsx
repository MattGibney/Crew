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
      description="Choose group memberships and the service identities this agent may use. Assigning a connection alone grants no operations."
      action={
        !draft && (
          <Button
            variant="link"
            onClick={() =>
              setDraft({
                agentId: props.agent.id,
                expectedRevision: props.assignmentRevision,
                permissionGroupIds: [...props.agent.access.permissionGroupIds],
                serviceConnectionIds: [
                  ...props.agent.access.serviceConnectionIds,
                ],
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
        <fieldset
          disabled={!draft || action.busy}
          className="space-y-4 border-t pt-4"
        >
          <legend className="mb-2 text-sm font-medium">
            Assigned connections
          </legend>
          {!props.connections.length && (
            <p className="text-sm text-muted-foreground">
              No connections are available.
            </p>
          )}
          {props.connections.map((connection) => (
            <Choice
              key={connection.id}
              checked={access.serviceConnectionIds.includes(connection.id)}
              onChange={(checked) =>
                draft &&
                setDraft({
                  ...draft,
                  serviceConnectionIds: checked
                    ? [...draft.serviceConnectionIds, connection.id]
                    : draft.serviceConnectionIds.filter(
                        (value) => value !== connection.id,
                      ),
                })
              }
            >
              <ServiceIdentity connection={connection} />
            </Choice>
          ))}
          {access.serviceConnectionIds
            .filter(
              (id) =>
                !props.connections.some((connection) => connection.id === id),
            )
            .map((id) => (
              <Choice
                key={id}
                checked
                onChange={() =>
                  draft &&
                  setDraft({
                    ...draft,
                    serviceConnectionIds: draft.serviceConnectionIds.filter(
                      (value) => value !== id,
                    ),
                  })
                }
                description="Unavailable connection. Remove this assignment or refresh to inspect it."
              >
                {id}
              </Choice>
            ))}
        </fieldset>
        <p className="text-xs leading-5 text-muted-foreground">
          Unassigning a connection prevents later calls through it, including
          calls covered by an existing approval. Removing a group leaves any
          other group permissions and explicit grants intact. Calls already
          admitted may finish.
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
