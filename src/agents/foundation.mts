import { randomUUID } from "node:crypto";
import type {
  Agent,
  Actor,
  AgentProvisioning,
  ExecutionAdmissionGate,
  AgentEnvironmentService,
  AgentContent,
  AgentLifecycle,
  AgentMessage,
  AgentRuntimeAdapter,
  AuthorizationService,
  BrokerInvocation,
  CallerContext,
  ConfigurationSnapshot,
  DeliveryResult,
  ExecutionReservation,
  JsonValue,
  ModelAccess,
  MessageSender,
  OperationBroker,
  PreparationReadiness,
  RuntimeAccessProvider,
  RuntimeBinding,
  RuntimeError,
  RuntimeEvent,
  RuntimeResult,
  RuntimeStartResult,
} from "./contracts.mjs";
import {
  FoundationRecords,
  type FoundationPrincipal,
  type FoundationReferences,
} from "./records.mjs";
import { FoundationStore, messageIntentFingerprint } from "./store.mjs";

const now = () => new Date().toISOString();
const error = (code: RuntimeError["code"], message: string): RuntimeError => ({
  code,
  message,
});
const failed = (message: string): RuntimeResult<never> => ({
  state: "failed",
  error: error("runtime_error", message),
});

export interface FoundationOptions {
  store: FoundationStore;
  runtime: AgentRuntimeAdapter;
  access: RuntimeAccessProvider;
  authorization: AuthorizationService;
  broker: OperationBroker;
  references: FoundationReferences;
  configuration(agent: Agent): Promise<{
    configuration: ConfigurationSnapshot;
    modelAccess: ModelAccess;
  }>;
  /** Trusted native control channel, never a fabricated user message. If absent,
   * preparation is visible but blocked until a genuine request is supplied. */
  requestPreparation?: (
    binding: RuntimeBinding,
    reason: ExecutionReservation["reason"],
    preparationId: string,
  ) => Promise<void>;
  /** Must be wired to #89's fresh admission predicate before reservation is usable.
   * Existing admitted operations are then checked through broker.settlement. */
  admissionUsesFoundationBarrier: boolean;
  admission?: ExecutionAdmissionGate;
  provisioning?: AgentProvisioning;
  environments?: AgentEnvironmentService;
  /** Synchronous trusted voice admission state, checked again under the shared gate. */
  privateInputBlocked?: (binding: RuntimeBinding) => boolean;
  /** Local durable activity only. Must never wait on remote work while reserving. */
  executionSettlement?: (
    caller?: CallerContext,
  ) => Promise<{ settled: boolean; detail: string }>;
  /** Trusted runtime Stop acknowledgement or independently confirmed process exit only. */
  confirmVoiceExit?: (binding: RuntimeBinding) => Promise<void>;
  confirmNativeExit?: (
    caller: CallerContext,
  ) => Promise<{ confirmed: boolean; detail: string }>;
}

export interface SendInput {
  id?: string;
  recipientAgentId: string;
  jobId: string | null;
  replyToMessageId: string | null;
  kind?: AgentMessage["kind"];
  content: AgentContent[];
  deliveryMode: AgentMessage["deliveryMode"];
}

/** One project and one durable writer. UI and authenticated tool transports use
 * this same service; there is no second manager/worker runtime. */
export class AgentFoundation implements AgentLifecycle {
  readonly records: FoundationRecords;
  readonly store: FoundationStore;
  private readonly options: FoundationOptions;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly observers = new Map<string, AsyncIterator<RuntimeEvent>>();
  private readonly terminalTurns = new Set<string>();
  private disposed = false;

  constructor(options: FoundationOptions) {
    this.options = options;
    this.store = options.store;
    this.records = new FoundationRecords(
      options.store,
      options.authorization,
      options.references,
    );
  }

  /** Reads current assignments from access; persisted empty fields are never authority. */
  async agentViews(): Promise<Agent[]> {
    const agents = this.store.snapshot().agents;
    return Promise.all(
      agents.map(async (agent) => ({
        ...agent,
        access: this.options.provisioning
          ? await this.options.provisioning.accessFor(agent.id)
          : agent.access,
        resources: this.options.environments?.resources
          ? await this.options.environments.resources(agent.id)
          : agent.resources,
      })),
    );
  }

  async creationPresets() {
    return this.options.provisioning?.listPresets() ?? [];
  }

  async createFromPreset(
    principal: FoundationPrincipal,
    input: {
      presetId: string;
      expectedPresetRevision: number;
      name?: string;
      reportsTo?: Actor;
    },
  ): Promise<Agent> {
    if (!this.options.provisioning)
      throw new Error("Owner-approved creation presets are unavailable.");
    if (
      Object.keys(input).some(
        (key) =>
          !["presetId", "expectedPresetRevision", "name", "reportsTo"].includes(
            key,
          ),
      )
    )
      throw new Error(
        "Creation accepts only an approved preset and display name.",
      );
    const actor = await this.records.authorize(principal, "agents.create", {
      type: "project",
    });
    const preset = (await this.options.provisioning.listPresets()).find(
      (row) => row.id === input.presetId,
    );
    if (
      !preset ||
      !preset.enabled ||
      preset.projectId !== this.store.snapshot().projectId ||
      preset.revision !== input.expectedPresetRevision
    )
      throw new Error(
        "Creation preset changed or is unavailable; refresh owner-approved choices.",
      );
    const agent = await this.records.createAgent(
      principal,
      {
        profile: {
          ...preset.profile,
          ...(input.name === undefined ? {} : { name: input.name }),
        },
        modelAccessId: preset.modelAccessId,
        configRef: preset.configRef,
        skills: preset.skills,
        ...(input.reportsTo === undefined
          ? {}
          : { reportsTo: input.reportsTo }),
      },
      { presetId: preset.id, presetRevision: preset.revision },
    );
    try {
      const access = await this.admit(async () => {
        if (this.store.snapshot().reservation)
          throw new Error("Execution is reserved.");
        const current = await this.options.provisioning!.applyPreset({
          actor,
          agentId: agent.id,
          presetId: preset.id,
          expectedPresetRevision: preset.revision,
        });
        await this.store.update((state) => {
          state.provisioning.find((row) => row.agentId === agent.id)!.state =
            "ready";
        });
        return current;
      });
      return { ...agent, access };
    } catch {
      await this.store.update((state) => {
        const row = state.provisioning.find((row) => row.agentId === agent.id)!;
        row.state = "failed";
        row.error =
          "Approved access could not be provisioned. Start is held; review the preset and retry provisioning.";
      });
      throw new Error(
        "Agent retained with failed provisioning; it cannot Start until owner-approved access is applied.",
      );
    }
  }

  async retryProvisioning(
    principal: FoundationPrincipal,
    agentId: string,
  ): Promise<void> {
    if (
      !this.options.provisioning ||
      principal.type !== "owner" ||
      principal.userId !== this.store.snapshot().ownerUserId
    )
      throw new Error("Owner provisioning recovery required.");
    const row = this.store
      .snapshot()
      .provisioning.find((item) => item.agentId === agentId);
    if (!row || row.state === "ready")
      throw new Error("No incomplete provisioning to retry.");
    await this.admit(async () => {
      if (this.store.snapshot().reservation)
        throw new Error("Execution is reserved.");
      await this.options.provisioning!.applyPreset({
        actor: row.creator,
        agentId,
        presetId: row.presetId,
        expectedPresetRevision: row.presetRevision,
      });
      await this.store.update((state) => {
        const current = state.provisioning.find(
          (item) => item.agentId === agentId,
        )!;
        current.state = "ready";
        current.error = null;
      });
    });
  }

  async setPrimary(
    principal: FoundationPrincipal,
    agentId: string | null,
    expectedRevision: number,
  ) {
    const current = this.store.snapshot();
    if (principal.type !== "owner" || principal.userId !== current.ownerUserId)
      throw new Error(
        "Only the authenticated owner selects the primary agent.",
      );
    return this.admit(() =>
      this.store.update((state) => {
        const previous = state.agents.find(
          (row) => row.id === state.projectSettings.primaryAgentId,
        );
        const binding = previous && this.binding(previous);
        if (binding && this.options.privateInputBlocked?.(binding))
          throw new Error(
            "Disconnect the primary agent's voice session before changing the primary agent.",
          );
        if (state.projectSettings.revision !== expectedRevision)
          throw new Error(
            "Primary agent setting changed; refresh before saving.",
          );
        if (
          agentId !== null &&
          !state.agents.some(
            (agent) => agent.id === agentId && !agent.archivedAt,
          )
        )
          throw new Error("Choose an available agent in this project.");
        state.projectSettings.primaryAgentId = agentId;
        state.projectSettings.revision++;
        return state.projectSettings;
      }),
    );
  }

  async environmentList(principal: FoundationPrincipal, agentId: string) {
    await this.records.authorize(principal, "environments.read", {
      type: "agent",
      agentId,
    });
    if (principal.type === "agent" && this.options.environments?.list)
      return this.options.environments.list(principal.caller, agentId);
    return (
      this.options.environments?.resources?.(agentId) ??
      this.agent(agentId).resources
    );
  }

  async environment(
    principal: FoundationPrincipal,
    input: {
      agentId: string;
      action: "create" | "attach" | "execute" | "dispose";
      requestId: string;
      arguments: import("./contracts.mjs").JsonObject;
    },
  ) {
    if (principal.type !== "agent")
      throw new Error("Authenticated agent environment request required.");
    if (!["create", "attach", "execute", "dispose"].includes(input.action))
      throw new Error("Unknown environment action.");
    await this.records.authorize(
      principal,
      `environments.${input.action}`,
      input.action === "create"
        ? { type: "project" }
        : { type: "agent", agentId: input.agentId },
    );
    if (!this.options.environments)
      throw new Error(
        "Explicit environment integration is not configured. Messaging remains available.",
      );
    return this.options.environments.invoke({
      ...input,
      caller: principal.caller,
    });
  }

  private admit<T>(operation: () => Promise<T>): Promise<T> {
    return this.options.admission
      ? this.options.admission.run(operation)
      : operation();
  }

  subscribeRuntime(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private serial<T>(id: string, run: () => Promise<T>): Promise<T> {
    const work = (this.locks.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(run);
    this.locks.set(id, work);
    void work
      .finally(() => {
        if (this.locks.get(id) === work) this.locks.delete(id);
      })
      .catch(() => {});
    return work;
  }

  private agent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((entry) => entry.id === id);
    if (!agent) throw new Error("Agent does not exist in this project.");
    return agent;
  }

  private binding(agent: Agent): RuntimeBinding | null {
    const sessionId = agent.runtime.session.sessionId;
    return sessionId && agent.runtime.threadId
      ? {
          projectId: agent.projectId,
          agentId: agent.id,
          sessionId,
          threadId: agent.runtime.threadId,
        }
      : null;
  }

  /** #89 must consult these fresh facts on admission, never a copied session flag. */
  executionAllowed(caller: CallerContext): boolean {
    const state = this.store.snapshot();
    const agent = state.agents.find((entry) => entry.id === caller.agentId);
    return (
      !this.disposed &&
      !state.reservation &&
      caller.projectId === state.projectId &&
      agent?.runtime.session.sessionId === caller.sessionId &&
      agent.runtime.session.observedState === "started" &&
      agent.runtime.session.desiredState === "started"
    );
  }

  /** Called once before accepting requests after controller recovery. Old logical
   * sessions/grants are closed, not adopted without native ownership proof. */
  async recover(): Promise<void> {
    for (const agent of this.store.snapshot().agents) {
      const session = agent.runtime.session;
      if (!session.sessionId || session.observedState === "stopped") continue;
      await this.options.authorization.closeSession(
        {
          projectId: agent.projectId,
          agentId: agent.id,
          sessionId: session.sessionId,
        },
        "unverifiable_recovery",
      );
      await this.store.update((state) => {
        const current = state.agents.find((entry) => entry.id === agent.id)!;
        current.runtime.session.observedState = "unknown";
        current.runtime.session.lastError = error(
          "disconnected",
          "Previous native ownership is unverified. Resolve the retained session before explicitly starting again.",
        );
        for (const message of state.messages) {
          if (
            message.recipientAgentId !== agent.id ||
            message.delivery.state !== "sending"
          )
            continue;
          message.delivery.state = "uncertain";
          const attempt = message.delivery.attempts.at(-1);
          if (attempt) attempt.outcome = "uncertain";
        }
        for (const approval of state.nativeApprovals) {
          if (approval.agentId === agent.id && approval.state === "responding")
            approval.state = "uncertain";
        }
      });
    }
  }

  async start(agentId: string): Promise<RuntimeStartResult> {
    const result = await this.serial(agentId, () => this.startLocked(agentId));
    if (result.state === "acknowledged")
      void this.pump(agentId).catch(() => {});
    return result;
  }

  /** Authenticated agent entry; recheck authority after waiting for the target's
   * lifecycle lock so queued commands cannot outlive their caller's permission. */
  async lifecycle(
    principal: FoundationPrincipal,
    agentId: string,
    action: "start" | "stop" | "restart",
  ): Promise<RuntimeStartResult | RuntimeResult<null>> {
    const result = await this.serial(agentId, async () => {
      await this.records.authorize(principal, `sessions.${action}`, {
        type: "agent",
        agentId,
      });
      if (action === "start") return this.startLocked(agentId);
      const stopped = await this.stopLocked(
        agentId,
        action === "restart" ? "restart" : "stop",
      );
      if (action === "stop" || stopped.state === "failed") return stopped;
      return this.startLocked(agentId);
    });
    if (result.state === "acknowledged" && action !== "stop")
      void this.pump(agentId).catch(() => {});
    return result;
  }

  private async startLocked(agentId: string): Promise<RuntimeStartResult> {
    const agent = this.agent(agentId);
    const previous = agent.runtime.session;
    const provisioning = this.store
      .snapshot()
      .provisioning.find((row) => row.agentId === agentId);
    if (this.options.provisioning && provisioning?.state !== "ready")
      return {
        state: "failed",
        error: error(
          "configuration_rejected",
          "Owner-approved agent provisioning is incomplete.",
        ),
        retainedThreadId: agent.runtime.threadId,
      };
    const reject = (
      code: RuntimeError["code"],
      message: string,
    ): RuntimeStartResult => ({
      state: "failed",
      error: error(code, message),
      retainedThreadId: agent.runtime.threadId,
    });
    if (this.disposed || this.store.snapshot().reservation)
      return reject(
        "cancelled",
        "Execution is reserved for an explicit lifecycle action.",
      );
    if (agent.archivedAt)
      return reject(
        "cancelled",
        "Unarchive the agent before starting its session.",
      );
    const existing = this.binding(agent);
    if (
      previous.observedState === "started" &&
      existing &&
      previous.appliedConfiguration
    ) {
      return {
        state: "acknowledged",
        value: {
          binding: existing,
          appliedConfiguration: previous.appliedConfiguration,
          observedAt: previous.lastObservedAt ?? now(),
        },
      };
    }
    if (existing && this.options.privateInputBlocked?.(existing))
      return reject(
        "disconnected",
        "The previous voice session or its public history must settle before Start.",
      );
    if (["starting", "stopping", "unknown"].includes(previous.observedState))
      return reject(
        "disconnected",
        "The retained native session must be settled before another Start.",
      );
    if (previous.sessionId && previous.observedState !== "stopped")
      return reject(
        "disconnected",
        "Stop and settle the previous session before another Start.",
      );
    const caller: CallerContext = {
      projectId: agent.projectId,
      agentId,
      sessionId: randomUUID(),
    };
    await this.admit(() =>
      this.store.update((state) => {
        if (state.reservation) throw new Error("Execution is reserved.");
        const current = state.agents.find((entry) => entry.id === agentId)!;
        current.runtime.session = {
          ...current.runtime.session,
          sessionId: caller.sessionId,
          desiredState: "started",
          observedState: "starting",
          activeTurnId: null,
          startedAt: null,
          lastObservedAt: now(),
          lastError: null,
        };
        state.nativeStartAttempts.push({
          agentId,
          sessionId: caller.sessionId,
          dispatched: false,
        });
      }),
    );
    let result: RuntimeStartResult;
    let nativeAttempted = false;
    try {
      const loaded = await this.options.configuration(agent);
      if (
        loaded.configuration.profile.revision !== agent.profile.revision ||
        loaded.modelAccess.id !== agent.runtime.modelAccessId
      )
        throw new Error("Configuration identity changed during preparation.");
      const isolation = await this.options.access.prepare(
        caller,
        loaded.configuration,
      );
      if (isolation.state === "blocked") {
        result = {
          state: "failed",
          error: error("isolation_blocked", isolation.reason),
          retainedThreadId: agent.runtime.threadId,
        };
      } else if (
        isolation.runtimeAccess.caller.projectId !== caller.projectId ||
        isolation.runtimeAccess.caller.agentId !== caller.agentId ||
        isolation.runtimeAccess.caller.sessionId !== caller.sessionId
      ) {
        result = {
          state: "failed",
          error: error(
            "identity_mismatch",
            "Runtime access is bound to a different caller.",
          ),
          retainedThreadId: agent.runtime.threadId,
        };
      } else {
        await this.store.update((state) => {
          if (state.reservation) throw new Error("Execution is reserved.");
          state.nativeStartAttempts.find(
            (entry) => entry.sessionId === caller.sessionId,
          )!.dispatched = true;
        });
        nativeAttempted = true;
        result = await this.options.runtime.start({
          caller,
          thread: agent.runtime.threadId
            ? { mode: "resume", threadId: agent.runtime.threadId }
            : { mode: "create" },
          modelAccess: loaded.modelAccess,
          configuration: loaded.configuration,
          access: isolation.runtimeAccess,
        });
      }
    } catch {
      // An exception may follow native creation; never assume non-execution.
      result = {
        state: nativeAttempted ? "uncertain" : "failed",
        error: error(
          nativeAttempted ? "runtime_error" : "configuration_rejected",
          "Session preparation failed without a native acknowledgement.",
        ),
        retainedThreadId: agent.runtime.threadId,
      };
    }
    if (result.state === "acknowledged") {
      const bound = result.value.binding;
      if (
        bound.agentId !== agentId ||
        bound.projectId !== caller.projectId ||
        bound.sessionId !== caller.sessionId ||
        (agent.runtime.threadId && bound.threadId !== agent.runtime.threadId)
      ) {
        result = {
          state: "uncertain",
          retainedThreadId: agent.runtime.threadId,
          error: error(
            "identity_mismatch",
            "Native acknowledgement did not match this session and retained thread.",
          ),
        };
      }
    }
    const final = result;
    await this.store.update((state) => {
      const current = state.agents.find((entry) => entry.id === agentId)!;
      if (final.state === "acknowledged") {
        current.runtime.threadId = final.value.binding.threadId;
        Object.assign(current.runtime.session, {
          observedState: "started",
          appliedConfiguration: final.value.appliedConfiguration,
          startedAt: now(),
          lastObservedAt: final.value.observedAt,
          lastError: null,
        });
      } else {
        current.runtime.threadId =
          final.retainedThreadId ?? current.runtime.threadId;
        current.runtime.session.observedState =
          final.state === "uncertain" ? "unknown" : "error";
        current.runtime.session.lastError = final.error;
      }
    });
    if (final.state === "acknowledged") this.observe(final.value.binding);
    else {
      await this.options.authorization.closeSession(
        caller,
        "unverifiable_recovery",
      );
      if (!nativeAttempted) {
        // A blocked sign-in/configuration check never dispatched a native Start.
        // Retain its visible error while settling the unused session authority.
        await this.options.access.release(caller);
        await this.store.update((state) => {
          const session = state.agents.find((row) => row.id === agentId)!
            .runtime.session;
          if (session.sessionId !== caller.sessionId)
            throw new Error("Start identity changed during settlement.");
          session.desiredState = "stopped";
          session.observedState = "stopped";
          session.activeTurnId = null;
          session.lastObservedAt = now();
        });
      }
    }
    return final;
  }

  async stop(agentId: string): Promise<RuntimeResult<null>> {
    return this.serial(agentId, () => this.stopLocked(agentId, "stop"));
  }

  private async stopLocked(
    agentId: string,
    reason: "stop" | "restart",
  ): Promise<RuntimeResult<null>> {
    const agent = this.agent(agentId);
    if (agent.runtime.session.observedState === "stopped")
      return { state: "acknowledged", value: null };
    const sessionId = agent.runtime.session.sessionId;
    if (!sessionId) return failed("Native session identity is unavailable.");
    const caller = { projectId: agent.projectId, agentId, sessionId };
    await this.admit(() =>
      this.store.update((state) => {
        const current = state.agents.find((entry) => entry.id === agentId)!;
        current.runtime.session.desiredState = "stopped";
        current.runtime.session.observedState = "stopping";
      }),
    );
    try {
      await this.options.authorization.closeSession(caller, reason);
      const local = await this.options.executionSettlement?.(caller);
      if (local && !local.settled) throw new Error(local.detail);
      const settlement = await this.options.broker.settlement(
        agent.projectId,
        caller,
      );
      if (
        settlement.inFlightInvocationIds.length ||
        settlement.uncertainInvocationIds.length
      )
        throw new Error(
          "Broker operations must settle before stopping this session.",
        );
      const binding = this.binding(agent);
      if (
        !binding &&
        !this.store
          .snapshot()
          .nativeStartAttempts.some(
            (entry) =>
              entry.agentId === agentId &&
              entry.sessionId === sessionId &&
              !entry.dispatched,
          )
      )
        throw new Error(
          "Native thread identity is unavailable; resolve preparation before stopping.",
        );
      const stopped = binding
        ? await this.options.runtime.stop(binding)
        : { state: "acknowledged" as const, value: { stoppedAt: now() } };
      if (stopped.state !== "acknowledged") {
        await this.sessionError(agentId, stopped.error);
        return stopped;
      }
      if (binding) await this.options.confirmVoiceExit?.(binding);
      await this.options.access.release(caller);
      await this.store.update((state) => {
        const current = state.agents.find((entry) => entry.id === agentId)!;
        Object.assign(current.runtime.session, {
          observedState: "stopped",
          activeTurnId: null,
          lastObservedAt: stopped.value.stoppedAt,
          lastError: null,
        });
        // The exact stopped native session can no longer accept these requests.
        state.nativeApprovals = state.nativeApprovals.filter(
          (entry) => entry.sessionId !== sessionId,
        );
      });
      this.observers.delete(sessionId);
      return { state: "acknowledged", value: null };
    } catch {
      const failure = error(
        "runtime_error",
        "Stop is not confirmed. Native ownership or broker execution still needs settlement; no resources were deleted.",
      );
      await this.sessionError(agentId, failure);
      return { state: "failed", error: failure };
    }
  }

  async cancelTurn(
    principal: FoundationPrincipal,
    agentId: string,
  ): Promise<RuntimeResult<null>> {
    await this.records.authorize(principal, "sessions.stop", {
      type: "agent",
      agentId,
    });
    const agent = this.agent(agentId);
    const binding = this.binding(agent);
    if (!binding || !agent.runtime.session.activeTurnId)
      return failed("No acknowledged active turn to interrupt.");
    return this.options.runtime.cancelTurn(
      binding,
      agent.runtime.session.activeTurnId,
    );
  }

  /** Read-only proof of owned app-server exit, never a reset or process signal. */
  async recoverSession(
    principal: FoundationPrincipal,
    agentId: string,
  ): Promise<RuntimeResult<null>> {
    if (
      principal.type !== "owner" ||
      principal.userId !== this.store.snapshot().ownerUserId
    )
      return failed("Owner recovery required.");
    return this.serial(agentId, async () => {
      const agent = this.agent(agentId);
      const binding = this.binding(agent);
      if (!binding || !this.options.confirmNativeExit)
        return failed("Native identity or exit evidence is unavailable.");
      const caller: CallerContext = {
        projectId: binding.projectId,
        agentId: binding.agentId,
        sessionId: binding.sessionId,
      };
      const proof = await this.options.confirmNativeExit(caller);
      if (!proof.confirmed) return failed(proof.detail);
      await this.options.confirmVoiceExit?.(binding);
      const local = await this.options.executionSettlement?.(caller);
      if (local && !local.settled) return failed(local.detail);
      const settlement = await this.options.broker.settlement(
        agent.projectId,
        caller,
      );
      if (
        settlement.inFlightInvocationIds.length ||
        settlement.uncertainInvocationIds.length
      )
        return failed("This session's broker operations remain unsettled.");
      await this.options.authorization.closeSession(
        caller,
        "unverifiable_recovery",
      );
      await this.options.access.release(caller);
      await this.store.update((state) => {
        const session = state.agents.find((row) => row.id === agentId)!.runtime
          .session;
        if (session.sessionId !== binding.sessionId)
          throw new Error("Recovery identity changed.");
        session.desiredState = "stopped";
        session.observedState = "stopped";
        session.activeTurnId = null;
        session.lastObservedAt = now();
        session.lastError = null;
        state.nativeApprovals = state.nativeApprovals.filter(
          (row) => row.sessionId !== binding.sessionId,
        );
      });
      return { state: "acknowledged", value: null };
    });
  }

  async restart(agentId: string): Promise<RuntimeStartResult> {
    const result = await this.serial(
      agentId,
      async (): Promise<RuntimeStartResult> => {
        const stopped = await this.stopLocked(agentId, "restart");
        if (stopped.state === "failed")
          return {
            state: "failed",
            error: stopped.error,
            retainedThreadId: this.agent(agentId).runtime.threadId,
          };
        return this.startLocked(agentId);
      },
    );
    if (result.state === "acknowledged")
      void this.pump(agentId).catch(() => {});
    return result;
  }

  private async sessionError(
    agentId: string,
    failure: RuntimeError,
  ): Promise<void> {
    await this.store.update((state) => {
      const session = state.agents.find((entry) => entry.id === agentId)!
        .runtime.session;
      session.observedState = "error";
      session.lastError = failure;
      session.lastObservedAt = now();
    });
  }

  async send(
    principal: FoundationPrincipal,
    input: SendInput,
  ): Promise<AgentMessage | { messageId: string }> {
    const actor = await this.records.authorize(principal, "messages.send", {
      type: "agent",
      agentId: input.recipientAgentId,
    });
    return this.enqueue(actor, input, "public", principal);
  }

  /** Trusted scheduler/lifecycle ingress only, never exposed as an owner/model
   * JSON command. Internal work cannot steer into a human conversation turn. */
  async sendInternal(input: {
    id: string;
    source: "schedule" | "preparation";
    sourceId: string;
    recipientAgentId: string;
    content: AgentContent[];
  }) {
    if (!["schedule", "preparation"].includes(input.source) || !input.sourceId)
      throw new Error("An explicit internal source identity is required.");
    return this.enqueue(
      { type: "system", source: input.source, sourceId: input.sourceId },
      {
        id: input.id,
        recipientAgentId: input.recipientAgentId,
        content: input.content,
        jobId: null,
        replyToMessageId: null,
        deliveryMode: "queue",
      },
      "private",
    );
  }

  private async enqueue(
    actor: MessageSender,
    input: SendInput,
    visibility: "public" | "private",
    principal?: FoundationPrincipal,
  ): Promise<AgentMessage | { messageId: string }> {
    if (
      !["queue", "steer"].includes(input.deliveryMode) ||
      !Array.isArray(input.content) ||
      input.content.length < 1 ||
      JSON.stringify(input.content).length > 256_000
    )
      throw new Error(
        "A bounded message and explicit queue or steer mode are required.",
      );
    for (const block of input.content) {
      if (!block || !["text", "image", "file", "data"].includes(block.type))
        throw new Error("Unsupported message content.");
      if (block.type === "text" && typeof block.text !== "string")
        throw new Error("Text content is required.");
      if (
        (block.type === "image" || block.type === "file") &&
        (typeof block.fileRef !== "string" || !block.fileRef)
      )
        throw new Error("An authorized artifact reference is required.");
    }
    const messageId = input.id ?? randomUUID();
    const fingerprint = messageIntentFingerprint({
      ...input,
      sender: actor,
      kind: input.kind ?? "message",
    });
    const message = await this.store.update((state) => {
      if (
        principal?.type === "agent" &&
        !state.agents.some(
          (entry) =>
            entry.id === principal.caller.agentId &&
            entry.runtime.session.sessionId === principal.caller.sessionId &&
            entry.runtime.session.observedState === "started" &&
            entry.runtime.session.desiredState === "started",
        )
      )
        throw new Error(
          "Calling session closed before the intent could be saved.",
        );
      if (!state.agents.some((entry) => entry.id === input.recipientAgentId))
        throw new Error("Recipient does not exist in this project.");
      if (input.jobId && !state.jobs.some((entry) => entry.id === input.jobId))
        throw new Error("Unknown job.");
      if (
        input.replyToMessageId &&
        !state.messages.some((entry) => entry.id === input.replyToMessageId) &&
        !state.receipts.some(
          (entry) => entry.messageId === input.replyToMessageId,
        ) &&
        !state.helpRequests.some(
          (entry) => entry.messageId === input.replyToMessageId,
        )
      )
        throw new Error("Unknown reply reference.");
      if (
        Object.hasOwn(state.intentFingerprints, messageId) &&
        state.intentFingerprints[messageId] !== fingerprint
      )
        throw new Error("Message ID is already bound to different intent.");
      const existing = state.messages.find((entry) => entry.id === messageId);
      if (existing) {
        if (
          JSON.stringify(existing.sender) !== JSON.stringify(actor) ||
          existing.recipientAgentId !== input.recipientAgentId ||
          JSON.stringify(existing.content) !== JSON.stringify(input.content) ||
          existing.deliveryMode !== input.deliveryMode ||
          existing.jobId !== input.jobId ||
          existing.replyToMessageId !== input.replyToMessageId
        )
          throw new Error("Message ID is already bound to different intent.");
        return existing;
      }
      const receipt = state.receipts.find(
        (entry) => entry.messageId === messageId,
      );
      if (receipt) {
        if (
          JSON.stringify(receipt.sender) !== JSON.stringify(actor) ||
          receipt.recipientAgentId !== input.recipientAgentId
        )
          throw new Error("Message ID belongs to another sender or recipient.");
        return { messageId };
      }
      const created: AgentMessage = {
        id: messageId,
        projectId: state.projectId,
        sender: actor,
        visibility,
        recipientAgentId: input.recipientAgentId,
        jobId: input.jobId,
        replyToMessageId: input.replyToMessageId,
        kind: input.kind ?? "message",
        content: input.content,
        deliveryMode: input.deliveryMode,
        createdAt: now(),
        delivery: {
          state: "queued",
          attempts: [],
          runtimeMessageRef: null,
          deliveredAt: null,
          error: null,
        },
      };
      state.messages.push(created);
      Object.defineProperty(state.intentFingerprints, messageId, {
        value: fingerprint,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      return created;
    });
    void this.pump(input.recipientAgentId).catch(() => {});
    return message;
  }

  /** Called after any tool operation which may have persisted a help/reply intent. */
  async flush(): Promise<void> {
    await Promise.all(
      this.store.snapshot().agents.map((agent) => this.pump(agent.id)),
    );
  }

  async pump(agentId: string): Promise<void> {
    return this.serial(agentId, async () => {
      for (;;) {
        const agent = this.agent(agentId);
        const binding = this.binding(agent);
        if (!binding || !this.executionAllowed(binding)) return;
        const pending = this.store
          .snapshot()
          .messages.filter((entry) => entry.recipientAgentId === agentId);
        // Unknown native acceptance may itself have started a turn. Reconcile first.
        if (
          pending.some((entry) =>
            ["sending", "uncertain"].includes(entry.delivery.state),
          )
        )
          return;
        const active = agent.runtime.session.activeTurnId;
        const activeVisibility = active
          ? this.turnVisibility(agentId, binding.threadId, active)
          : null;
        const message = pending.find(
          (entry) =>
            entry.delivery.state === "queued" &&
            (entry.visibility !== "private" ||
              !this.options.privateInputBlocked?.(binding)) &&
            (!active ||
              (entry.deliveryMode === "steer" &&
                activeVisibility === entry.visibility)),
        );

        if (!message) return;
        if (active && !this.options.runtime.capabilities.activeTurnSteering) {
          await this.store.update((state) => {
            const current = state.messages.find(
              (entry) => entry.id === message.id,
            )!;
            current.delivery.state = "failed";
            current.delivery.error = error(
              "unsupported",
              "This native runtime does not support active-turn steering.",
            );
          });
          continue;
        }
        const attemptId = randomUUID();
        await this.admit(() =>
          this.store.update((state) => {
            if (state.reservation) throw new Error("Execution is reserved.");
            if (
              message.visibility === "private" &&
              this.options.privateInputBlocked?.(binding)
            )
              throw new Error(
                "Private input is waiting for the owner's voice session to close.",
              );
            const current = state.messages.find(
              (entry) => entry.id === message.id,
            )!;
            const readiness = state.preparation?.readiness.find(
              (row) => row.sessionId === binding.sessionId,
            );
            if (readiness) {
              readiness.state = "pending";
              readiness.requiredAfter = now();
              readiness.continuationSavedAt = null;
              readiness.detail =
                "New input admitted; report current continuation readiness.";
            }
            current.delivery.state = "sending";
            current.delivery.attempts.push({
              id: attemptId,
              sessionId: binding.sessionId,
              threadId: binding.threadId,
              turnId: active,
              attemptedAt: now(),
              outcome: "pending",
              runtimeMessageRef: null,
            });
          }),
        );
        let result: DeliveryResult;
        try {
          result = await this.options.runtime.deliver({
            binding,
            attemptId,
            message,
            expectedTurnId: active,
          });
        } catch {
          result = {
            state: "uncertain",
            error: error(
              "disconnected",
              "Native acceptance is unknown. Reconcile this message before another attempt.",
            ),
          };
        }
        await this.settleDelivery(message.id, attemptId, result);
        if (result.state !== "acknowledged") return;
      }
    });
  }

  private async settleDelivery(
    messageId: string,
    attemptId: string,
    result: DeliveryResult,
  ): Promise<void> {
    await this.store.update((state) => {
      const message = state.messages.find((entry) => entry.id === messageId);
      const attempt = message?.delivery.attempts.find(
        (entry) => entry.id === attemptId,
      );
      if (!message || !attempt || attempt.outcome === "acknowledged") return;
      if (result.state === "acknowledged") {
        attempt.outcome = "acknowledged";
        attempt.turnId = result.turnId;
        state.receipts.push({
          messageId,
          sender: message.sender,
          visibility: message.visibility,
          turnId: result.turnId,
          recipientAgentId: message.recipientAgentId,
          jobId: message.jobId,
          sessionId: attempt.sessionId,
          threadId: attempt.threadId,
          attemptId,
          runtimeMessageRef: result.runtimeMessageRef,
          acknowledgedAt: result.acknowledgedAt,
        });
        state.messages = state.messages.filter(
          (entry) => entry.id !== messageId,
        );
        const session = state.agents.find(
          (entry) => entry.id === message.recipientAgentId,
        )!.runtime.session;
        if (
          session.sessionId === attempt.sessionId &&
          !this.terminalTurns.has(`${attempt.sessionId}:${result.turnId}`)
        )
          session.activeTurnId = result.turnId;
      } else {
        attempt.outcome = result.state;
        message.delivery.state =
          result.state === "uncertain" ? "uncertain" : "failed";
        message.delivery.error = result.error;
      }
    });
  }

  async reconcileMessage(
    principal: FoundationPrincipal,
    messageId: string,
  ): Promise<DeliveryResult> {
    const message = this.store
      .snapshot()
      .messages.find((entry) => entry.id === messageId);
    if (!message) throw new Error("No unresolved message with that identity.");
    await this.records.authorize(principal, "messages.send", {
      type: "agent",
      agentId: message.recipientAgentId,
    });
    const result = await this.serial(message.recipientAgentId, async () => {
      const current = this.store
        .snapshot()
        .messages.find((entry) => entry.id === messageId)!;
      const attempt = current.delivery.attempts.at(-1);
      if (!attempt) throw new Error("Message has not been attempted.");
      const result = await this.options.runtime.reconcileDelivery(
        {
          projectId: message.projectId,
          agentId: message.recipientAgentId,
          sessionId: attempt.sessionId,
          threadId: attempt.threadId,
        },
        attempt,
      );
      await this.settleDelivery(messageId, attempt.id, result);
      return result;
    });
    void this.pump(message.recipientAgentId).catch(() => {});
    return result;
  }

  async retryMessage(
    principal: FoundationPrincipal,
    messageId: string,
  ): Promise<void> {
    const message = this.store
      .snapshot()
      .messages.find((entry) => entry.id === messageId);
    if (!message) throw new Error("Unknown pending message.");
    await this.records.authorize(principal, "messages.send", {
      type: "agent",
      agentId: message.recipientAgentId,
    });
    await this.store.update((state) => {
      const current = state.messages.find((entry) => entry.id === messageId)!;
      if (
        current.delivery.state !== "failed" ||
        current.delivery.attempts.at(-1)?.outcome !== "not_sent"
      )
        throw new Error("Only proven non-delivery may be retried.");
      current.delivery.state = "queued";
      current.delivery.error = null;
    });
    await this.pump(message.recipientAgentId);
  }

  private observe(binding: RuntimeBinding): void {
    const iterator = this.options.runtime
      .observe(binding)
      [Symbol.asyncIterator]();
    this.observers.set(binding.sessionId, iterator);
    void (async () => {
      try {
        while (
          !this.disposed &&
          this.observers.get(binding.sessionId) === iterator
        ) {
          const event = await iterator.next();
          if (event.done) {
            const current = this.agent(binding.agentId);
            if (
              current.runtime.session.sessionId === binding.sessionId &&
              current.runtime.session.observedState === "started"
            )
              await this.sessionError(
                binding.agentId,
                error(
                  "disconnected",
                  "Native observation ended without a confirmed stop.",
                ),
              );
            break;
          }
          if (this.disposed) break;
          await this.onRuntimeEvent(event.value);
        }
      } catch {
        if (this.disposed || this.observers.get(binding.sessionId) !== iterator)
          return;
        const current = this.agent(binding.agentId);
        if (
          current.runtime.session.sessionId === binding.sessionId &&
          current.runtime.session.observedState !== "stopped"
        )
          await this.sessionError(
            binding.agentId,
            error(
              "disconnected",
              "Native event observation ended without confirmed settlement.",
            ),
          );
      }
    })().catch(() => {
      /* A failed/closed durable writer must not be bypassed. */
    });
  }

  private async onRuntimeEvent(event: RuntimeEvent): Promise<void> {
    if (this.disposed) return;
    const current = this.agent(event.binding.agentId);
    if (
      current.projectId !== event.binding.projectId ||
      current.runtime.session.sessionId !== event.binding.sessionId ||
      current.runtime.threadId !== event.binding.threadId ||
      current.runtime.session.observedState === "stopped"
    )
      return;
    if (event.kind === "turn" && event.state !== "started")
      this.terminalTurns.add(`${event.binding.sessionId}:${event.turnId}`);
    if (event.kind === "delivery") {
      const message = this.store
        .snapshot()
        .messages.find(
          (entry) =>
            entry.recipientAgentId === event.binding.agentId &&
            entry.delivery.attempts.some(
              (attempt) =>
                attempt.id === event.attemptId &&
                attempt.sessionId === event.binding.sessionId &&
                attempt.threadId === event.binding.threadId,
            ),
        );
      if (message)
        await this.settleDelivery(message.id, event.attemptId, event.result);
    } else if (
      event.kind === "history" &&
      event.item.kind === "approval" &&
      event.item.metadata.state === "resolved" &&
      typeof event.item.metadata.approvalId === "string"
    ) {
      await this.store.update((state) => {
        state.nativeApprovals = state.nativeApprovals.filter(
          (entry) =>
            !(
              entry.sessionId === event.binding.sessionId &&
              entry.threadId === event.binding.threadId &&
              entry.approvalId === event.item.metadata.approvalId
            ),
        );
      });
    } else if (event.kind !== "history") {
      await this.store.update((state) => {
        const session = state.agents.find(
          (entry) => entry.id === event.binding.agentId,
        )!.runtime.session;
        session.lastObservedAt = event.observedAt;
        if (event.kind === "turn") {
          if (
            event.state === "started" &&
            !this.terminalTurns.has(
              `${event.binding.sessionId}:${event.turnId}`,
            )
          ) {
            if (session.activeTurnId && session.activeTurnId !== event.turnId) {
              session.observedState = "unknown";
              session.lastError = error(
                "identity_mismatch",
                "Native observation reported conflicting active turns; reconcile before further delivery.",
              );
            } else session.activeTurnId = event.turnId;
          } else if (session.activeTurnId === event.turnId)
            session.activeTurnId = null;
        } else if (
          event.kind === "connection" &&
          event.state === "disconnected" &&
          session.observedState !== "stopping"
        ) {
          session.observedState = "unknown";
          session.lastError =
            event.error ??
            error(
              "disconnected",
              "Native connection ended without a confirmed stop.",
            );
        } else if (
          event.kind === "native_approval" &&
          !state.nativeApprovals.some(
            (entry) =>
              entry.sessionId === event.binding.sessionId &&
              entry.approvalId === event.approvalId,
          )
        ) {
          state.nativeApprovals.push({
            agentId: event.binding.agentId,
            sessionId: event.binding.sessionId,
            threadId: event.binding.threadId,
            approvalId: event.approvalId,
            turnId: event.turnId,
            request: event.request,
            state: "pending",
          });
        }
      });
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* display subscribers do not own delivery */
      }
    }
    if (
      (event.kind === "turn" && event.state !== "started") ||
      event.kind === "delivery"
    )
      void this.pump(event.binding.agentId).catch(() => {});
  }

  async history(
    principal: FoundationPrincipal,
    agentId: string,
    cursor?: string,
  ) {
    await this.records.authorize(principal, "history.read", {
      type: "agent",
      agentId,
    });
    const binding = this.binding(this.agent(agentId));
    if (!binding) return failed("This agent has no native thread yet.");
    const result = await this.options.runtime.readHistory(binding, cursor);
    if (principal.type !== "owner" || result.state !== "acknowledged")
      return result;
    return {
      ...result,
      value: {
        ...result.value,
        items: result.value.items.filter(
          (item) =>
            item.turnId !== null &&
            this.turnVisibility(
              binding.agentId,
              binding.threadId,
              item.turnId,
            ) === "public",
        ),
      },
    };
  }

  turnVisibility(
    agentId: string,
    threadId: string,
    turnId: string,
  ): "public" | "private" | "unknown" {
    const receipts = this.store
      .snapshot()
      .receipts.filter(
        (row) =>
          row.recipientAgentId === agentId &&
          row.threadId === threadId &&
          row.turnId === turnId,
      );
    if (receipts.some((row) => row.visibility === "private")) return "private";
    return receipts.some((row) => row.visibility === "public") ||
      this.store
        .snapshot()
        .voiceTurns.some(
          (row) =>
            row.agentId === agentId &&
            row.threadId === threadId &&
            row.turnId === turnId,
        )
      ? "public"
      : "unknown";
  }

  /** Trusted realtime host only. No text-based or timing-based attribution. */
  async recordPublicVoiceTurn(
    binding: RuntimeBinding,
    input: {
      voiceSessionId: string;
      realtimeSessionId: string;
      turnId: string;
      nativeItemId: string;
    },
  ): Promise<void> {
    await this.store.update((state) => {
      const current = state.agents.find((row) => row.id === binding.agentId);
      if (
        state.projectSettings.primaryAgentId !== binding.agentId ||
        current?.runtime.session.sessionId !== binding.sessionId ||
        current.runtime.threadId !== binding.threadId ||
        !["started", "stopping", "unknown", "error"].includes(
          current.runtime.session.observedState,
        )
      )
        throw new Error(
          "Realtime promotion is not from the current primary session.",
        );
      if (
        state.receipts.some(
          (row) =>
            row.recipientAgentId === binding.agentId &&
            row.threadId === binding.threadId &&
            row.turnId === input.turnId &&
            row.visibility === "private",
        )
      )
        throw new Error("Realtime promotion conflicts with private work.");
      const prior = state.voiceTurns.find(
        (row) =>
          row.agentId === binding.agentId &&
          row.threadId === binding.threadId &&
          row.turnId === input.turnId &&
          row.nativeItemId === input.nativeItemId,
      );
      if (prior) {
        if (
          prior.realtimeSessionId !== input.realtimeSessionId ||
          prior.voiceSessionId !== input.voiceSessionId ||
          prior.nativeItemId !== input.nativeItemId
        )
          throw new Error("Conflicting realtime promotion.");
        return;
      }
      const readiness = state.preparation?.readiness.find(
        (row) =>
          row.agentId === binding.agentId &&
          row.sessionId === binding.sessionId,
      );
      if (readiness) {
        readiness.state = "pending";
        readiness.requiredAfter = now();
        readiness.continuationSavedAt = null;
        readiness.detail =
          "New native voice handoff admitted; report current continuation readiness.";
      }
      state.voiceTurns.push({
        ...input,
        agentId: binding.agentId,
        sessionId: binding.sessionId,
        threadId: binding.threadId,
        ownerUserId: state.ownerUserId,
        observedAt: now(),
      });
    });
  }

  /** Called under the shared admission gate before connecting public owner voice. */
  publicVoiceAllowed(binding: RuntimeBinding): boolean {
    if (!this.executionAllowed(binding)) return false;
    const state = this.store.snapshot();
    if (state.projectSettings.primaryAgentId !== binding.agentId) return false;
    if (
      state.messages.some(
        (row) =>
          row.recipientAgentId === binding.agentId &&
          ["sending", "uncertain"].includes(row.delivery.state),
      )
    )
      return false;
    const active = this.agent(binding.agentId).runtime.session.activeTurnId;
    return (
      !active ||
      this.turnVisibility(binding.agentId, binding.threadId, active) ===
        "public"
    );
  }

  async respondToNativeApproval(
    principal: FoundationPrincipal,
    agentId: string,
    approvalId: string,
    response: JsonValue,
  ): Promise<RuntimeResult<null>> {
    // Native turn/start can await an approval before acknowledging delivery. Keep
    // this lane separate from send/lifecycle RPC waits; atomic state admission below
    // orders it against Stop, while duplicate responses share this request lock.
    return this.serial(`approval:${agentId}:${approvalId}`, () =>
      this.respondToNativeApprovalLocked(
        principal,
        agentId,
        approvalId,
        response,
      ),
    );
  }

  private async respondToNativeApprovalLocked(
    principal: FoundationPrincipal,
    agentId: string,
    approvalId: string,
    response: JsonValue,
  ): Promise<RuntimeResult<null>> {
    if (
      principal.type !== "owner" ||
      principal.userId !== this.store.snapshot().ownerUserId
    )
      throw new Error("Native approvals require the human owner.");
    const agent = this.agent(agentId);
    const binding = this.binding(agent);
    if (!binding)
      return failed("Native approval has no retained session binding.");
    const draining =
      response !== null &&
      typeof response === "object" &&
      !Array.isArray(response) &&
      (response.decision === "decline" || response.decision === "cancel");
    await this.store.update((state) => {
      const session = state.agents.find((entry) => entry.id === agentId)!
        .runtime.session;
      if (
        session.sessionId !== binding.sessionId ||
        session.observedState === "stopped"
      )
        throw new Error("Native approval is no longer current.");
      if (
        !draining &&
        (state.reservation ||
          session.observedState !== "started" ||
          session.desiredState !== "started")
      )
        throw new Error(
          "Positive approval is held while the session is stopping or unavailable.",
        );
      const approval = state.nativeApprovals.find(
        (entry) =>
          entry.agentId === agentId &&
          entry.sessionId === binding.sessionId &&
          entry.approvalId === approvalId,
      );
      if (!approval || approval.state !== "pending")
        throw new Error(
          "Approval is missing or its previous response is uncertain.",
        );
      approval.state = "responding";
    });
    let result: RuntimeResult<null>;
    try {
      result = await this.options.runtime.respondToNativeApproval(
        binding,
        approvalId,
        response,
      );
    } catch {
      result = failed("Native approval response delivery is unknown.");
    }
    const delivered = result.state === "acknowledged";
    await this.store.update((state) => {
      if (delivered)
        state.nativeApprovals = state.nativeApprovals.filter(
          (entry) =>
            !(
              entry.sessionId === binding.sessionId &&
              entry.approvalId === approvalId
            ),
        );
      else {
        const approval = state.nativeApprovals.find(
          (entry) =>
            entry.sessionId === binding.sessionId &&
            entry.approvalId === approvalId,
        );
        if (approval) approval.state = "uncertain";
      }
    });
    return result;
  }

  async invoke(principal: FoundationPrincipal, invocation: BrokerInvocation) {
    if (
      principal.type !== "agent" ||
      principal.caller.agentId !== invocation.caller.agentId ||
      principal.caller.projectId !== invocation.caller.projectId ||
      principal.caller.sessionId !== invocation.caller.sessionId ||
      !this.executionAllowed(principal.caller)
    )
      throw new Error("A live authenticated calling session is required.");
    return this.options.broker.invoke(invocation);
  }

  async prepare(
    projectId: string,
    reason: ExecutionReservation["reason"],
  ): Promise<PreparationReadiness[]> {
    if (
      projectId !== this.store.snapshot().projectId ||
      !["quit", "restart", "update"].includes(reason)
    )
      throw new Error("Invalid project preparation.");
    const readiness = await this.store.update((state) => {
      if (state.reservation) throw new Error("Execution is already reserved.");
      const preparationId = randomUUID();
      const requestedAt = now();
      const readiness: PreparationReadiness[] = state.agents
        .filter(
          (agent) =>
            agent.runtime.session.sessionId &&
            agent.runtime.session.observedState !== "stopped",
        )
        .map((agent) => ({
          preparationId,
          requiredAfter: requestedAt,
          agentId: agent.id,
          sessionId: agent.runtime.session.sessionId!,
          state: this.options.requestPreparation ? "pending" : "blocked",
          continuationSavedAt: null,
          detail: this.options.requestPreparation
            ? null
            : "A native preparation control channel is not configured. Send a genuine preparation request and have the agent report readiness.",
        }));
      state.preparation = { reason, readiness, requestedAt: now() };
      return readiness;
    });
    for (const item of readiness) {
      const binding = this.binding(this.agent(item.agentId));
      if (binding && this.options.requestPreparation) {
        try {
          await this.options.requestPreparation(
            binding,
            reason,
            item.preparationId,
          );
        } catch {
          await this.store.update((state) => {
            const entry = state.preparation?.readiness.find(
              (entry) => entry.sessionId === item.sessionId,
            );
            if (entry) {
              entry.state = "blocked";
              entry.detail =
                "Preparation request could not be acknowledged. Ordinary messages remain available.";
            }
          });
        }
      }
    }
    return this.store.snapshot().preparation!.readiness;
  }

  async reportReadiness(
    principal: FoundationPrincipal,
    input: Pick<
      PreparationReadiness,
      "preparationId" | "state" | "continuationSavedAt" | "detail"
    >,
  ): Promise<void> {
    if (principal.type !== "agent" || !this.executionAllowed(principal.caller))
      throw new Error(
        "Readiness must come from the actual live agent session.",
      );
    if (
      !["pending", "ready", "blocked"].includes(input.state) ||
      (input.state === "ready" &&
        (!input.continuationSavedAt ||
          !Number.isFinite(Date.parse(input.continuationSavedAt))))
    )
      throw new Error("Ready requires an explicit continuation save time.");
    await this.store.update((state) => {
      const current = state.agents.find(
        (agent) => agent.id === principal.caller.agentId,
      );
      if (
        state.reservation ||
        current?.runtime.session.sessionId !== principal.caller.sessionId ||
        current.runtime.session.observedState !== "started" ||
        current.runtime.session.desiredState !== "started"
      )
        throw new Error(
          "Readiness session is no longer current or execution is reserved.",
        );
      const entry = state.preparation?.readiness.find(
        (entry) =>
          entry.agentId === principal.caller.agentId &&
          entry.sessionId === principal.caller.sessionId,
      );
      if (!entry)
        throw new Error("No preparation request for this exact session.");
      if (
        entry.preparationId !== input.preparationId ||
        (input.state === "ready" &&
          Date.parse(input.continuationSavedAt!) <
            Date.parse(entry.requiredAfter))
      )
        throw new Error(
          "Readiness must match the current preparation and later admitted work.",
        );
      Object.assign(entry, input);
    });
  }

  /** Call inside the shared admission gate after fresh external-operation redemption. */
  async noteExecutionAdmitted(caller: CallerContext): Promise<void> {
    await this.store.update((state) => {
      if (state.reservation) throw new Error("Execution is reserved.");
      const entry = state.preparation?.readiness.find(
        (row) =>
          row.agentId === caller.agentId && row.sessionId === caller.sessionId,
      );
      if (entry) {
        entry.state = "pending";
        entry.requiredAfter = now();
        entry.continuationSavedAt = null;
        entry.detail =
          "New tool operation admitted; report current continuation readiness.";
      }
    });
  }

  async reserveExecution(
    projectId: string,
    reason: ExecutionReservation["reason"],
  ): Promise<
    | { state: "reserved"; reservation: ExecutionReservation }
    | { state: "blocked"; reason: string }
  > {
    if (!this.options.admissionUsesFoundationBarrier || !this.options.admission)
      return {
        state: "blocked",
        reason:
          "Access/broker admission has not been wired to the foundation execution barrier.",
      };
    return this.options.admission.run(() =>
      this.reserveExecutionLocked(projectId, reason),
    );
  }

  private async reserveExecutionLocked(
    projectId: string,
    reason: ExecutionReservation["reason"],
  ): Promise<
    | { state: "reserved"; reservation: ExecutionReservation }
    | { state: "blocked"; reason: string }
  > {
    let reservation: ExecutionReservation | undefined;
    try {
      reservation = await this.store.update((state) => {
        if (
          projectId !== state.projectId ||
          state.reservation ||
          state.preparation?.reason !== reason
        )
          throw new Error("Prepare this project before reserving execution.");
        for (const agent of state.agents) {
          if (agent.runtime.session.observedState === "stopped") continue;
          if (
            agent.runtime.session.observedState !== "started" ||
            agent.runtime.session.activeTurnId
          )
            throw new Error("Native execution is not settled.");
          if (
            !state.preparation.readiness.some(
              (entry) =>
                entry.agentId === agent.id &&
                entry.sessionId === agent.runtime.session.sessionId &&
                entry.state === "ready",
            )
          )
            throw new Error(
              "An agent has not reported ready for this session.",
            );
        }
        if (
          state.nativeApprovals.length ||
          state.messages.some((entry) =>
            ["sending", "uncertain"].includes(entry.delivery.state),
          )
        )
          throw new Error(
            "Native approvals or uncertain deliveries require resolution.",
          );
        const value: ExecutionReservation = {
          id: randomUUID(),
          projectId,
          reason,
          acquiredAt: now(),
        };
        state.reservation = value;
        return value;
      });
      const local = await this.options.executionSettlement?.();
      if (local && !local.settled) {
        await this.releaseExecution(reservation.id);
        return { state: "blocked", reason: local.detail };
      }
      const settlement = await this.options.broker.settlement(projectId);
      if (
        settlement.inFlightInvocationIds.length ||
        settlement.uncertainInvocationIds.length ||
        settlement.pendingApprovalIds.length
      ) {
        await this.releaseExecution(reservation.id);
        return {
          state: "blocked",
          reason: "Broker operations or access approvals require settlement.",
        };
      }
      return { state: "reserved", reservation };
    } catch {
      if (
        reservation &&
        this.store.snapshot().reservation?.id === reservation.id
      )
        await this.releaseExecution(reservation.id);
      return {
        state: "blocked",
        reason:
          "Preparation, native execution, approvals or delivery evidence is not settled; inspect the retained state.",
      };
    }
  }

  async releaseExecution(reservationId: string): Promise<void> {
    await this.store.update((state) => {
      if (state.reservation?.id !== reservationId)
        throw new Error("Reservation identity does not match.");
      state.reservation = null;
    });
    void this.flush().catch(() => {});
  }

  async dispose(): Promise<void> {
    // Transport shutdown is not native Stop, service cleanup or destructive archive.
    this.disposed = true;
    this.listeners.clear();
    this.observers.clear();
    await Promise.allSettled([...this.locks.values()]);
    await this.store.close();
  }
}
