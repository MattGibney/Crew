import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Agent, ServiceConnection } from "../agents/contracts.mjs";
import type { GatewayOwnerVerification } from "../gateway/owner-verification.mjs";
import type {
  OwnerConnectionSetupChoice,
  OwnerConnectionVerification,
} from "./owner-contracts.mjs";
import {
  AccessStore,
  type AccessState,
  type ConnectionSetupRecord,
} from "./state.mjs";
import { EncryptedCredentialVault } from "./vault.mjs";
import {
  validateConnection,
  validateGroup,
  validateRecord,
} from "./validation.mjs";

const stamp = () => new Date().toISOString();
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class ConnectionSetupReviewRequired extends Error {
  constructor() {
    super(
      "Settings or verification changed. Review the current access choices and verify again if needed.",
    );
  }
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error("Invalid connection setup input.");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new Error("Invalid connection setup identity.");
  return value;
}
function revision(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new Error("Invalid connection setup revision.");
  return value as number;
}
function list<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > 256)
    throw new Error("Invalid connection access selection.");
  return value.map(parse);
}
function ids(value: unknown): string[] {
  const values = list(value, text);
  if (new Set(values).size !== values.length)
    throw new Error("Duplicate access selection.");
  return values;
}
const view = (record: ConnectionSetupRecord): OwnerConnectionVerification => {
  const {
    connection: _connection,
    existing: _existing,
    expectedRevision: _revision,
    credentialRevision: _credential,
    inputFingerprint: _input,
    saveFingerprint: _save,
    ...safe
  } = record;
  return structuredClone(safe);
};

/** A durable owner workflow over the same access store and vault. Drafts never
 * enter assigned-connection lookup, and verification never grants authority. */
export class OwnerConnectionSetupService {
  private closing = false;
  private readonly running = new Map<
    string,
    {
      abort: AbortController;
      fingerprint: string;
      promise: Promise<OwnerConnectionVerification>;
    }
  >();
  constructor(
    private readonly options: {
      store: AccessStore;
      vault: EncryptedCredentialVault;
      projectId: string;
      ownerUserId: string;
      setupChoices(): Promise<OwnerConnectionSetupChoice[]>;
      listAgents(): Promise<Agent[]>;
      verify(
        connection: ServiceConnection,
        credentialRevision: number,
        signal: AbortSignal,
      ): Promise<GatewayOwnerVerification>;
    },
  ) {}
  private owner(state: AccessState) {
    if (
      state.projectId !== this.options.projectId ||
      state.ownerUserId !== this.options.ownerUserId
    )
      throw new Error("Connection setup owner changed.");
  }
  private row(state: AccessState, requestId: string) {
    this.owner(state);
    const row = state.connectionSetups?.find(
      (entry) => entry.requestId === requestId,
    );
    if (!row) throw new Error("Connection setup is unavailable.");
    return row;
  }
  async snapshot() {
    return this.options.store.transaction((state) => {
      this.owner(state);
      return (state.connectionSetups ?? [])
        .filter((row) => row.state !== "cancelled")
        .map(view);
    });
  }
  /** Only the owner verifier receives this lookup; the runtime gateway never does. */
  async candidate(connectionId: string): Promise<ServiceConnection | null> {
    return this.options.store.transaction((state) => {
      this.owner(state);
      const row = state.connectionSetups?.find(
        (entry) =>
          entry.connectionId === connectionId && entry.state === "verifying",
      );
      if (!row) return null;
      return row.existing
        ? (state.connections.find((entry) => entry.id === connectionId) ?? null)
        : row.connection;
    });
  }
  async verify(input: unknown): Promise<OwnerConnectionVerification> {
    if (this.closing) throw new Error("Connection setup is closing.");
    const args = object(input, [
      "requestId",
      "setupChoiceId",
      "name",
      "accountKind",
      "credential",
      "connectionId",
      "expectedRevision",
    ]);
    const requestId = text(args.requestId);
    const fingerprint = hash(args);
    // Duplicate in-flight transport delivery waits for the same verification.
    const pending = this.running.get(requestId);
    if (pending) {
      if (pending.fingerprint !== fingerprint)
        throw new Error("Pending verification input changed.");
      return pending.promise;
    }
    const abort = new AbortController();
    const promise = this.verifyOnce(
      structuredClone(args),
      abort.signal,
    ).finally(() => {
      if (this.running.get(requestId)?.abort === abort)
        this.running.delete(requestId);
    });
    this.running.set(requestId, { abort, fingerprint, promise });
    return promise;
  }
  private async verifyOnce(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<OwnerConnectionVerification> {
    const requestId = text(args.requestId),
      setupChoiceId = text(args.setupChoiceId),
      name = text(args.name);
    const accountKind = args.accountKind;
    if (accountKind !== "personal" && accountKind !== "dedicated")
      throw new Error("Choose the intended service account.");
    const existingId =
      args.connectionId == null ? null : text(args.connectionId);
    const expectedRevision = revision(args.expectedRevision ?? null);
    if (Boolean(existingId) !== (expectedRevision !== null))
      throw new Error("Existing connection revision required.");
    if (
      args.credential !== null &&
      (typeof args.credential !== "string" ||
        !args.credential ||
        Buffer.byteLength(args.credential) > 65536)
    )
      throw new Error("Enter a bounded private credential.");
    if (existingId && args.credential !== null)
      throw new Error(
        "Existing connection selection cannot replace credentials.",
      );
    const material =
      typeof args.credential === "string"
        ? Buffer.from(args.credential, "utf8")
        : null;
    args.credential = null;
    const inputFingerprint = hash([
      setupChoiceId,
      name,
      accountKind,
      existingId,
      expectedRevision,
    ]);
    let prepared: ConnectionSetupRecord;
    try {
      const choice = (await this.options.setupChoices()).find(
        (item) => item.id === setupChoiceId,
      );
      if (!choice?.guide || !choice.authenticationMethods.includes("token"))
        throw new Error("Guided provider is unavailable.");
      prepared = await this.options.store.transaction(async (state) => {
        this.owner(state);
        signal.throwIfAborted();
        const records = (state.connectionSetups ??= []);
        const prior = records.find((row) => row.requestId === requestId);
        if (prior) {
          if (
            prior.inputFingerprint !== inputFingerprint ||
            prior.state === "cancelled"
          )
            throw new Error("Connection setup changed or was cancelled.");
          if (material) {
            if (prior.connection.authentication.method !== "token")
              throw new Error("Connection credential is unavailable.");
            const same = await this.options.vault.withCredential(
              prior.connection.authentication.credentialRef,
              (handle) =>
                handle.use(async (bytes) =>
                  Buffer.from(
                    bytes.buffer,
                    bytes.byteOffset,
                    bytes.byteLength,
                  ).equals(material),
                ),
            );
            if (!same)
              throw new Error(
                "Discard the previous draft before verifying a different credential.",
              );
          }
          if (
            prior.state === "saved" ||
            (prior.state === "verified" && prior.expiresAt > stamp())
          )
            return prior;
          prior.state = "verifying";
          prior.verificationId = randomUUID();
          prior.expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
          prior.reason = null;
          return prior;
        }
        if (records.length >= 256)
          throw new Error("Connection setup capacity reached.");
        const existing = existingId
          ? state.connections.find((row) => row.id === existingId)
          : null;
        if (
          existingId &&
          (!existing ||
            existing.revision !== expectedRevision ||
            existing.service !== choice.service ||
            !isDeepStrictEqual(existing.transport, choice.transport))
        )
          throw new Error("Existing connection changed.");
        const connectionId = existing?.id ?? randomUUID();
        let credentialRevision: number;
        let connection: ServiceConnection;
        if (existing) {
          if (existing.authentication.method !== "token")
            throw new Error("This guided connection requires a token.");
          const metadata = await this.options.vault.metadataForReference(
            existing.authentication.credentialRef,
          );
          if (metadata.deleted)
            throw new Error("Connection credential unavailable.");
          credentialRevision = metadata.revision;
          connection = structuredClone(existing);
        } else {
          if (!material)
            throw new Error("Enter the credential to verify this account.");
          const saved = await this.options.vault.storeCredential(
            { type: "user", userId: this.options.ownerUserId },
            connectionId,
            material,
            null,
          );
          credentialRevision = saved.revision;
          connection = {
            id: connectionId,
            projectId: state.projectId,
            revision: 1,
            name,
            service: choice.service,
            identity: {
              displayName: "Identity not verified",
              externalAccountId: null,
              emailAddress: null,
            },
            transport: structuredClone(choice.transport),
            authentication: {
              method: "token",
              credentialRef: saved.credentialRef,
            },
            observedState: "unknown",
            lastVerifiedAt: null,
          };
        }
        const record: ConnectionSetupRecord = {
          requestId,
          verificationId: randomUUID(),
          connectionId,
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          state: "verifying",
          identity: null,
          identityStatus: "unavailable",
          capabilities: [],
          capabilitiesStatus: "unavailable",
          accountKind,
          name,
          setupChoiceId,
          reason: null,
          connection,
          existing: Boolean(existing),
          expectedRevision,
          credentialRevision,
          inputFingerprint,
          saveFingerprint: null,
        };
        records.push(record);
        return record;
      });
    } finally {
      material?.fill(0);
    }
    if (prepared.state !== "verifying") return view(prepared);
    let result: GatewayOwnerVerification | null = null;
    try {
      signal.throwIfAborted();
      result = await this.options.verify(
        prepared.connection,
        prepared.credentialRevision,
        signal,
      );
    } catch {
      /* Provider detail and credentials never reach owner errors. */
    }
    return this.options.store.transaction((state) => {
      const current = this.row(state, requestId);
      if (
        current.state !== "verifying" ||
        current.verificationId !== prepared.verificationId
      )
        return view(current);
      current.state =
        signal.aborted || result?.state === "cancelled"
          ? "cancelled"
          : result?.state === "verified"
            ? "verified"
            : "failed";
      current.reason =
        current.state === "verified"
          ? null
          : current.state === "cancelled"
            ? "Connection setup cancelled."
            : "Verification failed. Check the account, credential and provider access, then retry.";
      current.identity =
        result?.identity.state === "verified" ? result.identity.value : null;
      current.identityStatus =
        result?.identity.state === "verified" ? "verified" : "unavailable";
      current.capabilities =
        result?.capabilities.state === "verified"
          ? result.capabilities.values.map((capability) => ({
              ...capability,
              description: capability.description.slice(0, 4096),
            }))
          : [];
      current.capabilitiesStatus =
        result?.capabilities.state === "verified" ? "verified" : "unavailable";
      if (
        current.existing &&
        current.identity &&
        (!current.connection.identity.externalAccountId ||
          current.connection.identity.externalAccountId !==
            current.identity.externalAccountId)
      ) {
        current.state = "failed";
        current.reason =
          "The saved connection has no matching verified account identity. Create a new connection to keep existing permissions bound to their original account.";
      }
      if (!current.existing && current.identity)
        current.connection.identity = current.identity;
      return view(current);
    });
  }
  async discard(input: unknown): Promise<void> {
    const args = object(input, ["requestId"]),
      requestId = text(args.requestId);
    this.running.get(requestId)?.abort.abort();
    const cancelled = await this.options.store.transaction((state) => {
      this.owner(state);
      const row = state.connectionSetups?.find(
        (entry) => entry.requestId === requestId,
      );
      if (!row || row.state === "saved") return null;
      row.state = "cancelled";
      row.reason = "Connection setup cancelled.";
      return row;
    });
    if (cancelled && !cancelled.existing) {
      const actor = { type: "user" as const, userId: this.options.ownerUserId };
      const metadata = await this.options.vault.credentialMetadata(
        actor,
        cancelled.connectionId,
      );
      if (metadata && !metadata.deleted)
        await this.options.vault.removeCredential(
          actor,
          cancelled.connectionId,
          metadata.revision,
        );
    }
  }
  async save(input: unknown): Promise<{ connectionId: string }> {
    if (this.closing) throw new Error("Connection setup is closing.");
    const args = object(input, [
      "requestId",
      "verificationId",
      "groupSelections",
      "agentSelections",
    ]);
    const requestId = text(args.requestId),
      verificationId = text(args.verificationId);
    const groups = list(args.groupSelections, (value) => {
      const item = object(value, [
        "groupId",
        "expectedRevision",
        "capabilityIds",
      ]);
      const expectedRevision = revision(item.expectedRevision);
      if (expectedRevision === null)
        throw new Error("Group revision required.");
      return {
        groupId: text(item.groupId),
        expectedRevision,
        capabilityIds: ids(item.capabilityIds),
      };
    });
    const agents = list(args.agentSelections, (value) => {
      const item = object(value, [
        "agentId",
        "expectedRevision",
        "permissionGroupIds",
      ]);
      return {
        agentId: text(item.agentId),
        expectedRevision: revision(item.expectedRevision),
        permissionGroupIds: ids(item.permissionGroupIds),
      };
    });
    if (
      new Set(groups.map((item) => item.groupId)).size !== groups.length ||
      new Set(agents.map((item) => item.agentId)).size !== agents.length
    )
      throw new Error("Duplicate reviewed access choice.");
    const saveFingerprint = hash([verificationId, groups, agents]);
    return this.options.store.transaction(async (state) => {
      const setup = this.row(state, requestId);
      if (setup.state === "saved") {
        if (setup.saveFingerprint !== saveFingerprint)
          throw new Error("Saved setup retry changed.");
        return { connectionId: setup.connectionId }; // Never restore later revoked access.
      }
      if (
        setup.state !== "verified" ||
        setup.verificationId !== verificationId ||
        setup.expiresAt <= stamp()
      )
        throw new ConnectionSetupReviewRequired();
      const connection = state.connections.find(
        (row) => row.id === setup.connectionId,
      );
      if (
        setup.existing
          ? !connection || !isDeepStrictEqual(connection, setup.connection)
          : Boolean(connection)
      )
        throw new ConnectionSetupReviewRequired();
      if (setup.connection.authentication.method !== "token")
        throw new Error("Unsupported guided credential.");
      const metadata = await this.options.vault.metadataForReference(
        setup.connection.authentication.credentialRef,
      );
      if (metadata.deleted || metadata.revision !== setup.credentialRevision)
        throw new ConnectionSetupReviewRequired();
      const currentAgents = await this.options.listAgents();
      const allowed = new Set(
        setup.capabilities.map((capability) => capability.id),
      );
      for (const selection of groups) {
        const group = state.groups.find((row) => row.id === selection.groupId);
        if (
          !group ||
          group.revision !== selection.expectedRevision ||
          selection.capabilityIds.some((id) => !allowed.has(id))
        )
          throw new ConnectionSetupReviewRequired();
        const existing = group.grants.services.find(
          (grant) => grant.connectionId === setup.connectionId,
        );
        if (selection.capabilityIds.length) {
          if (existing)
            existing.capabilities = [
              ...new Set([
                ...existing.capabilities,
                ...selection.capabilityIds,
              ]),
            ];
          else
            group.grants.services.push({
              connectionId: setup.connectionId,
              capabilities: selection.capabilityIds,
            });
          group.revision++;
          group.updatedAt = stamp();
          validateGroup(group);
        }
      }
      for (const selection of agents) {
        if (
          !currentAgents.some(
            (agent) =>
              agent.id === selection.agentId &&
              agent.projectId === state.projectId &&
              !agent.archivedAt,
          )
        )
          throw new ConnectionSetupReviewRequired();
        const current = state.assignments.find(
          (assignment) => assignment.agentId === selection.agentId,
        );
        if (
          (current?.revision ?? null) !== selection.expectedRevision ||
          selection.permissionGroupIds.some(
            (id) => !state.groups.some((group) => group.id === id),
          )
        )
          throw new ConnectionSetupReviewRequired();
        const assignment = {
          agentId: selection.agentId,
          permissionGroupIds: [
            ...new Set([
              ...(current?.permissionGroupIds ?? []),
              ...selection.permissionGroupIds,
            ]),
          ],
          serviceConnectionIds: [
            ...new Set([
              ...(current?.serviceConnectionIds ?? []),
              setup.connectionId,
            ]),
          ],
          revision: (current?.revision ?? 0) + 1,
        };
        validateRecord("assignment", assignment);
        if (current) Object.assign(current, assignment);
        else state.assignments.push(assignment);
      }
      if (!setup.existing) {
        const saved = {
          ...setup.connection,
          observedState: "connected" as const,
          lastVerifiedAt: stamp(),
        };
        validateConnection(saved);
        state.connections.push(saved);
      } else if (connection) {
        // Preserve immutable service/account/transport identity while recording
        // the explicitly reviewed display name and this verified observation.
        connection.name = setup.name;
        connection.observedState = "connected";
        connection.lastVerifiedAt = stamp();
        connection.revision++;
        validateConnection(connection);
      }
      setup.state = "saved";
      setup.saveFingerprint = saveFingerprint;
      state.audit.push({
        id: randomUUID(),
        at: stamp(),
        actor: { type: "user", userId: state.ownerUserId },
        action: "connection.setup.saved",
        subjectId: setup.connectionId,
      });
      return { connectionId: setup.connectionId };
    });
  }
  async savedEvidence(connectionId: string) {
    return this.options.store.transaction((state) => {
      this.owner(state);
      const connection = state.connections.find(
        (row) => row.id === connectionId,
      );
      const saved = state.connectionSetups?.find(
        (row) => row.connectionId === connectionId && row.state === "saved",
      );
      return connection &&
        saved &&
        connection.authentication.method === "token" &&
        saved.connection.authentication.method === "token" &&
        connection.authentication.credentialRef ===
          saved.connection.authentication.credentialRef
        ? { connection, capabilities: saved.capabilities }
        : null;
    });
  }
  async close(): Promise<void> {
    this.closing = true;
    const requests = [...this.running.keys()];
    const pending = [...this.running.values()].map((entry) => entry.promise);
    await Promise.all(requests.map((requestId) => this.discard({ requestId })));
    await Promise.allSettled(pending);
  }
}
