import type {
  AuthorizationService,
  BrokerInvocation,
  CallerContext,
} from "../agents/contracts.mjs";
import { DurableOperationBroker } from "./broker.mjs";
import { TrustedServiceExecutor } from "./executor.mjs";
import { GatewayCatalogue } from "./catalogue.mjs";
import { GatewayStore, operationKey } from "./store.mjs";
import type {
  GatewayConnections,
  GatewayCredentialVault,
  GatewayExecutionAdmission,
  ResolveExecutorConfiguration,
} from "./config.mjs";

/** Host composition only. The host binds authenticated MCP transports separately.
 * Credentials, connection authority and live-session facts are supplied by #89/#88. */
export async function createGateway(options: {
  privateDirectory: string;
  authorization: AuthorizationService;
  vault: GatewayCredentialVault;
  admission: GatewayExecutionAdmission;
  connections: GatewayConnections;
  resolveConfiguration: ResolveExecutorConfiguration;
  validateCaller(caller: CallerContext, jobId: string | null): Promise<boolean>;
}): Promise<{
  broker: DurableOperationBroker;
  executor: TrustedServiceExecutor;
  store: GatewayStore;
  catalogue: GatewayCatalogue;
}> {
  const store = new GatewayStore(options.privateDirectory);
  await store.initialize();
  let catalogue: GatewayCatalogue;
  const executor = new TrustedServiceExecutor({
    ...options,
    onCatalogue: (connection, capabilities) =>
      catalogue.observe(connection, capabilities),
    canDispatch: async (invocation: BrokerInvocation) =>
      (await options.validateCaller(invocation.caller, invocation.jobId)) &&
      !(await store.isCancelled(
        operationKey(invocation.caller, invocation.operation.invocationId),
      )),
  });
  catalogue = new GatewayCatalogue((connection) =>
    executor.listCapabilities(connection),
  );
  const broker = new DurableOperationBroker({
    ...options,
    store,
    executor,
    activeExecutorInvocations: () => executor.activeInvocationIds,
  });
  return { broker, executor, store, catalogue };
}
