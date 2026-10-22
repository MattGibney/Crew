import type { ServiceCapability, ServiceConnection } from "../agents/contracts.mjs";

/** A projection of observed tool schemas, never an authority for assignments or
 * grants. hasOperation performs no network/store calls, so access transactions
 * cannot re-enter themselves through catalogue discovery. */
export class GatewayCatalogue {
  private readonly entries = new Map<string, { revision: number; capabilities: ServiceCapability[] }>();
  constructor(private readonly discover: (connection: ServiceConnection) => Promise<ServiceCapability[]>) {}
  async refresh(connection: ServiceConnection): Promise<ServiceCapability[]> {
    this.invalidate(connection.id);
    const capabilities = await this.discover(connection);
    if (capabilities.length > 500 || capabilities.some(item => item.connectionId !== connection.id))
      throw new Error("Invalid connection catalogue.");
    if (this.entries.size >= 256 && !this.entries.has(connection.id))
      throw new Error("Connection catalogue capacity reached.");
    this.entries.set(connection.id, { revision: connection.revision, capabilities: structuredClone(capabilities) });
    return structuredClone(capabilities);
  }
  observe(connection: ServiceConnection, capabilities: ServiceCapability[]): void {
    if (capabilities.length > 500 || capabilities.some(item => item.connectionId !== connection.id))
      throw new Error("Invalid connection catalogue.");
    if (this.entries.size >= 256 && !this.entries.has(connection.id))
      throw new Error("Connection catalogue capacity reached.");
    this.entries.set(connection.id, { revision: connection.revision, capabilities: structuredClone(capabilities) });
  }
  invalidate(connectionId: string): void { this.entries.delete(connectionId); }
  async hasOperation(connectionId: string, operation: string): Promise<boolean> {
    return this.entries.get(connectionId)?.capabilities.some(item => item.id === operation) ?? false;
  }
  snapshot(connection: ServiceConnection): ServiceCapability[] {
    const entry = this.entries.get(connection.id);
    return entry?.revision === connection.revision ? structuredClone(entry.capabilities) : [];
  }
}
