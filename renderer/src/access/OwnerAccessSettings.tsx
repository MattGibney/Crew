import { useState } from "react";
import type { AccessOwnerView } from "../../../src/access/owner-contracts.mjs";
import { PermissionGroupsPanel } from "./PermissionGroupsPanel";
import { CreationPresetsPanel } from "./CreationPresetsPanel";
import { AgentAccessPanel } from "./AgentAccessPanel";
import { ServiceConnectionsPanel } from "./ServiceConnectionsPanel";
import { AccessRequestsPanel } from "./AccessRequestsPanel";
import { ApprovalGrantsPanel } from "./ApprovalGrantsPanel";
import { NativeSelect } from "@/components/ui/native-select";
import { Label } from "@/components/ui/label";
import { OwnerRequired } from "./shared";

/** #95 mounts this with the authenticated owner's live snapshot. It owns no store
 * or authority; refresh props in place so in-progress panel drafts remain intact. */
export function OwnerAccessSettings({
  snapshot,
  isOwner,
  onCommand,
  onNotify,
}: {
  snapshot: AccessOwnerView;
  isOwner: boolean;
  onCommand(name: string, args: unknown): Promise<unknown>;
  onNotify(message: string): void;
}) {
  const [selectedId, setSelectedId] = useState("");
  if (!isOwner) return <OwnerRequired />;
  const common = { isOwner, onNotify };
  const agent =
    snapshot.agents.find((row) => row.id === selectedId) ?? snapshot.agents[0];
  const command = async (name: string, args: unknown) => {
    await onCommand(name, args);
  };
  return (
    <div className="min-w-0 divide-y">
      <ServiceConnectionsPanel
        {...common}
        connections={snapshot.connections}
        setupChoices={snapshot.setupChoices}
        onVerify={
          snapshot.canVerifyConnections
            ? (connectionId, expectedRevision) =>
                command("verifyConnection", { connectionId, expectedRevision })
            : undefined
        }
        onSave={(change) => command("saveConnection", change)}
        onRemove={(connectionId, expectedRevision) =>
          command("removeConnection", { connectionId, expectedRevision })
        }
      />
      {snapshot.catalogue.some((item) => item.state === "unavailable") && (
        <p role="status" className="py-4 text-sm text-muted-foreground">
          Some service operations could not be discovered. Check the connection
          credential and configured adapter before granting its operations.
        </p>
      )}
      <PermissionGroupsPanel
        {...common}
        groups={snapshot.groups}
        connections={snapshot.connections}
        capabilities={snapshot.capabilities}
        crewCapabilities={snapshot.crewCapabilities}
        agents={snapshot.agents}
        onSave={(change) => command("saveGroup", change)}
      />
      <section className="py-6">
        <Label htmlFor="crew-access-agent">Agent access</Label>
        <NativeSelect
          id="crew-access-agent"
          value={agent?.id ?? ""}
          onChange={(event) => setSelectedId(event.target.value)}
        >
          {!snapshot.agents.length && (
            <option value="">No agents configured</option>
          )}
          {snapshot.agents.map((row) => (
            <option key={row.id} value={row.id}>
              {row.profile.name}
            </option>
          ))}
        </NativeSelect>
        {agent && (
          <AgentAccessPanel
            {...common}
            agent={agent}
            assignmentRevision={
              snapshot.assignments.find((row) => row.agentId === agent.id)
                ?.revision ?? null
            }
            groups={snapshot.groups}
            connections={snapshot.connections}
            onSave={(change) => command("saveAssignment", change)}
          />
        )}
      </section>
      <CreationPresetsPanel
        {...common}
        presets={snapshot.presets}
        creationDefaults={snapshot.creationDefaults}
        runtimeDefaults={snapshot.runtimeDefaults}
        agents={snapshot.agents}
        groups={snapshot.groups}
        connections={snapshot.connections}
        onSave={(change) => command("savePreset", change)}
        onSetDefault={(presetId, expectedRevision) =>
          command("setDefaultPreset", { presetId, expectedRevision })
        }
      />
      <AccessRequestsPanel
        {...common}
        requests={snapshot.requests}
        agents={snapshot.agents}
        connections={snapshot.connections}
        capabilities={snapshot.capabilities}
        onDecide={(requestId, decision) =>
          command("decideAccess", { requestId, decision })
        }
      />
      <ApprovalGrantsPanel
        {...common}
        grants={snapshot.grants}
        groups={snapshot.groups}
        agents={snapshot.agents}
        connections={snapshot.connections}
        onRevoke={(grantId, reason) =>
          command("revokeGrant", { grantId, reason })
        }
      />
    </div>
  );
}
