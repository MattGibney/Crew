import type {
  BrokerCallOptions,
  CallerContext,
  CredentialVault,
  BrokerInvocation,
  ExecutionPermit,
  JsonObject,
  OperationReceipt,
  ServiceConnection,
  TrustedCredentialHandle,
  VerificationResult,
} from "../agents/contracts.mjs";

/** Adapter functions over #89's connection store, not another connection authority. */
export interface GatewayConnections {
  get(connectionId: string): Promise<ServiceConnection | null>;
  listAssigned(caller: CallerContext): Promise<ServiceConnection[]>;
  allowedOperations?(
    caller: CallerContext,
    connectionId: string,
  ): Promise<string[]>;
}
export interface OAuthRefreshConfiguration {
  tokenEndpoint: string; // Owner-verified issuer metadata, never an argument/provider redirect.
  clientId: string;
  resource: string;
  clientAuthentication: "none" | "client_secret_post";
}
type ReadOnlyVerifier = (
  receipt: OperationReceipt,
  credential: TrustedCredentialHandle | null,
  options: BrokerCallOptions,
) => Promise<VerificationResult>;
interface CommonConfiguration {
  timeoutMs: number;
  oauth?: OAuthRefreshConfiguration;
  /** Trusted provider-specific read-only receipt lookup. No generic timeout guesses. */
  verify?: ReadOnlyVerifier;
}
export interface McpHttpConfiguration extends CommonConfiguration {
  type: "mcp";
  /** Trusted namespaced tool adapter; Gmail uses fixed first-party REST. */
  adapter?: "gmail-rest";
  gmailWrite?: boolean;
  url: string;
  allowLoopbackHttp?: boolean; // Disposable fixtures only; production requires HTTPS.
}
export interface CliOperation {
  name: string;
  description: string;
  inputSchema: JsonObject;
  /** Trusted code maps validated inputs to exact argv/stdin. No shell parsing. */
  map(arguments_: JsonObject): { argv: string[]; stdin?: string };
}
export interface CliConfiguration extends CommonConfiguration {
  type: "cli";
  executable: string; // Absolute owner-controlled binary, never agent supplied.
  executableSha256: string;
  cwd: string;
  environment: Record<string, string>; // Explicit clean environment, including private HOME if needed.
  credentialInput:
    | { type: "environment"; name: string }
    | { type: "stdin" }
    | { type: "none" };
  operations: CliOperation[];
}
export type ExecutorConfiguration = McpHttpConfiguration | CliConfiguration;
/** Trusted configuration is installed by the host; not writable through runtime tools. */
export type ResolveExecutorConfiguration = (
  reference: string,
) => Promise<ExecutorConfiguration>;
export function configurationReference(connection: ServiceConnection): string {
  return connection.transport.type === "mcp"
    ? connection.transport.serverConfigRef
    : connection.transport.executorConfigRef;
}
export function assertHttpEndpoint(
  value: string,
  allowLoopbackHttp = false,
): URL {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !(
      url.protocol === "https:" ||
      (allowLoopbackHttp &&
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw new Error("Unsupported trusted endpoint configuration.");
  return url;
}

/** The real vault supplies both CAS metadata and its own unforgeable replacement
 * handle. Connection revisions are unrelated to credential revisions. */
export interface GatewayCredentialVault extends CredentialVault {
  metadataForReference(reference: string): Promise<{
    credentialRef: string;
    revision: number;
    deleted: boolean;
  }>;
  withReplacement<T>(
    connectionId: string,
    material: Uint8Array,
    use: (handle: TrustedCredentialHandle) => Promise<T>,
  ): Promise<T>;
}

/** Production composition supplies the SAME admission gate used by final
 * Quit/update reservation. run obtains a live-session lease, redeems the fresh
 * permit inside that lease, invokes dispatch and retains the lease until settled.
 * A preliminary async validateCaller is never an implementation of this port. */
export interface GatewayExecutionAdmission {
  run<T>(
    invocation: BrokerInvocation,
    permit: ExecutionPermit,
    dispatch: () => Promise<T>,
  ): Promise<{ state: "denied" } | { state: "admitted"; result: T }>;
}
