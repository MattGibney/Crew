import { createHash } from "node:crypto";
import type { ExecutionAdmissionGate, RuntimeBinding } from "./contracts.mjs";
import type {
  CodexRealtimeAudio,
  CodexRealtimeConnect,
  CodexRealtimeConnection,
  CodexRealtimeEvent,
  CodexRealtimePort,
  CodexRealtimeState,
} from "./codex-realtime.mjs";

export interface PrimaryVoiceCall {
  binding: RuntimeBinding;
  /** Allocated by the owner UI before negotiation, including cancellation. */
  callId: string;
}
export interface PrimaryVoiceCatalog {
  voices: { id: string; name: string }[];
  defaultVoice: string;
  selectedVoice: string | null;
}
export type PrimaryVoiceEvent = PrimaryVoiceCall & {
  kind: "closed" | "error";
  message?: string;
};
export interface PrimaryVoiceStatus {
  state: CodexRealtimeState;
  binding: RuntimeBinding | null;
  callId: string | null;
  sessionToken: string | null;
  detail: string;
}
export interface PublicVoiceTurn {
  voiceSessionId: string;
  realtimeSessionId: string;
  turnId: string;
  nativeItemId: string;
}
export interface PrimaryAgentVoiceOptions {
  /** Both identities come from the trusted local host, never renderer input. */
  ownerUserId: string;
  authenticatedUserId: string;
  runtime: CodexRealtimePort;
  admission: ExecutionAdmissionGate;
  currentPrimaryBinding(): RuntimeBinding | null;
  executionAllowed(binding: RuntimeBinding): boolean;
  /** Includes private/unknown active turns and uncertain message dispatch. */
  publicVoiceAllowed(binding: RuntimeBinding): boolean;
  noteExecutionAdmitted(binding: RuntimeBinding): Promise<void>;
  recordPublicVoiceTurn(
    binding: RuntimeBinding,
    input: PublicVoiceTurn,
  ): Promise<void>;
  flush(): Promise<void>;
  selectedVoice?(binding: RuntimeBinding): string | null;
}
type Call = PrimaryVoiceCall & {
  fingerprint: string;
  state: CodexRealtimeState;
  voiceSessionId: string | null;
  invoked: boolean;
  connectPending: boolean;
  connectDone: Promise<void>;
  finishConnect(): void;
  connectPromise: Promise<CodexRealtimeConnection> | null;
  disconnectPromise: Promise<void> | null;
  stopRequested: boolean;
  nativeClosed: boolean;
  closedPublished: boolean;
  pendingCorrelations: number;
  correlationFailed: boolean;
  handoffs: Set<string>;
};
const identity = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  !/[\u0000-\u001f\u007f]/.test(value);
const validBinding = (binding: RuntimeBinding) =>
  binding &&
  [
    binding.projectId,
    binding.agentId,
    binding.sessionId,
    binding.threadId,
  ].every(identity);
const sameBinding = (a: RuntimeBinding, b: RuntimeBinding) =>
  a.projectId === b.projectId &&
  a.agentId === b.agentId &&
  a.sessionId === b.sessionId &&
  a.threadId === b.threadId;
const callKey = (input: PrimaryVoiceCall) =>
  JSON.stringify([
    input.binding.projectId,
    input.binding.agentId,
    input.binding.sessionId,
    input.binding.threadId,
    input.callId,
  ]);

/** Owner capability for one primary agent's existing native conversation.
 * The admission gate only covers identity, policy and the durable admission
 * marker. All native requests run outside it. This class never owns a mic,
 * creates a user utterance, starts an agent or relays a native handoff. */
export class PrimaryAgentVoice {
  private call: Call | null = null;
  private disposed = false;
  private retired = new Set<string>();
  private listeners = new Set<(event: PrimaryVoiceEvent) => void>();
  private nativeListeners = new Set<
    (event: CodexRealtimeEvent & { callId: string }) => void
  >();
  private correlations = new Set<Promise<void>>();
  private readonly unsubscribe: () => void;

  constructor(private readonly options: PrimaryAgentVoiceOptions) {
    if (
      !identity(options.ownerUserId) ||
      options.authenticatedUserId !== options.ownerUserId
    )
      throw new Error(
        "Primary voice requires the authenticated project owner.",
      );
    this.unsubscribe = options.runtime.subscribeRealtime((event) =>
      this.receive(event),
    );
  }

  private validate(input: PrimaryVoiceCall) {
    if (!input || !validBinding(input.binding) || !identity(input.callId))
      throw new Error("Voice requires an exact binding and call identity.");
  }
  private assertCurrent(binding: RuntimeBinding) {
    const current = this.options.currentPrimaryBinding();
    if (
      this.disposed ||
      !validBinding(binding) ||
      !current ||
      !sameBinding(current, binding) ||
      !this.options.executionAllowed(binding)
    )
      throw new Error(
        "Voice requires the current started primary agent session.",
      );
  }
  private publish(
    call: Call,
    kind: PrimaryVoiceEvent["kind"],
    message?: string,
  ) {
    for (const listener of this.listeners) {
      try {
        listener({
          binding: { ...call.binding },
          callId: call.callId,
          kind,
          ...(message ? { message } : {}),
        });
      } catch {
        /* An observer cannot change native lifecycle evidence. */
      }
    }
  }
  private flush() {
    // Queue delivery owns its own failure evidence; voice closure stays factual.
    void Promise.resolve()
      .then(() => this.options.flush())
      .catch(() => {});
  }
  private closed(call: Call) {
    call.nativeClosed = true;
    call.state = "closed";
    this.retired.add(callKey(call));
    if (!call.closedPublished) {
      call.closedPublished = true;
      this.publish(call, "closed");
    }
    this.flush();
  }
  private captureNativeIdentity(call: Call) {
    const native = this.options.runtime.realtimeStatus(call.binding);
    if (call.voiceSessionId && native.voiceSessionId !== call.voiceSessionId)
      throw new Error(
        "Native voice identity changed before closure was confirmed.",
      );
    if (!call.voiceSessionId && native.voiceSessionId)
      call.voiceSessionId = native.voiceSessionId;
    return native;
  }
  private refreshAfterFailure(call: Call) {
    try {
      const native = this.captureNativeIdentity(call);
      if (native.state === "closed") this.closed(call);
      else call.state = "uncertain";
    } catch {
      call.state = "uncertain";
    }
  }

  async listVoices(binding: RuntimeBinding): Promise<PrimaryVoiceCatalog> {
    await this.options.admission.run(async () => this.assertCurrent(binding));
    const result = await this.options.runtime.listRealtimeVoices(binding);
    this.assertCurrent(binding);
    if (result.state === "failed") throw new Error(result.error.message);
    return {
      ...result.value,
      selectedVoice: this.options.selectedVoice?.(binding) ?? null,
    };
  }

  connect(
    input: PrimaryVoiceCall & CodexRealtimeConnect,
  ): Promise<CodexRealtimeConnection> {
    this.validate(input);
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          transport: input.transport,
          voice: input.voice ?? null,
        }),
      )
      .digest("hex");
    return this.options.admission
      .run(async () => {
        this.assertCurrent(input.binding);
        if (this.retired.has(callKey(input)))
          throw new Error("This voice call already ended or was cancelled.");
        const existing = this.call;
        if (
          existing &&
          sameBinding(existing.binding, input.binding) &&
          existing.callId === input.callId
        ) {
          if (existing.fingerprint !== fingerprint)
            throw new Error(
              "This voice call has different connection parameters.",
            );
          return existing;
        }
        if (!this.settlement().settled)
          throw new Error(
            "The previous voice call or its public history is unresolved.",
          );
        if (!this.options.publicVoiceAllowed(input.binding))
          throw new Error(
            "Voice waits until private or unclassified native work has settled.",
          );
        const native = this.options.runtime.realtimeStatus(input.binding);
        if (native.state !== "closed")
          throw new Error(
            "The native session already has an active or unresolved voice call.",
          );
        await this.options.noteExecutionAdmitted(input.binding);
        this.assertCurrent(input.binding);
        if (!this.options.publicVoiceAllowed(input.binding))
          throw new Error(
            "Native work changed before voice admission completed.",
          );
        let finishConnect!: () => void;
        const connectDone = new Promise<void>((resolve) => {
          finishConnect = resolve;
        });
        const call: Call = {
          binding: { ...input.binding },
          callId: input.callId,
          fingerprint,
          state: "connecting",
          voiceSessionId: null,
          invoked: false,
          connectPending: true,
          connectDone,
          finishConnect,
          connectPromise: null,
          disconnectPromise: null,
          stopRequested: false,
          nativeClosed: false,
          closedPublished: false,
          pendingCorrelations: 0,
          correlationFailed: false,
          handoffs: new Set(),
        };
        // This marker also blocks private queue admission and lifecycle reservations.
        this.call = call;
        return call;
      })
      .then((call) => {
        call.connectPromise ??= this.runConnect(call, input);
        return call.connectPromise;
      });
  }

  private async runConnect(call: Call, input: CodexRealtimeConnect) {
    try {
      if (call.stopRequested || this.disposed) {
        this.closed(call);
        throw new Error(
          "Voice connection was cancelled before native dispatch.",
        );
      }
      call.invoked = true;
      const pending = this.options.runtime.connectRealtime(call.binding, input);
      // The concrete native port allocates its token synchronously, before RPC.
      try {
        this.captureNativeIdentity(call);
      } catch {
        call.state = "uncertain";
      }
      const result = await pending;
      if (result.state === "failed") {
        this.refreshAfterFailure(call);
        throw new Error(result.error.message);
      }
      if (call.voiceSessionId !== result.value.voiceSessionId) {
        call.state = "uncertain";
        throw new Error(
          "Native voice acknowledgement did not match the admitted call.",
        );
      }
      if (call.stopRequested || this.disposed) {
        await this.disconnectNative(call);
        throw new Error("Voice connection was cancelled.");
      }
      if (call.nativeClosed)
        throw new Error("The native voice call already closed.");
      call.state = "active";
      return result.value;
    } catch (error) {
      if (!call.nativeClosed) this.refreshAfterFailure(call);
      this.publish(
        call,
        "error",
        error instanceof Error ? error.message : "Voice connection failed.",
      );
      throw error;
    } finally {
      call.connectPending = false;
      call.finishConnect();
      if (call.nativeClosed) this.flush();
    }
  }

  async start(input: PrimaryVoiceCall & { sdp: string; voice: string }) {
    const result = await this.connect({
      ...input,
      transport: { type: "webrtc", sdp: input.sdp },
    });
    if (!result.sdp) {
      await this.stop(input);
      throw new Error("Native WebRTC did not return an answer.");
    }
    return {
      sdp: result.sdp,
      threadId: input.binding.threadId,
      sessionToken: result.voiceSessionId,
    };
  }

  private exactCall(input: PrimaryVoiceCall & { sessionToken?: string }) {
    this.validate(input);
    const call = this.call;
    if (
      !call ||
      call.callId !== input.callId ||
      !sameBinding(call.binding, input.binding) ||
      (input.sessionToken !== undefined &&
        input.sessionToken !== call.voiceSessionId)
    )
      throw new Error(
        "Voice control does not identify the exact current call.",
      );
    return call;
  }

  async ready(
    input: PrimaryVoiceCall & { sessionToken: string },
  ): Promise<void> {
    await this.options.admission.run(async () => {
      this.assertCurrent(input.binding);
      const call = this.exactCall(input);
      if (call.state !== "active" || call.stopRequested || call.nativeClosed)
        throw new Error(
          "Only the current active voice call can acknowledge readiness.",
        );
      // Media readiness does not fabricate a user turn or trigger a greeting.
    });
  }

  async appendAudio(
    input: PrimaryVoiceCall & {
      sessionToken: string;
      audio: CodexRealtimeAudio;
    },
  ): Promise<void> {
    const call = await this.options.admission.run(async () => {
      this.assertCurrent(input.binding);
      const call = this.exactCall(input);
      if (
        call.state !== "active" ||
        call.stopRequested ||
        call.nativeClosed ||
        !this.options.publicVoiceAllowed(input.binding)
      )
        throw new Error(
          "Audio requires the current public native voice session.",
        );
      return call;
    });
    const result = await this.options.runtime.appendRealtimeAudio(
      call.binding,
      input.sessionToken,
      input.audio,
    );
    if (result.state === "failed") throw new Error(result.error.message);
  }

  private async disconnectNative(call: Call): Promise<void> {
    if (call.nativeClosed) return;
    if (!call.invoked) {
      this.closed(call);
      return;
    }
    if (call.disconnectPromise) return call.disconnectPromise;
    call.disconnectPromise = (async () => {
      try {
        const native = this.captureNativeIdentity(call);
        if (native.state === "closed") {
          this.closed(call);
          return;
        }
        if (!call.voiceSessionId)
          throw new Error("The native voice identity is unavailable.");
        call.state = "stopping";
        const result = await this.options.runtime.disconnectRealtime(
          call.binding,
          call.voiceSessionId,
        );
        if (result.state === "failed") throw new Error(result.error.message);
        this.closed(call);
      } catch (error) {
        if (!call.nativeClosed) call.state = "uncertain";
        this.publish(
          call,
          "error",
          "Native voice closure is unconfirmed; lifecycle changes remain blocked.",
        );
        throw error;
      }
    })();
    try {
      await call.disconnectPromise;
    } finally {
      call.disconnectPromise = null;
    }
  }

  async stop(input: PrimaryVoiceCall): Promise<void> {
    this.validate(input);
    const call = await this.options.admission.run(async () => {
      // A cancelled UI call may reach the host before its delayed start request.
      this.retired.add(callKey(input));
      if (
        !this.call ||
        this.call.callId !== input.callId ||
        !sameBinding(this.call.binding, input.binding)
      )
        return null;
      this.call.stopRequested = true;
      return this.call;
    });
    if (!call) return;
    await this.disconnectNative(call);
    await call.connectDone;
    if (!call.nativeClosed) await this.disconnectNative(call);
    this.flush();
  }

  abandon(input: PrimaryVoiceCall): void {
    void this.stop(input).catch(() => {});
  }
  async disconnect(): Promise<void> {
    const call = this.call;
    if (call) await this.stop(call);
  }

  /** Trusted host only, after acknowledged native Stop or independent proof
   * that this exact owned native process exited. Never expose through owner/model
   * JSON commands. Call outside the admission gate so queued correlations drain. */
  async confirmNativeExit(binding: RuntimeBinding): Promise<void> {
    const call = this.call;
    if (!call || !sameBinding(call.binding, binding)) return;
    call.stopRequested = true;
    this.closed(call);
    await call.connectDone;
    await Promise.all(this.correlations);
    if (call.correlationFailed)
      throw new Error(
        "Native voice exited, but public handoff persistence remains unresolved.",
      );
    this.flush();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.disconnect();
    await Promise.all(this.correlations);
    if (!this.settlement().settled) throw new Error(this.settlement().detail);
    this.unsubscribe();
    this.listeners.clear();
    this.nativeListeners.clear();
  }

  status(): PrimaryVoiceStatus {
    const call = this.call;
    const state = !call
      ? "closed"
      : call.correlationFailed
        ? "uncertain"
        : call.nativeClosed &&
            (call.connectPending || call.pendingCorrelations > 0)
          ? "stopping"
          : call.state;
    const detail = call?.correlationFailed
      ? "Native voice handoff persistence is unresolved."
      : call?.pendingCorrelations
        ? "Native voice handoff identity is being saved."
        : state === "closed"
          ? "Native voice is closed."
          : state === "uncertain"
            ? "Native voice closure is unconfirmed."
            : "Native voice is active or connecting.";
    return {
      state,
      binding: call ? { ...call.binding } : null,
      callId: call?.callId ?? null,
      sessionToken: call?.voiceSessionId ?? null,
      detail,
    };
  }
  settlement(): { settled: boolean; detail: string } {
    const status = this.status();
    return { settled: status.state === "closed", detail: status.detail };
  }
  privateInputBlocked(binding: RuntimeBinding): boolean {
    return (
      this.call !== null &&
      sameBinding(this.call.binding, binding) &&
      !this.settlement().settled
    );
  }
  subscribe(listener: (event: PrimaryVoiceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  subscribeRealtime(
    listener: (event: CodexRealtimeEvent & { callId: string }) => void,
  ): () => void {
    this.nativeListeners.add(listener);
    return () => {
      this.nativeListeners.delete(listener);
    };
  }

  private receive(event: CodexRealtimeEvent) {
    const call = this.call;
    if (!call || !call.invoked || !sameBinding(call.binding, event.binding))
      return;
    try {
      if (!call.voiceSessionId) this.captureNativeIdentity(call);
    } catch {
      call.state = "uncertain";
      return;
    }
    if (call.voiceSessionId !== event.voiceSessionId) return;
    if (event.kind === "closed") this.closed(call);
    else if (event.kind === "error") {
      this.refreshAfterFailure(call);
      this.publish(call, "error", event.error.message);
    } else if (event.kind === "handoff") {
      if (
        ![event.realtimeSessionId, event.turnId, event.nativeItemId].every(
          identity,
        )
      ) {
        call.correlationFailed = true;
        this.publish(
          call,
          "error",
          "Native voice handoff identity was invalid.",
        );
        return;
      }
      const key = JSON.stringify([
        event.realtimeSessionId,
        event.turnId,
        event.nativeItemId,
      ]);
      if (!call.handoffs.has(key)) {
        call.handoffs.add(key);
        call.pendingCorrelations++;
        const pending = this.options.admission
          .run(() =>
            this.options.recordPublicVoiceTurn(call.binding, {
              voiceSessionId: event.voiceSessionId,
              realtimeSessionId: event.realtimeSessionId,
              turnId: event.turnId,
              nativeItemId: event.nativeItemId,
            }),
          )
          .catch(() => {
            call.correlationFailed = true;
            this.publish(
              call,
              "error",
              "Native voice handoff could not be saved; lifecycle changes remain blocked.",
            );
          })
          .finally(() => {
            call.pendingCorrelations--;
            this.correlations.delete(pending);
            if (call.nativeClosed) this.flush();
          });
        this.correlations.add(pending);
      }
    }
    for (const listener of this.nativeListeners) {
      try {
        listener({
          ...event,
          binding: { ...call.binding },
          callId: call.callId,
        });
      } catch {
        /* Observers cannot acknowledge native work. */
      }
    }
  }
}

export function createPrimaryAgentVoice(
  options: PrimaryAgentVoiceOptions,
): PrimaryAgentVoice {
  return new PrimaryAgentVoice(options);
}
