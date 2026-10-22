import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  Actor,
  Agent,
  AgentCreationPreset,
  AuthorizationService,
  PermissionGroup,
  ServiceCapability,
  ServiceConnection,
} from "../agents/contracts.mjs";
import type { ProjectAuthorizationService } from "./authorization.mjs";
import type { EncryptedCredentialVault } from "./vault.mjs";
import { crewActions } from "./validation.mjs";

import type {
  AccessOwnerView,
  OwnerConnectionSetupChoice,
  OwnerRuntimeDefaults,
} from "./owner-contracts.mjs";
export type {
  AccessOwnerView,
  OwnerConnectionSetupChoice,
  OwnerRuntimeDefaults,
} from "./owner-contracts.mjs";

export interface AccessOwnerApiOptions {
  authorization: ProjectAuthorizationService;
  vault: EncryptedCredentialVault;
  projectId: string;
  ownerUserId: string;
  /** Trusted production runtime references enable setup before any agent exists. */
  runtimeDefaults?: OwnerRuntimeDefaults | null;
  listAgents(): Promise<Agent[]>;
  setupChoices(): Promise<OwnerConnectionSetupChoice[]>;
  capabilities(connectionId: string): Promise<ServiceCapability[]>;
  /** Actual gateway connection check; absent means no supported verification flow. */
  verifyConnection?(connectionId: string): Promise<void>;
}
function object(value: unknown, keys?: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid access command.");
  const result = value as Record<string, unknown>;
  if (keys && Object.keys(result).some((key) => !keys.includes(key)))
    throw new Error("Unexpected access command field.");
  return result;
}
function id(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new Error("Invalid access identity.");
  return value;
}
function expected(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new Error("Invalid access revision.");
  return value as number;
}
function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 256)
    throw new Error("Invalid access assignments.");
  const result = value.map(id);
  if (new Set(result).size !== result.length)
    throw new Error("Duplicate access assignment.");
  return result;
}

/** Construct only after authenticating the owner transport. Owner identity is never a request field.
 * The #88 host mounts snapshot/command/subscribe alongside its owner API and enforces ingress auth.
 */
export function createAccessOwnerApi(
  options: AccessOwnerApiOptions,
  authenticatedUserId: string,
) {
  if (authenticatedUserId !== options.ownerUserId)
    throw new Error("Authenticated project owner required.");
  const actor: Actor = { type: "user", userId: authenticatedUserId };
  const runtimeDefaults: OwnerRuntimeDefaults | null = options.runtimeDefaults
    ? {
        modelAccessId: id(options.runtimeDefaults.modelAccessId),
        configRef: id(options.runtimeDefaults.configRef),
      }
    : null;
  const authorization = options.authorization;
  let tail: Promise<unknown> = Promise.resolve();
  async function saveConnection(args: Record<string, unknown>) {
    const change = object(args, [
      "id",
      "expectedRevision",
      "draft",
      "credential",
    ]);
    const draft = object(change.draft, [
      "name",
      "service",
      "identity",
      "transport",
      "authenticationMethod",
    ]);
    const connectionId = change.id === null ? randomUUID() : id(change.id);
    const method = draft.authenticationMethod;
    const setup = (await options.setupChoices()).find(
      (choice) =>
        choice.service === draft.service &&
        isDeepStrictEqual(choice.transport, draft.transport),
    );
    if (
      !setup ||
      !setup.authenticationMethods.includes(
        method as ServiceConnection["authentication"]["method"],
      )
    )
      throw new Error("Connection is not a supported configured adapter.");
    if (method === "oauth")
      throw new Error(
        "Use a supported OAuth reconnect flow; OAuth material cannot be pasted into settings.",
      );
    if (
      change.credential !== null &&
      (typeof change.credential !== "string" ||
        !change.credential ||
        Buffer.byteLength(change.credential) > 65536)
    )
      throw new Error("Invalid private credential input.");
    if (method === "none" && change.credential !== null)
      throw new Error("This connection does not accept a credential.");
    const connection: ServiceConnection = {
      id: connectionId,
      projectId: options.projectId,
      revision: 1,
      name: id(draft.name),
      service: id(draft.service),
      identity: structuredClone(
        draft.identity,
      ) as ServiceConnection["identity"],
      transport: structuredClone(
        draft.transport,
      ) as ServiceConnection["transport"],
      authentication:
        method === "none"
          ? { method: "none" }
          : {
              method: method as "token" | "ssh-key",
              credentialRef: "pending-owner-save",
            },
      observedState: "unknown",
      lastVerifiedAt: null,
    };
    const material =
      change.credential === null
        ? null
        : Buffer.from(change.credential as string, "utf8");
    // Do not retain private owner entry on the command object across asynchronous work.
    change.credential = null;
    try {
      return await authorization.saveConnection(
        actor,
        connection,
        expected(change.expectedRevision),
        async (verifiedCurrent) => {
          if (method === "none") {
            const metadata = await options.vault.credentialMetadata(
              actor,
              connectionId,
            );
            if (metadata && !metadata.deleted)
              await options.vault.removeCredential(
                actor,
                connectionId,
                metadata.revision,
              );
            return { method: "none" };
          }
          if (!material) {
            if (
              !verifiedCurrent ||
              verifiedCurrent.authentication.method !== method ||
              verifiedCurrent.authentication.method === "none"
            )
              throw new Error(
                "Enter a credential for this authentication method.",
              );
            return verifiedCurrent.authentication;
          }
          const metadata = await options.vault.credentialMetadata(
            actor,
            connectionId,
          );
          const saved = await options.vault.storeCredential(
            actor,
            connectionId,
            material,
            metadata?.revision ?? null,
          );
          return {
            method: method as "token" | "ssh-key",
            credentialRef: saved.credentialRef,
          };
        },
      );
    } finally {
      material?.fill(0);
    }
  }
  return {
    async snapshot(): Promise<AccessOwnerView> {
      const [state, agents, setupChoices] = await Promise.all([
        authorization.snapshot(actor),
        options.listAgents(),
        options.setupChoices(),
      ]);
      const discovered = await Promise.all(
        state.connections.map(async (connection) => {
          try {
            return {
              connectionId: connection.id,
              state: "available" as const,
              capabilities: await options.capabilities(connection.id),
            };
          } catch {
            return {
              connectionId: connection.id,
              state: "unavailable" as const,
              capabilities: [] as ServiceCapability[],
            };
          }
        }),
      );
      return {
        ...state,
        projectId: options.projectId,
        runtimeDefaults: runtimeDefaults ? { ...runtimeDefaults } : null,
        agents: agents.map((agent) => ({
          ...agent,
          access: {
            inheritPersonalServiceCredentials: false as const,
            ...(state.assignments.find(
              (assignment) => assignment.agentId === agent.id,
            ) ?? {
              permissionGroupIds: [],
              serviceConnectionIds: [],
              inheritPersonalServiceCredentials: false as const,
            }),
          },
        })),
        setupChoices,
        capabilities: discovered.flatMap((item) => item.capabilities),
        catalogue: discovered.map(({ connectionId, state }) => ({
          connectionId,
          state,
        })),
        crewCapabilities: crewActions
          .filter(
            (action) =>
              ![
                "groups.write",
                "groups.assign",
                "connections.assign",
                "connections.manage",
                "grants.approve",
                "grants.revoke",
              ].includes(action),
          )
          .map((action) => ({
            action,
            label: action.replaceAll(".", " · "),
            description: `Allow ${action.replaceAll(".", " ")}.`,
          })),
        canVerifyConnections: Boolean(options.verifyConnection),
      };
    },
    subscribe(listener: (event: { kind: "access_changed" }) => void) {
      return authorization.subscribe(() =>
        listener({ kind: "access_changed" }),
      );
    },
    async command(name: string, value: unknown): Promise<unknown> {
      const args = object(value);
      // Snapshot private input once; later renderer edits cannot alter a pending save.
      const input = structuredClone(args);
      const run = tail.then(async () => {
        await authorization.snapshot(actor); // Verify the store owner on every command.
        switch (name) {
          case "saveGroup": {
            object(input, ["id", "expectedRevision", "draft"]);
            const draft = object(input.draft, [
              "name",
              "description",
              "grants",
            ]);
            return authorization.saveGroup(
              actor,
              {
                ...draft,
                id: input.id === null ? randomUUID() : id(input.id),
                projectId: options.projectId,
                revision: 1,
                updatedAt: new Date().toISOString(),
              } as PermissionGroup,
              expected(input.expectedRevision),
            );
          }
          case "savePreset": {
            object(input, ["id", "expectedRevision", "draft"]);
            const draft = object(input.draft, [
              "name",
              "enabled",
              "profile",
              "skills",
              "modelAccessId",
              "configRef",
              "permissionGroupIds",
              "serviceConnectionIds",
            ]);
            const configuredAgents = await options.listAgents();
            const current =
              input.id === null
                ? null
                : (await authorization.snapshot(actor)).presets.find(
                    (preset) => preset.id === input.id,
                  );
            const knownRuntime =
              (runtimeDefaults !== null &&
                runtimeDefaults.modelAccessId === draft.modelAccessId &&
                runtimeDefaults.configRef === draft.configRef) ||
              configuredAgents.some(
                (agent) =>
                  agent.projectId === options.projectId &&
                  agent.archivedAt === null &&
                  agent.runtime.modelAccessId === draft.modelAccessId &&
                  agent.runtime.configRef === draft.configRef,
              ) ||
              (current != null &&
                current.modelAccessId === draft.modelAccessId &&
                current.configRef === draft.configRef);
            if (!knownRuntime)
              throw new Error(
                "Choose the configured project runtime or an existing agent template.",
              );
            return authorization.savePreset(
              actor,
              {
                ...draft,
                id: input.id === null ? randomUUID() : id(input.id),
                projectId: options.projectId,
                revision: 1,
              } as AgentCreationPreset,
              expected(input.expectedRevision),
            );
          }
          case "setDefaultPreset": {
            object(input, ["presetId", "expectedRevision"]);
            const revision = expected(input.expectedRevision);
            if (revision === null)
              throw new Error("Default settings revision required.");
            return authorization.setDefaultPreset(
              actor,
              input.presetId === null ? null : id(input.presetId),
              revision,
            );
          }
          case "saveAssignment":
            object(input, [
              "agentId",
              "expectedRevision",
              "permissionGroupIds",
              "serviceConnectionIds",
            ]);
            return authorization.setAssignments(
              actor,
              id(input.agentId),
              ids(input.permissionGroupIds),
              ids(input.serviceConnectionIds),
              expected(input.expectedRevision),
            );
          case "saveConnection":
            return saveConnection(input);
          case "removeConnection": {
            object(input, ["connectionId", "expectedRevision"]);
            const connectionId = id(input.connectionId),
              revision = expected(input.expectedRevision);
            if (revision === null)
              throw new Error("Connection revision required.");
            await authorization.removeConnection(actor, connectionId, revision);
            const metadata = await options.vault.credentialMetadata(
              actor,
              connectionId,
            );
            if (metadata && !metadata.deleted)
              await options.vault.removeCredential(
                actor,
                connectionId,
                metadata.revision,
              );
            return null;
          }
          case "verifyConnection": {
            object(input, ["connectionId", "expectedRevision"]);
            const connection = await authorization.getConnection(
              id(input.connectionId),
            );
            if (
              !connection ||
              connection.revision !== expected(input.expectedRevision)
            )
              throw new Error("Connection changed before verification.");
            if (!options.verifyConnection)
              throw new Error("Connection verification is unavailable.");
            await options.verifyConnection(connection.id);
            return null;
          }
          case "decideAccess":
            object(input, ["requestId", "decision"]);
            return authorization.decide(
              id(input.requestId),
              actor,
              input.decision as Parameters<AuthorizationService["decide"]>[2],
            );
          case "revokeGrant":
            object(input, ["grantId", "reason"]);
            await authorization.revoke(
              id(input.grantId),
              actor,
              id(input.reason),
            );
            return null;
          default:
            throw new Error("Unsupported owner access command.");
        }
      });
      tail = run.catch(() => {});
      // Never propagate executor/vault/provider strings to the owner transport.
      return run.catch(() => {
        throw new Error(
          "Access change did not complete. Refresh current settings and retry with the current revision. A failed credential save may require reconnecting the service.",
        );
      });
    },
  };
}
export type AccessOwnerApi = ReturnType<typeof createAccessOwnerApi>;
