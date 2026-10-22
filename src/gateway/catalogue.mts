import type {
  ServiceCapability,
  ServiceConnection,
} from "../agents/contracts.mjs";

export interface GatewayCatalogueProjection {
  state: "available" | "undiscovered" | "failed";
  /** Last successful observation for this exact revision. A failed refresh may
   * retain these schemas; execution still requires fresh policy and discovery. */
  capabilities: ServiceCapability[];
}

/** Local projection, never an authority for assignments or grants. Refresh does
 * network I/O outside access transactions and publishes one complete catalogue.
 * An owner snapshot must call projection(), never refresh(). */
export class GatewayCatalogue {
  private readonly entries = new Map<
    string,
    { revision: number; capabilities: ServiceCapability[] }
  >();
  private readonly failures = new Map<string, number>();
  private readonly revisions = new Map<string, number>();
  private readonly pending = new Map<
    string,
    { revision: number; token: symbol; promise: Promise<ServiceCapability[]> }
  >();
  constructor(
    private readonly discover: (
      connection: ServiceConnection,
    ) => Promise<ServiceCapability[]>,
  ) {}
  private validate(
    connection: ServiceConnection,
    capabilities: ServiceCapability[],
  ): void {
    if (
      capabilities.length > 500 ||
      capabilities.some((item) => item.connectionId !== connection.id)
    )
      throw new Error("Invalid connection catalogue.");
  }
  refresh(connection: ServiceConnection): Promise<ServiceCapability[]> {
    const running = this.pending.get(connection.id);
    if (running?.revision === connection.revision)
      return running.promise.then((value) => structuredClone(value));
    const latestRevision = this.revisions.get(connection.id);
    if (latestRevision !== undefined && latestRevision > connection.revision)
      return Promise.reject(
        new Error("Connection catalogue revision is stale."),
      );
    if (this.revisions.size >= 256 && latestRevision === undefined)
      return Promise.reject(
        new Error("Connection catalogue capacity reached."),
      );
    this.revisions.set(connection.id, connection.revision);
    if (this.entries.get(connection.id)?.revision !== connection.revision)
      this.entries.delete(connection.id);
    const token = Symbol(connection.id);
    const promise = Promise.resolve().then(async () => {
      try {
        const capabilities = await this.discover(connection);
        this.validate(connection, capabilities);
        if (this.pending.get(connection.id)?.token !== token)
          throw new Error("Connection catalogue changed during discovery.");
        this.entries.set(connection.id, {
          revision: connection.revision,
          capabilities: structuredClone(capabilities),
        });
        this.failures.delete(connection.id);
        return structuredClone(capabilities);
      } catch (error) {
        if (this.pending.get(connection.id)?.token === token)
          this.failures.set(connection.id, connection.revision);
        throw error;
      } finally {
        if (this.pending.get(connection.id)?.token === token)
          this.pending.delete(connection.id);
      }
    });
    this.pending.set(connection.id, {
      revision: connection.revision,
      token,
      promise,
    });
    return promise;
  }
  invalidate(connectionId: string): void {
    this.pending.delete(connectionId); // A late result cannot republish after invalidation.
    this.entries.delete(connectionId);
    this.failures.delete(connectionId);
  }
  /** Trusted owner verifier only: the same schemas were discovered with this
   * exact connection before its reviewed save. Execution still rediscovers. */
  rememberVerified(
    connection: ServiceConnection,
    capabilities: ServiceCapability[],
  ): void {
    this.validate(connection, capabilities);
    if ((this.revisions.get(connection.id) ?? 0) > connection.revision) return;
    if (this.revisions.size >= 256 && !this.revisions.has(connection.id))
      return;
    this.pending.delete(connection.id);
    this.revisions.set(connection.id, connection.revision);
    this.entries.set(connection.id, {
      revision: connection.revision,
      capabilities: structuredClone(capabilities),
    });
    this.failures.delete(connection.id);
  }
  async hasOperation(
    connectionId: string,
    operation: string,
  ): Promise<boolean> {
    return (
      this.entries
        .get(connectionId)
        ?.capabilities.some((item) => item.id === operation) ?? false
    );
  }
  projection(connection: ServiceConnection): GatewayCatalogueProjection {
    const entry = this.entries.get(connection.id);
    const matches = entry?.revision === connection.revision;
    return {
      state:
        this.failures.get(connection.id) === connection.revision
          ? "failed"
          : matches
            ? "available"
            : "undiscovered",
      capabilities: matches ? structuredClone(entry.capabilities) : [],
    };
  }
  snapshot(connection: ServiceConnection): ServiceCapability[] {
    return this.projection(connection).capabilities;
  }
}
