import { randomUUID } from "node:crypto";
import type {
  AttemptNumber,
  AuthorizationService,
  BrokerCallOptions,
  BrokerInvocation,
  BrokerResult,
  BrokerSettlement,
  CallerContext,
  ExecutorResult,
  JsonObject,
  OperationBroker,
  ServiceCapability,
  ServiceExecutor,
} from "../agents/contracts.mjs";
import type { GatewayConnections } from "./config.mjs";
import { canonicalJson, normalizeArguments } from "./json.mjs";
import { GatewayStore, operationKey } from "./store.mjs";
import type { StoredOperation } from "./store.mjs";

const now = () => new Date().toISOString();
const denied = (reason: string): BrokerResult => ({ state: "denied", reason });
const sameCaller = (a: CallerContext, b: CallerContext) =>
  canonicalJson(a) === canonicalJson(b);

export interface GatewayBrokerOptions {
  store: GatewayStore;
  authorization: AuthorizationService;
  executor: ServiceExecutor;
  connections: GatewayConnections;
  /** #88 validates actual live session, project/job ownership and current lifecycle admission.
   * #89 redeem must participate in the host's final execution-reservation barrier. */
  validateCaller(caller: CallerContext, jobId: string | null): Promise<boolean>;
  activeExecutorInvocations?: () => Iterable<string>;
}

export class DurableOperationBroker implements OperationBroker {
  private readonly running = new Map<
    string,
    {
      invocation: BrokerInvocation;
      controller: AbortController;
      result: Promise<BrokerResult>;
    }
  >();
  constructor(private readonly options: GatewayBrokerOptions) {}

  async listCapabilities(caller: CallerContext): Promise<ServiceCapability[]> {
    if (!(await this.options.validateCaller(caller, null))) return [];
    const connections = await this.options.connections.listAssigned(caller);
    const result: ServiceCapability[] = [];
    for (const connection of connections) {
      if (connection.projectId !== caller.projectId) continue;
      // Discovery is authenticated but never an execution grant. An unavailable connection
      // fails listing truthfully instead of showing a fabricated/stale catalogue.
      result.push(
        ...(await this.options.executor.listCapabilities(connection)),
      );
    }
    return result;
  }

  async invoke(
    input: BrokerInvocation,
    options: BrokerCallOptions = {},
  ): Promise<BrokerResult> {
    if (!(await this.options.validateCaller(input.caller, input.jobId)))
      return denied("Caller session or job is unavailable.");
    const id = input.operation.invocationId;
    if (typeof id !== "string" || !id || id.length > 160)
      return denied("Invalid invocation identity.");
    const key = operationKey(input.caller, id);
    const existing = await this.options.store.read(key);
    let invocation: BrokerInvocation;
    let inputSchema: JsonObject;
    try {
      if (existing) inputSchema = existing.inputSchema;
      else {
        const capabilities = await this.listCapabilities(input.caller);
        const capability = capabilities.find(
          (item) =>
            item.id === input.operation.operation &&
            item.connectionId === input.operation.connectionId,
        );
        if (!capability)
          return denied(
            "Operation is not in the assigned connection catalogue.",
          );
        inputSchema = capability.inputSchema;
      }
      const normalized = normalizeArguments(
        inputSchema,
        input.operation.arguments,
      );
      invocation = {
        caller: { ...input.caller },
        jobId: input.jobId,
        operation: { ...input.operation, ...normalized },
        createdAt: now(),
      };
    } catch {
      return denied(
        "Tool discovery or argument validation failed; no operation was dispatched.",
      );
    }

    if (existing && !this.matches(existing, invocation))
      return denied(
        "Invocation identity is immutable; supplied operation differs.",
      );
    const active = this.running.get(key);
    if (active) {
      if (
        canonicalJson({
          caller: active.invocation.caller,
          jobId: active.invocation.jobId,
          operation: active.invocation.operation,
        }) !==
        canonicalJson({
          caller: invocation.caller,
          jobId: invocation.jobId,
          operation: invocation.operation,
        })
      )
        return denied("Active invocation identity is immutable.");
      return active.result;
    }
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
    const result = this.options.store.locked(key, () =>
      this.run(key, invocation, inputSchema, { ...options, signal }),
    );
    this.running.set(key, { invocation, controller, result });
    try {
      return await result;
    } finally {
      this.running.delete(key);
    }
  }

  private matches(
    record: StoredOperation,
    invocation: BrokerInvocation,
  ): boolean {
    const { arguments: _arguments, ...identity } = invocation.operation;
    return (
      sameCaller(record.receipt.caller, invocation.caller) &&
      record.receipt.jobId === invocation.jobId &&
      canonicalJson(record.receipt.operation) === canonicalJson(identity)
    );
  }

  private async run(
    key: string,
    invocation: BrokerInvocation,
    inputSchema: JsonObject,
    options: BrokerCallOptions,
  ): Promise<BrokerResult> {
    let record = await this.options.store.read(key);
    if (record && !this.matches(record, invocation))
      return denied("Invocation identity is immutable.");
    if (!record) {
      const { arguments: _arguments, ...identity } = invocation.operation;
      record = {
        version: 1,
        inputSchema,
        invocation,
        result: null,
        settlement: null,
        receipt: {
          id: randomUUID(),
          caller: invocation.caller,
          jobId: invocation.jobId,
          operation: identity,
          reservationId: null,
          grantId: null,
          attempts: [],
          outcome: "pending",
          externalReference: null,
          verificationRef: null,
          startedAt: now(),
          settledAt: null,
        },
      };
      await this.options.store.save(key, record);
    }
    await this.flushSettlement(key, record);
    if (
      record.receipt.outcome === "succeeded" ||
      record.receipt.outcome === "failed" ||
      record.result?.state === "denied"
    )
      return this.result(record);
    if (
      record.receipt.attempts.some(
        (attempt) =>
          attempt.outcome === "pending" || attempt.outcome === "uncertain",
      )
    ) {
      await this.verify(key, record, options);
      if (record.result?.state !== "not_executed") return this.result(record);
    }
    if (options.signal?.aborted || (await this.options.store.isCancelled(key)))
      return this.cancelUnsent(key, record);
    if (record.receipt.attempts.length >= 4) return this.result(record);
    if (
      !(await this.options.validateCaller(invocation.caller, invocation.jobId))
    )
      return denied("Caller is no longer available.");

    if (record.receipt.reservationId === null) {
      const decision =
        await this.options.authorization.authorizeAndReserve(invocation);
      if (decision.state !== "allowed") {
        record.result =
          decision.state === "approval_required"
            ? {
                state: "approval_required",
                accessRequestId: decision.accessRequestId,
              }
            : denied("Current access policy denied the operation.");
        if (decision.state === "denied") record.invocation = null;
        await this.options.store.save(key, record);
        return record.result;
      }
      record.receipt.reservationId = decision.reservationId;
      record.receipt.grantId =
        decision.sources.find((source) => source.type === "grant")?.grantId ??
        null;
      record.result = null;
      await this.options.store.save(key, record);
    }
    while (record.receipt.attempts.length < 4) {
      if (
        options.signal?.aborted ||
        (await this.options.store.isCancelled(key))
      )
        return this.cancelUnsent(key, record);
      if (
        !(await this.options.validateCaller(
          invocation.caller,
          invocation.jobId,
        ))
      )
        return this.cancelUnsent(key, record);
      const attempt = {
        id: randomUUID(),
        number: (record.receipt.attempts.length + 1) as AttemptNumber,
        startedAt: now(),
        settledAt: null,
        outcome: "pending" as const,
        evidenceRef: null,
      };
      // Durable before beginAttempt/redeem. Crash in either window is reconciled, never replayed.
      record.receipt.attempts.push(attempt);
      record.receipt.outcome = "pending";
      record.receipt.settledAt = null;
      record.result = null;
      await this.options.store.save(key, record);
      const permission = await this.options.authorization.beginAttempt(
        record.receipt.reservationId!,
        attempt.id,
      );
      if (permission.state !== "allowed") {
        await this.recordOutcome(
          key,
          record,
          {
            state: "not_executed",
            evidenceRef: `gateway:permit-denied:${attempt.id}`,
            reason: "Fresh execution permission was denied.",
          },
          false,
        );
        record.result = denied("Fresh execution permission was denied.");
        record.invocation = null;
        await this.options.store.save(key, record);
        return record.result;
      }
      let outcome: ExecutorResult;
      try {
        outcome = await this.options.executor.execute(
          invocation,
          permission.permit,
          options,
        );
      } catch {
        outcome = {
          state: "uncertain",
          verificationRef: null,
          reason: "Executor returned no confirmed outcome.",
        };
      }
      await this.recordOutcome(key, record, outcome, true);
      if (outcome.state === "uncertain")
        await this.verify(key, record, options);
      if (this.result(record).state !== "not_executed")
        return this.result(record);
      // Only conclusive non-execution reaches the next attempt, with the same reservation.
    }
    record.invocation = null;
    await this.options.store.save(key, record);
    return this.result(record);
  }

  private async recordOutcome(
    key: string,
    record: StoredOperation,
    outcome: ExecutorResult,
    settle: boolean,
  ): Promise<void> {
    const attempt = record.receipt.attempts.at(-1);
    if (!attempt) throw new Error("Missing operation attempt.");
    attempt.outcome = outcome.state;
    attempt.settledAt = now();
    if (outcome.state === "not_executed")
      attempt.evidenceRef = outcome.evidenceRef;
    record.receipt.outcome = outcome.state;
    record.receipt.settledAt = attempt.settledAt;
    if (outcome.state === "succeeded" || outcome.state === "failed")
      record.receipt.externalReference = outcome.externalReference;
    if (outcome.state === "uncertain")
      record.receipt.verificationRef = outcome.verificationRef;
    record.result =
      outcome.state === "succeeded"
        ? {
            state: "succeeded",
            receiptId: record.receipt.id,
            content: outcome.content,
          }
        : {
            state: outcome.state,
            receiptId: record.receipt.id,
            reason: outcome.reason,
          };
    if (outcome.state === "succeeded" || outcome.state === "failed")
      record.invocation = null;
    if (settle)
      record.settlement = {
        attemptId: attempt.id,
        result:
          outcome.state === "uncertain"
            ? { state: "uncertain", receiptId: record.receipt.id }
            : outcome.state === "not_executed"
              ? {
                  state: "not_executed",
                  receiptId: record.receipt.id,
                  evidence: outcome.evidenceRef,
                }
              : { state: "accepted", receiptId: record.receipt.id },
      };
    await this.options.store.save(key, record);
    await this.flushSettlement(key, record);
  }
  private async flushSettlement(
    key: string,
    record: StoredOperation,
  ): Promise<void> {
    if (!record.settlement || !record.receipt.reservationId) return;
    await this.options.authorization.settle(
      record.receipt.reservationId,
      record.settlement.attemptId,
      record.settlement.result,
    );
    record.settlement = null;
    await this.options.store.save(key, record);
  }
  private async verify(
    key: string,
    record: StoredOperation,
    options: BrokerCallOptions = {},
  ): Promise<void> {
    const result = await this.options.executor.verify(record.receipt, options);
    if (result.state === "executed") {
      record.receipt.verificationRef = result.evidenceRef;
      await this.recordOutcome(
        key,
        record,
        {
          state: "succeeded",
          content: result.content,
          externalReference: result.externalReference,
        },
        true,
      );
    } else if (result.state === "not_executed") {
      record.receipt.verificationRef = result.evidenceRef;
      await this.recordOutcome(
        key,
        record,
        {
          state: "not_executed",
          evidenceRef: result.evidenceRef,
          reason: result.explanation,
        },
        true,
      );
    } else {
      await this.recordOutcome(
        key,
        record,
        {
          state: "uncertain",
          verificationRef: record.receipt.verificationRef,
          reason: result.reason,
        },
        true,
      );
    }
  }
  private result(record: StoredOperation): BrokerResult {
    if (
      record.result?.state === "succeeded" &&
      record.result.content.length === 0
    )
      return {
        ...record.result,
        content: [
          {
            type: "text",
            text: "This operation already succeeded. Its response body is not retained by the gateway; use native history or a read-only provider lookup.",
          },
        ],
      };
    return (
      record.result ?? {
        state: "uncertain",
        receiptId: record.receipt.id,
        reason: "Retained execution requires reconciliation.",
      }
    );
  }
  private async cancelUnsent(
    key: string,
    record: StoredOperation,
  ): Promise<BrokerResult> {
    await this.options.store.cancel(key);
    if (record.receipt.reservationId)
      await this.options.authorization.releaseNotExecuted(
        record.receipt.reservationId,
        "Gateway cancelled before the next dispatch.",
      );
    record.receipt.outcome = "not_executed";
    record.receipt.settledAt = now();
    record.result = {
      state: "not_executed",
      receiptId: record.receipt.id,
      reason: "Cancelled before dispatch; no further attempts will run.",
    };
    record.invocation = null;
    await this.options.store.save(key, record);
    return record.result;
  }
  async reconcile(
    caller: CallerContext,
    invocationId: string,
  ): Promise<BrokerResult> {
    if (!(await this.options.validateCaller(caller, null)))
      return denied("Caller session is unavailable.");
    return this.reconcileOwned(caller, invocationId);
  }
  async resumePending(
    caller: CallerContext,
    invocationId: string,
    options: BrokerCallOptions = {},
  ): Promise<BrokerResult> {
    if (!(await this.options.validateCaller(caller, null)))
      return denied("Caller session is unavailable.");
    const record = await this.options.store.read(
      operationKey(caller, invocationId),
    );
    if (!record || !sameCaller(record.receipt.caller, caller))
      return denied("Invocation does not belong to this caller.");
    if (!record.invocation) return this.result(record);
    return this.invoke(record.invocation, options);
  }
  /** MCP-specific name resolution. Retained IDs never depend on upstream discovery. */
  async invokeTool(
    caller: CallerContext,
    invocationId: string,
    name: string,
    arguments_: JsonObject,
    options: BrokerCallOptions = {},
  ): Promise<BrokerResult> {
    if (!(await this.options.validateCaller(caller, null)))
      return denied("Caller session is unavailable.");
    const record = await this.options.store.read(
      operationKey(caller, invocationId),
    );
    if (
      record &&
      (!sameCaller(record.receipt.caller, caller) ||
        record.receipt.operation.operation !== name)
    )
      return denied("Invocation identity is immutable.");
    const connectionId =
      record?.receipt.operation.connectionId ??
      (await this.listCapabilities(caller)).find((item) => item.id === name)
        ?.connectionId;
    if (!connectionId) return denied("Tool is unavailable for this session.");
    return this.invoke(
      {
        caller,
        jobId: null,
        createdAt: now(),
        operation: {
          invocationId,
          connectionId,
          operation: name,
          arguments: arguments_,
          argumentsFingerprint: "",
        },
      },
      options,
    );
  }
  /** Trusted lifecycle recovery only: verifies old-session receipts without starting execution. */
  async reconcileOwned(
    caller: CallerContext,
    invocationId: string,
  ): Promise<BrokerResult> {
    const key = operationKey(caller, invocationId);
    if (this.running.has(key))
      return {
        state: "uncertain",
        receiptId: (await this.options.store.read(key))!.receipt.id,
        reason: "This operation is still being observed by its executor.",
      };
    return this.options.store.locked(key, async () => {
      const record = await this.options.store.read(key);
      if (!record || !sameCaller(record.receipt.caller, caller))
        return denied("Invocation does not belong to this caller.");
      await this.flushSettlement(key, record);
      if (
        record.receipt.attempts.some(
          (item) => item.outcome === "pending" || item.outcome === "uncertain",
        )
      )
        await this.verify(key, record);
      return this.result(record);
    });
  }
  async cancel(
    caller: CallerContext,
    invocationId: string,
  ): Promise<BrokerResult> {
    if (!(await this.options.validateCaller(caller, null)))
      return denied("Caller session is unavailable.");
    const key = operationKey(caller, invocationId);
    const record = await this.options.store.read(key);
    if (!record || !sameCaller(record.receipt.caller, caller))
      return denied("Invocation does not belong to this caller.");
    await this.options.store.cancel(key);
    const active = this.running.get(key);
    if (active) {
      active.controller.abort();
      return active.result;
    }
    return this.options.store.locked(key, async () => {
      const latest = (await this.options.store.read(key))!;
      await this.flushSettlement(key, latest);
      if (
        latest.receipt.attempts.some(
          (item) => item.outcome === "pending" || item.outcome === "uncertain",
        )
      )
        await this.verify(key, latest);
      if (["succeeded", "failed", "uncertain"].includes(latest.receipt.outcome))
        return this.result(latest);
      return this.cancelUnsent(key, latest);
    });
  }
  async settlement(projectId: string): Promise<BrokerSettlement> {
    const records = (await this.options.store.all()).filter(
      (record) => record.receipt.caller.projectId === projectId,
    );
    const live = new Set(this.options.activeExecutorInvocations?.() ?? []);
    return {
      inFlightInvocationIds: records
        .filter(
          (record) =>
            this.running.has(
              operationKey(
                record.receipt.caller,
                record.receipt.operation.invocationId,
              ),
            ) || live.has(record.receipt.operation.invocationId),
        )
        .map((record) => record.receipt.operation.invocationId),
      uncertainInvocationIds: records
        .filter(
          (record) =>
            record.settlement !== null ||
            record.receipt.outcome === "uncertain" ||
            record.receipt.attempts.some(
              (attempt) => attempt.outcome === "pending",
            ),
        )
        .map((record) => record.receipt.operation.invocationId),
      pendingApprovalIds: records.flatMap((record) =>
        record.result?.state === "approval_required"
          ? [record.result.accessRequestId]
          : [],
      ),
      observedAt: now(),
    };
  }
}
