import { randomUUID } from "node:crypto";
import type {
  Agent,
  RuntimeBinding,
  RuntimeError,
  RuntimeResult,
} from "./contracts.mjs";
import {
  CodexPeer,
  CodexRpcError,
  object,
  record,
  type CodexEnvelope,
} from "./codex-peer.mjs";

export interface CodexRealtimeAudio {
  data: string;
  sampleRate: number;
  numChannels: number;
  samplesPerChannel: number | null;
  itemId: string | null;
}
export interface CodexRealtimeConnect {
  transport: { type: "webrtc"; sdp: string } | { type: "websocket" };
  voice?: string;
}
export interface CodexRealtimeConnection {
  voiceSessionId: string;
  realtimeSessionId: string | null;
  sdp: string | null;
  voice: string;
}
export type CodexRealtimeState =
  "closed" | "connecting" | "active" | "stopping" | "uncertain";
export type CodexRealtimeEvent = {
  binding: RuntimeBinding;
  voiceSessionId: string;
  observedAt: string;
} & (
  | { kind: "started"; realtimeSessionId: string | null }
  | { kind: "closed" }
  | { kind: "error"; error: RuntimeError }
  | { kind: "audio"; audio: CodexRealtimeAudio }
  | {
      kind: "transcript";
      role: "user" | "assistant";
      text: string;
      done: boolean;
      delta: boolean;
      itemId: string | null;
    }
  | {
      kind: "handoff";
      realtimeSessionId: string;
      turnId: string;
      nativeItemId: string;
    }
);
export interface CodexRealtimePort {
  listRealtimeVoices(binding: RuntimeBinding): Promise<
    RuntimeResult<{
      voices: { id: string; name: string }[];
      defaultVoice: string;
    }>
  >;
  connectRealtime(
    binding: RuntimeBinding,
    input: CodexRealtimeConnect,
  ): Promise<RuntimeResult<CodexRealtimeConnection>>;
  appendRealtimeAudio(
    binding: RuntimeBinding,
    voiceSessionId: string,
    audio: CodexRealtimeAudio,
  ): Promise<RuntimeResult<null>>;
  disconnectRealtime(
    binding: RuntimeBinding,
    voiceSessionId: string,
  ): Promise<RuntimeResult<null>>;
  realtimeStatus(binding: RuntimeBinding): {
    state: CodexRealtimeState;
    voiceSessionId: string | null;
  };
  subscribeRealtime(listener: (event: CodexRealtimeEvent) => void): () => void;
}
type EventData = CodexRealtimeEvent extends infer Event
  ? Event extends CodexRealtimeEvent
    ? Omit<Event, "binding" | "voiceSessionId" | "observedAt">
    : never
  : never;
type Call = {
  id: string;
  state: CodexRealtimeState;
  transport: CodexRealtimeConnect["transport"]["type"];
  dispatched: boolean;
  started: boolean;
  realtimeSessionId: string | null;
  sdp: string | null;
  error: RuntimeError | null;
  transcriptMode: "item" | "flat" | null;
  transcriptRoles: Map<string, "user" | "assistant">;
  handoffs: Set<string>;
};
const fail = (
  code: RuntimeError["code"],
  message: string,
): RuntimeResult<never> => ({ state: "failed", error: { code, message } });
const identity = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  !/[\u0000-\u001f\u007f]/.test(value);
function audioChunk(value: unknown): value is CodexRealtimeAudio {
  return (
    object(value) &&
    typeof value.data === "string" &&
    value.data.length > 0 &&
    value.data.length <= 512 * 1024 &&
    value.data.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value.data,
    ) &&
    Number.isSafeInteger(value.sampleRate) &&
    Number(value.sampleRate) >= 8000 &&
    Number(value.sampleRate) <= 192000 &&
    Number.isSafeInteger(value.numChannels) &&
    Number(value.numChannels) >= 1 &&
    Number(value.numChannels) <= 8 &&
    (value.samplesPerChannel === null ||
      (Number.isSafeInteger(value.samplesPerChannel) &&
        Number(value.samplesPerChannel) >= 0 &&
        Number(value.samplesPerChannel) <= 1_000_000)) &&
    (value.itemId === null || identity(value.itemId))
  );
}
function projectAudio(value: CodexRealtimeAudio): CodexRealtimeAudio {
  return {
    data: value.data,
    sampleRate: value.sampleRate,
    numChannels: value.numChannels,
    samplesPerChannel: value.samplesPerChannel,
    itemId: value.itemId,
  };
}

/** One native realtime call on an already-started owned thread. No microphone,
 * synthetic input, client-routed handoff, credential lookup or durable transcript. */
export class CodexRealtimeController {
  private call: Call | null = null;
  private connecting = false;
  private disconnecting: Promise<RuntimeResult<null>> | null = null;
  private waiters = new Set<() => void>();
  constructor(
    private readonly options: {
      binding: RuntimeBinding;
      peer: CodexPeer;
      profile: Agent["profile"];
      usable(): boolean;
      emit(event: CodexRealtimeEvent): void;
      timeoutMs: number;
    },
  ) {}

  status() {
    return {
      state: this.call?.state ?? ("closed" as CodexRealtimeState),
      voiceSessionId: this.call?.id ?? null,
    };
  }
  private publish(event: EventData) {
    if (!this.call) return;
    this.options.emit({
      ...event,
      binding: this.options.binding,
      voiceSessionId: this.call.id,
      observedAt: new Date().toISOString(),
    } as CodexRealtimeEvent);
  }
  private changed() {
    for (const wake of this.waiters) wake();
  }
  private async wait(call: Call, complete: () => boolean) {
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        if (complete()) {
          clearTimeout(timer);
          this.waiters.delete(finish);
          resolve();
        } else if (
          call.error ||
          !this.options.peer.connected ||
          this.call !== call
        ) {
          clearTimeout(timer);
          this.waiters.delete(finish);
          reject(new Error("Native realtime state is unavailable."));
        }
      };
      const timer = setTimeout(() => {
        this.waiters.delete(finish);
        reject(new Error("Native realtime acknowledgement timed out."));
      }, this.options.timeoutMs);
      this.waiters.add(finish);
      finish();
    });
  }
  disconnected() {
    if (this.call && this.call.state !== "closed") {
      this.call.state = "uncertain";
      this.call.error = {
        code: "disconnected",
        message:
          "The native realtime transport disconnected; closure is unconfirmed.",
      };
      this.publish({ kind: "error", error: this.call.error });
      this.changed();
    }
  }

  async listVoices() {
    if (!this.options.usable())
      return fail(
        "disconnected",
        "Start this agent explicitly before loading native voices.",
      );
    try {
      const result = record(
        await this.options.peer.rpc("thread/realtime/listVoices", {}),
      );
      const voices = record(result.voices);
      if (
        !Array.isArray(voices.v3) ||
        !voices.v3.length ||
        voices.v3.length > 1000 ||
        !voices.v3.every(
          (id) => typeof id === "string" && /^[a-z][a-z0-9_-]{0,60}$/.test(id),
        ) ||
        typeof voices.defaultV1 !== "string" ||
        !voices.v3.includes(voices.defaultV1)
      )
        return fail(
          "unsupported",
          "Codex did not return a usable native v3 voice catalogue.",
        );
      return {
        state: "acknowledged" as const,
        value: {
          voices: [...new Set<string>(voices.v3)].map((id) => ({
            id,
            name: id.charAt(0).toUpperCase() + id.slice(1),
          })),
          defaultVoice: voices.defaultV1,
        },
      };
    } catch (error) {
      return fail(
        error instanceof CodexRpcError && error.code === -32601
          ? "unsupported"
          : "runtime_error",
        "The native voice catalogue is unavailable.",
      );
    }
  }

  async connect(
    input: CodexRealtimeConnect,
  ): Promise<RuntimeResult<CodexRealtimeConnection>> {
    if (!this.options.usable())
      return fail(
        "disconnected",
        "Start this agent explicitly before connecting voice.",
      );
    if (
      this.connecting ||
      this.disconnecting ||
      (this.call && this.call.state !== "closed")
    )
      return fail(
        "runtime_error",
        "The prior native voice call is active or unresolved.",
      );
    if (
      !input ||
      !object(input.transport) ||
      !(
        input.transport.type === "websocket" ||
        (input.transport.type === "webrtc" &&
          typeof input.transport.sdp === "string" &&
          input.transport.sdp.length > 0 &&
          input.transport.sdp.length <= 256 * 1024)
      )
    )
      return fail(
        "configuration_rejected",
        "Voice needs a valid WebRTC offer or native websocket transport.",
      );
    const call: Call = {
      id: randomUUID(),
      state: "connecting",
      transport: input.transport.type,
      dispatched: false,
      started: false,
      realtimeSessionId: null,
      sdp: null,
      error: null,
      transcriptMode: null,
      transcriptRoles: new Map(),
      handoffs: new Set(),
    };
    this.call = call;
    this.connecting = true;
    try {
      const catalogue = await this.listVoices();
      if (catalogue.state === "failed") {
        call.state = "closed";
        return catalogue;
      }
      const voice = input.voice ?? catalogue.value.defaultVoice;
      if (!catalogue.value.voices.some((entry) => entry.id === voice)) {
        call.state = "closed";
        return fail(
          "configuration_rejected",
          "Choose a voice from the current native catalogue.",
        );
      }
      if (call.state !== "connecting" || !this.options.usable())
        return fail(
          "cancelled",
          "Voice connection was cancelled before dispatch.",
        );
      const profile = this.options.profile;
      const instructions = [
        profile.systemPrompt,
        profile.name ? `Agent name: ${profile.name}` : "",
        profile.personality
          ? `Agent personality preferences:\n${profile.personality}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      call.dispatched = true;
      await this.options.peer.rpc("thread/realtime/start", {
        threadId: this.options.binding.threadId,
        transport:
          input.transport.type === "webrtc"
            ? { type: "webrtc", sdp: input.transport.sdp }
            : { type: "websocket" },
        outputModality: "audio",
        version: "v3",
        voice,
        voiceSessionId: call.id,
        realtimeStartInstructions: instructions,
        realtimeEndInstructions: instructions,
        clientManagedHandoffs: false,
        includeStartupContext: true,
      });
      await this.wait(
        call,
        () =>
          call.state === "closed" ||
          (call.started &&
            (call.transport === "websocket" || call.sdp !== null)),
      );
      if ((call.state as CodexRealtimeState) !== "active")
        return fail(
          "cancelled",
          "The voice call closed before connection completed.",
        );
      return {
        state: "acknowledged",
        value: {
          voiceSessionId: call.id,
          realtimeSessionId: call.realtimeSessionId,
          sdp: call.sdp,
          voice,
        },
      };
    } catch (error) {
      if (call.state !== "closed") {
        const rejected =
          error instanceof CodexRpcError &&
          (error.sent === false ||
            error.code === -32601 ||
            error.code === -32602);
        call.state = !call.dispatched || rejected ? "closed" : "uncertain";
      }
      return fail(
        call.state === "uncertain" ? "disconnected" : "runtime_error",
        call.state === "uncertain"
          ? "Native voice startup is unresolved. Disconnect this exact call before reconnecting; no input was replayed."
          : "Native voice startup was rejected or cancelled.",
      );
    } finally {
      this.connecting = false;
      this.changed();
    }
  }

  async appendAudio(
    voiceSessionId: string,
    audio: CodexRealtimeAudio,
  ): Promise<RuntimeResult<null>> {
    const call = this.call;
    if (
      !call ||
      call.id !== voiceSessionId ||
      call.state !== "active" ||
      call.transport !== "websocket" ||
      !this.options.usable()
    )
      return fail(
        "identity_mismatch",
        "Audio input requires this exact active websocket voice call.",
      );
    if (!audioChunk(audio))
      return fail(
        "configuration_rejected",
        "Native audio chunk is invalid or too large.",
      );
    try {
      await this.options.peer.rpc("thread/realtime/appendAudio", {
        threadId: this.options.binding.threadId,
        audio: { ...projectAudio(audio) },
      });
      return { state: "acknowledged", value: null };
    } catch {
      return fail(
        "disconnected",
        "Native audio acknowledgement is unavailable. The audio chunk was not retried.",
      );
    }
  }

  disconnect(voiceSessionId: string): Promise<RuntimeResult<null>> {
    const call = this.call;
    if (!call || call.id !== voiceSessionId)
      return Promise.resolve(
        fail("identity_mismatch", "This voice call is no longer current."),
      );
    if (call.state === "closed")
      return Promise.resolve({ state: "acknowledged", value: null });
    if (this.disconnecting) return this.disconnecting;
    if (!call.dispatched) {
      call.state = "closed";
      this.publish({ kind: "closed" });
      this.changed();
      return Promise.resolve({ state: "acknowledged", value: null });
    }
    call.state = "stopping";
    call.error = null;
    this.disconnecting = (async (): Promise<RuntimeResult<null>> => {
      try {
        await this.options.peer.rpc("thread/realtime/stop", {
          threadId: this.options.binding.threadId,
        });
        await this.wait(call, () => call.state === "closed");
        return { state: "acknowledged", value: null };
      } catch {
        if (call.state !== "closed") call.state = "uncertain";
        return fail(
          "disconnected",
          "Native voice closure is unconfirmed. No turn, process or resource was force-stopped.",
        );
      } finally {
        this.disconnecting = null;
        this.changed();
      }
    })();
    return this.disconnecting;
  }

  receive(envelope: CodexEnvelope) {
    const call = this.call;
    const { method, params } = envelope;
    if (
      !call ||
      call.state === "closed" ||
      envelope.id !== undefined ||
      params.threadId !== this.options.binding.threadId ||
      !method.startsWith("thread/realtime/")
    )
      return;
    if (method === "thread/realtime/started") {
      if (
        !(
          params.realtimeSessionId === null ||
          identity(params.realtimeSessionId)
        ) ||
        params.version !== "v3"
      )
        return;
      if (
        call.realtimeSessionId &&
        params.realtimeSessionId !== call.realtimeSessionId
      )
        return;
      const first = !call.started;
      call.started = true;
      call.realtimeSessionId = params.realtimeSessionId;
      if (call.state === "connecting") call.state = "active";
      if (first)
        this.publish({
          kind: "started",
          realtimeSessionId: call.realtimeSessionId,
        });
    } else if (method === "thread/realtime/sdp") {
      if (
        call.transport === "webrtc" &&
        typeof params.sdp === "string" &&
        params.sdp.length > 0 &&
        params.sdp.length <= 256 * 1024
      )
        call.sdp = params.sdp;
    } else if (method === "thread/realtime/closed") {
      call.state = "closed";
      this.publish({ kind: "closed" });
    } else if (method === "thread/realtime/error") {
      call.state = "uncertain";
      call.error = {
        code: "runtime_error",
        message:
          "The native voice session reported an error. Disconnect it before reconnecting.",
      };
      this.publish({ kind: "error", error: call.error });
    } else if (method === "thread/realtime/outputAudio/delta") {
      if (
        call.state === "active" &&
        call.transport === "websocket" &&
        audioChunk(params.audio)
      )
        this.publish({ kind: "audio", audio: projectAudio(params.audio) });
    } else if (
      method === "thread/realtime/transcript/delta" ||
      method === "thread/realtime/transcript/done"
    ) {
      const text = method.endsWith("/done") ? params.text : params.delta;
      if (
        call.transcriptMode !== "item" &&
        (params.role === "user" || params.role === "assistant") &&
        typeof text === "string" &&
        text.length <= 200_000
      ) {
        call.transcriptMode = "flat";
        this.publish({
          kind: "transcript",
          role: params.role,
          text,
          done: method.endsWith("/done"),
          delta: method.endsWith("/delta"),
          itemId: null,
        });
      }
    } else if (
      method === "thread/realtime/item/started" ||
      method === "thread/realtime/item/completed"
    ) {
      const item = params.item;
      if (
        !object(item) ||
        !identity(item.id) ||
        !identity(item.realtimeSessionId) ||
        (call.realtimeSessionId &&
          item.realtimeSessionId !== call.realtimeSessionId)
      )
        return;
      if (
        item.type === "transcriptSegment" &&
        call.transcriptMode !== "flat" &&
        (item.role === "user" || item.role === "assistant") &&
        typeof item.text === "string" &&
        item.text.length <= 200_000
      ) {
        call.transcriptMode = "item";
        call.transcriptRoles.set(item.id, item.role);
        if (call.transcriptRoles.size > 1024)
          call.transcriptRoles.delete(
            call.transcriptRoles.keys().next().value!,
          );
        this.publish({
          kind: "transcript",
          role: item.role,
          text: item.text,
          done: method.endsWith("/completed"),
          delta: false,
          itemId: item.id,
        });
      } else if (
        item.type === "bemItemPromoted" &&
        identity(item.turnId) &&
        identity(item.itemId)
      ) {
        const key = JSON.stringify([
          item.realtimeSessionId,
          item.turnId,
          item.itemId,
        ]);
        if (!call.handoffs.has(key)) {
          call.handoffs.add(key);
          this.publish({
            kind: "handoff",
            realtimeSessionId: item.realtimeSessionId,
            turnId: item.turnId,
            nativeItemId: item.itemId,
          });
        }
      }
    } else if (
      method === "thread/realtime/item/transcript/delta" &&
      call.transcriptMode === "item" &&
      typeof params.itemId === "string" &&
      typeof params.delta === "string" &&
      params.delta.length <= 200_000
    ) {
      const role = call.transcriptRoles.get(params.itemId);
      if (role)
        this.publish({
          kind: "transcript",
          role,
          text: params.delta,
          done: false,
          delta: true,
          itemId: params.itemId,
        });
    }
    this.changed();
  }
}
