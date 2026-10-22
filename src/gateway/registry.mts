import type { ServiceConnection } from "../agents/contracts.mjs";
import type {
  ExecutorConfiguration,
  ResolveExecutorConfiguration,
} from "./config.mjs";
import { assertHttpEndpoint, configurationReference } from "./config.mjs";
import { canonicalJson } from "./json.mjs";

export interface GatewaySetupChoice {
  id: string;
  label: string;
  service: string;
  transport: ServiceConnection["transport"];
  authenticationMethods: ServiceConnection["authentication"]["method"][];
}
export interface TrustedGatewayRegistration {
  choice: GatewaySetupChoice;
  configuration: ExecutorConfiguration;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function copyConfiguration(
  value: ExecutorConfiguration,
): ExecutorConfiguration {
  if (value.type === "mcp")
    return freeze({ ...value, oauth: value.oauth && { ...value.oauth } });
  return freeze({
    ...value,
    oauth: value.oauth && { ...value.oauth },
    environment: { ...value.environment },
    operations: value.operations.map((operation) => ({
      ...operation,
      inputSchema: structuredClone(operation.inputSchema),
    })),
  });
}

/** Trusted host-code registrations only. There is deliberately no JSON/API method
 * for installing arbitrary commands, config paths, OAuth issuers or endpoints. */
export class TrustedGatewayRegistry {
  private readonly entries = new Map<string, TrustedGatewayRegistration>();
  constructor(registrations: readonly TrustedGatewayRegistration[]) {
    if (registrations.length > 32)
      throw new Error("Too many gateway adapters.");
    const references = new Set<string>();
    for (const registration of registrations) {
      const choice = structuredClone(registration.choice);
      const configuration = copyConfiguration(registration.configuration);
      const reference =
        choice.transport.type === "mcp"
          ? choice.transport.serverConfigRef
          : choice.transport.executorConfigRef;
      if (
        !/^[a-z][a-z0-9._-]{0,79}$/.test(choice.id) ||
        !reference ||
        this.entries.has(choice.id) ||
        references.has(reference) ||
        choice.transport.type !== configuration.type ||
        !Number.isSafeInteger(configuration.timeoutMs) ||
        configuration.timeoutMs < 1 ||
        configuration.timeoutMs > 120_000 ||
        choice.authenticationMethods.length === 0 ||
        new Set(choice.authenticationMethods).size !==
          choice.authenticationMethods.length
      )
        throw new Error("Invalid trusted gateway registration.");
      if (configuration.type === "mcp")
        assertHttpEndpoint(configuration.url, configuration.allowLoopbackHttp);
      references.add(reference);
      this.entries.set(choice.id, freeze({ choice, configuration }));
    }
  }
  setupChoices(): GatewaySetupChoice[] {
    return [...this.entries.values()].map((entry) =>
      structuredClone(entry.choice),
    );
  }
  readonly resolve: ResolveExecutorConfiguration = async (reference) => {
    for (const entry of this.entries.values()) {
      const transport = entry.choice.transport;
      if (
        (transport.type === "mcp"
          ? transport.serverConfigRef
          : transport.executorConfigRef) === reference
      )
        return entry.configuration;
    }
    throw new Error("Trusted gateway configuration is unavailable.");
  };
  assertConnection(
    connection: Pick<
      ServiceConnection,
      "service" | "transport" | "authentication"
    >,
  ): void {
    const reference = configurationReference(connection as ServiceConnection);
    const match = [...this.entries.values()].find((entry) => {
      const transport = entry.choice.transport;
      return (
        (transport.type === "mcp"
          ? transport.serverConfigRef
          : transport.executorConfigRef) === reference
      );
    });
    if (
      !match ||
      match.choice.service !== connection.service ||
      canonicalJson(match.choice.transport) !==
        canonicalJson(connection.transport) ||
      !match.choice.authenticationMethods.includes(
        connection.authentication.method,
      )
    )
      throw new Error(
        "Connection does not match a supported owner setup choice.",
      );
  }
}

/** Official endpoints verified against https://linear.app/docs/mcp. Credentials
 * must be explicitly entered by the owner into Crew. No personal connector reuse.
 * Token setup is supported now; interactive OAuth requires a separate verified
 * registration/callback implementation and is intentionally not advertised. */
export function createSupportedGatewayRegistry(): TrustedGatewayRegistry {
  return new TrustedGatewayRegistry([
    {
      choice: {
        id: "linear-readonly",
        label: "Linear (read only)",
        service: "linear",
        transport: { type: "mcp", serverConfigRef: "crew.linear.readonly.v1" },
        authenticationMethods: ["token"],
      },
      configuration: {
        type: "mcp",
        url: "https://mcp.linear.app/mcp/readonly",
        timeoutMs: 30_000,
      },
    },
    {
      choice: {
        id: "linear",
        label: "Linear",
        service: "linear",
        transport: { type: "mcp", serverConfigRef: "crew.linear.v1" },
        authenticationMethods: ["token"],
      },
      configuration: {
        type: "mcp",
        url: "https://mcp.linear.app/mcp",
        timeoutMs: 30_000,
      },
    },
  ]);
}
