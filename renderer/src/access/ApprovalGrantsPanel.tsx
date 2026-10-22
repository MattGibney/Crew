import { useId, useState } from "react";
import type {
  Agent,
  ApprovalGrant,
  PermissionGroup,
  ServiceConnectionView,
} from "../../../src/agents/contracts.mjs";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { OwnerPanelProps } from "./types";
import {
  AccessSection,
  ErrorMessage,
  OwnerRequired,
  ScopeSummary,
  ServiceIdentity,
  useAccessAction,
} from "./shared";

export interface ApprovalGrantsPanelProps extends OwnerPanelProps {
  grants: readonly ApprovalGrant[];
  groups: readonly PermissionGroup[];
  agents: readonly Agent[];
  connections: readonly ServiceConnectionView[];
  onRevoke: (grantId: ApprovalGrant["id"], reason: string) => Promise<void>;
}

export function ApprovalGrantsPanel(props: ApprovalGrantsPanelProps) {
  if (!props.isOwner) return <OwnerRequired />;
  return (
    <AccessSection
      title="Approval grants"
      description="Revoking a grant prevents future admission through that grant. Other valid group permissions and grants remain effective; calls already admitted may finish."
    >
      <div className="divide-y border-y">
        {!props.grants.length && (
          <p className="py-5 text-sm text-muted-foreground">
            No approval grants have been issued.
          </p>
        )}
        {props.grants.map((grant) => (
          <GrantRow key={grant.id} {...props} grant={grant} />
        ))}
      </div>
    </AccessSection>
  );
}

function GrantRow({
  grant,
  ...props
}: ApprovalGrantsPanelProps & { grant: ApprovalGrant }) {
  const id = useId();
  const [revoking, setRevoking] = useState(false);
  const [reason, setReason] = useState("");
  const action = useAccessAction(props.onNotify);
  const agent = props.agents.find((item) => item.id === grant.agentId);
  const connection = props.connections.find(
    (item) => item.id === grant.scope.connectionId,
  );
  const capabilities =
    grant.scope.type === "exact_operation"
      ? [grant.scope.operation]
      : grant.scope.capabilities;
  const otherGroups = props.groups
    .filter((group) => agent?.access.permissionGroupIds.includes(group.id))
    .flatMap((group) => {
      const matching = group.grants.services
        .filter((service) => service.connectionId === grant.scope.connectionId)
        .flatMap((service) =>
          service.capabilities.filter((capability) =>
            capabilities.includes(capability),
          ),
        );
      return matching.length
        ? [{ group, capabilities: [...new Set(matching)] }]
        : [];
    });
  const canRevoke = grant.state === "active" || grant.state === "reserved";
  return (
    <article className="space-y-4 py-5" aria-labelledby={`${id}-heading`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <h3 id={`${id}-heading`} className="text-sm font-medium">
            {agent?.profile.name ?? grant.agentId} · {grant.state}
          </h3>
          <div className="text-sm">
            <ServiceIdentity connection={connection} />
          </div>
          <p className="text-xs text-muted-foreground">
            {grant.duration.type === "once"
              ? "Once, for its original invocation"
              : grant.duration.type === "session"
                ? "Session permission"
                : "Until revoked"}{" "}
            · Approved {new Date(grant.approvedAt).toLocaleString()}
          </p>
        </div>
        {canRevoke && !revoking && (
          <Button variant="outline" onClick={() => setRevoking(true)}>
            Revoke
          </Button>
        )}
      </div>
      <ScopeSummary scope={grant.scope} />
      <div className="space-y-2 text-xs leading-5 text-muted-foreground">
        <p className="font-medium">
          Other group permissions in the current snapshot
        </p>
        {!agent ? (
          <p>
            Agent memberships are unavailable. Refresh to inspect remaining
            permissions.
          </p>
        ) : otherGroups.length ? (
          <ul className="space-y-1">
            {otherGroups.map(({ group, capabilities: operations }) => (
              <li key={group.id} className="break-words">
                {group.name}:{" "}
                <span className="font-mono">{operations.join(", ")}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p>No matching group permissions are recorded.</p>
        )}
        {agent && (
          <p>
            {agent.access.serviceConnectionIds.includes(
              grant.scope.connectionId,
            )
              ? "The connection is assigned. Listed group permissions continue after this grant is revoked."
              : "The connection is not assigned, so these permissions cannot authorize service calls."}{" "}
            Other explicit grants are unaffected.
          </p>
        )}
      </div>
      {revoking && canRevoke && (
        <form
          className="space-y-3 rounded-lg border p-3"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!reason.trim()) return;
            if (
              await action.run(
                () => props.onRevoke(grant.id, reason.trim()),
                "Approval grant revoked.",
                "Could not revoke this grant. Refresh its current state and try again.",
              )
            ) {
              setRevoking(false);
              setReason("");
            }
          }}
        >
          <Label htmlFor={`${id}-reason`}>Reason for revocation</Label>
          <Textarea
            id={`${id}-reason`}
            required
            disabled={action.busy}
            maxLength={2000}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <ErrorMessage>{action.error}</ErrorMessage>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={action.busy}
              onClick={() => {
                setRevoking(false);
                setReason("");
                action.setError("");
              }}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={action.busy || !reason.trim()}
            >
              {action.busy ? "Revoking…" : "Confirm revocation"}
            </Button>
          </div>
        </form>
      )}
    </article>
  );
}
