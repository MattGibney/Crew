import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useState } from "react";
import type { AccessOwnerView } from "../../../src/access/owner-contracts.mjs";
import { PermissionGroupsPanel } from "./PermissionGroupsPanel";
import { CreationPresetsPanel } from "./CreationPresetsPanel";
import { AgentAccessPanel } from "./AgentAccessPanel";
import { ServiceConnectionsPanel } from "./ServiceConnectionsPanel";
import { ServiceConnectionWizard } from "./ServiceConnectionWizard";
import { AccessRequestsPanel } from "./AccessRequestsPanel";
import { ApprovalGrantsPanel } from "./ApprovalGrantsPanel";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { OwnerRequired } from "./shared";
import type { WorkspacePermissionChoice } from "./types";

/** #95 mounts this with the authenticated owner's live snapshot. It owns no store
 * or authority; refresh props in place so in-progress panel drafts remain intact. */
export function OwnerAccessSettings({
  snapshot: retainedSnapshot,
  isOwner,
  onCommand,
  onNotify,
  workspaces = [],
  showAgentAssignments = true,
}: {
  snapshot: AccessOwnerView;
  isOwner: boolean;
  onCommand(name: string, args: unknown): Promise<unknown>;
  onNotify(message: string): void;
  workspaces?: readonly WorkspacePermissionChoice[];
  /** Consolidated agent editing owns assignments in the desktop application. */
  showAgentAssignments?: boolean;
}) {
  const [selectedId, setSelectedId] = useState("");
  const [connecting, setConnecting] = useState(false);
  if (!isOwner) return <OwnerRequired />;
  const snapshot = {
    ...retainedSnapshot,
    agents: retainedSnapshot.agents.filter((agent) => !agent.archivedAt),
  };
  const common = { isOwner, onNotify };
  const agent =
    snapshot.agents.find((row) => row.id === selectedId) ?? snapshot.agents[0];
  const command = async (name: string, args: unknown) => {
    await onCommand(name, args);
  };
  return (
    <div className="min-w-0 space-y-10">
      {connecting && (
        <Dialog open>
          <DialogContent
            className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl"
            showCloseButton={false}
          >
            <DialogTitle className="sr-only">Add connection</DialogTitle>
            <DialogDescription className="sr-only">
              Connect a service account and review access.
            </DialogDescription>
            <ServiceConnectionWizard
              {...common}
              snapshot={snapshot}
              onCommand={onCommand}
              onCancel={() => setConnecting(false)}
              onComplete={() => setConnecting(false)}
            />
          </DialogContent>
        </Dialog>
      )}
      <ServiceConnectionsPanel
        {...common}
        onConnect={
          snapshot.canGuideConnections ? () => setConnecting(true) : undefined
        }
        connections={snapshot.connections}
        setupChoices={snapshot.setupChoices}
        onVerify={
          snapshot.canVerifyConnections
            ? (connectionId, expectedRevision) =>
                command("verifyConnection", {
                  connectionId,
                  expectedRevision,
                })
            : undefined
        }
        onSave={(change) => command("saveConnection", change)}
        onRemove={(connectionId, expectedRevision) =>
          command("removeConnection", { connectionId, expectedRevision })
        }
      />
      {snapshot.catalogue
        .filter((item) => item.state !== "available")
        .map((item) => {
          const connection = snapshot.connections.find(
            (row) => row.id === item.connectionId,
          );
          return (
            <p
              key={item.connectionId}
              role="status"
              className="py-4 text-sm text-muted-foreground"
            >
              {connection?.name ?? "This connection"}:{" "}
              {item.state === "undiscovered"
                ? "service operations have not been discovered yet."
                : "service operation discovery failed. Check the connection credential and configured adapter."}
              {snapshot.canVerifyConnections
                ? " Choose Verify connection to discover its current operations."
                : " Connection verification is currently unavailable."}
            </p>
          );
        })}
      <PermissionGroupsPanel
        {...common}
        groups={snapshot.groups}
        skills={snapshot.skills}
        connections={snapshot.connections}
        capabilities={snapshot.capabilities}
        crewCapabilities={snapshot.crewCapabilities}
        agents={snapshot.agents}
        workspaces={workspaces.filter(
          (workspace) =>
            workspace.policy.projectId === snapshot.projectId &&
            snapshot.environmentPolicies.some(
              (policy) =>
                policy.id === workspace.policy.id &&
                policy.revision === workspace.policy.revision,
            ),
        )}
        onSave={(change) => command("saveGroup", change)}
      />
      {showAgentAssignments && (
        <>
          <section className="py-6">
            <Label htmlFor="crew-access-agent">Agent access</Label>
            <Select
              value={agent?.id ?? ""}
              onValueChange={(selectedValue) =>
                setSelectedId(selectedValue ?? "")
              }
              items={
                snapshot.agents.length
                  ? snapshot.agents.map((row) => ({
                      value: row.id,
                      label: row.profile.name,
                    }))
                  : [{ value: "", label: "No agents configured" }]
              }
            >
              <SelectTrigger id={"crew-access-agent"} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {!snapshot.agents.length && (
                  <SelectItem value="">No agents configured</SelectItem>
                )}
                {snapshot.agents.map((row) => (
                  <SelectItem key={row.id} value={row.id}>
                    {row.profile.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* Keep editors mounted so changing agents retains drafts and pending saves. */}
            {snapshot.agents.map((row) => (
              <div key={row.id} hidden={agent?.id !== row.id}>
                <AgentAccessPanel
                  {...common}
                  agent={row}
                  assignmentRevision={
                    snapshot.assignments.find(
                      (assignment) => assignment.agentId === row.id,
                    )?.revision ?? null
                  }
                  groups={snapshot.groups}
                  connections={snapshot.connections}
                  onSave={(change) => command("saveAssignment", change)}
                />
              </div>
            ))}
          </section>
        </>
      )}
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
