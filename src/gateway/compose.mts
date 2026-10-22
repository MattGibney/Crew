import type {
  AuthorizationService,
  BrokerInvocation,
  CallerContext,
  CredentialVault,
} from "../agents/contracts.mjs";
import { DurableOperationBroker } from "./broker.mjs";
import { TrustedServiceExecutor } from "./executor.mjs";
import { GatewayStore, operationKey } from "./store.mjs";
import type {
  GatewayConnections,
  ResolveExecutorConfiguration,
} from "./config.mjs";

/** Host composition only. The host binds authenticated MCP transports separately.
 * Credentials, connection authority and live-session facts are supplied by #89/#88. */
export async function createGateway(options: {
  privateDirectory: string;
  authorization: AuthorizationService;
  vault: CredentialVault;
  connections: GatewayConnections;
  resolveConfiguration: ResolveExecutorConfiguration;
  validateCaller(caller: CallerContext, jobId: string | null): Promise<boolean>;
}): Promise<{
  broker: DurableOperationBroker;
  executor: TrustedServiceExecutor;
  store: GatewayStore;
}> {
  const store = new GatewayStore(options.privateDirectory);
  await store.initialize();
  const executor = new TrustedServiceExecutor({
    ...options,
    canDispatch: async (invocation: BrokerInvocation) =>
      !(await store.isCancelled(
        operationKey(invocation.caller, invocation.operation.invocationId),
      )) && (await options.validateCaller(invocation.caller, invocation.jobId)),
  });
  const broker = new DurableOperationBroker({
    ...options,
    store,
    executor,
    activeExecutorInvocations: () => executor.activeInvocationIds,
  });
  return { broker, executor, store };
}
