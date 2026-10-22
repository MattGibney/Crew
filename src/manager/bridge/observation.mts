import type { NativeNotification } from "./protocol.mjs";
import type {
  NativeItem,
  TimelineOptions,
} from "../conversation/contracts.mjs";
import type { LastVoice, ManagerApproval } from "./contracts.mjs";
import type { createConversationTimeline } from "../conversation/timeline.mjs";
import { errorMessage } from "../../shared/errors.mjs";
import { safeError } from "./redaction.mjs";
export interface NativeObservationState {
  voiceActive: boolean;
  realtimeMode: "item" | "flat" | null;
  canonicalTimeline: boolean;
  lastVoice: LastVoice | null;
  activeTurnId: string | null;
  status: string;
}
interface ObservationBindings {
  state: NativeObservationState;
  timeline: ReturnType<typeof createConversationTimeline>;
  negotiation?: {
    resolve: (sdp: string) => void;
    reject: (error: unknown) => void;
  };
  completedTurns: Set<string>;
  approvals: Map<string, ManagerApproval>;
  record: (
    item: NativeItem,
    turnId: string | null,
    options?: TimelineOptions,
  ) => void;
  markCompleted: (id: string) => void;
  changed: () => void;
  emit: (type: string, data?: Record<string, unknown>) => void;
}
/** Passive native observation only. Handoffs and transcripts never start a turn. */
export function observeNotification(
  notification: NativeNotification,
  {
    state,
    timeline,
    negotiation,
    completedTurns,
    approvals,
    record,
    markCompleted,
    changed,
    emit,
  }: ObservationBindings,
): void {
  const { method, params } = notification;
  if (method === "thread/started") return;
  if (method === "thread/realtime/sdp") negotiation?.resolve(params.sdp);
  else if (method === "thread/realtime/started") {
    state.voiceActive = true;
    state.realtimeMode = state.canonicalTimeline ? "item" : null;
    if (state.lastVoice) state.lastVoice.startedAt = new Date().toISOString();
    emit("backend-started");
  } else if (method === "thread/realtime/error") {
    if (state.lastVoice) state.lastVoice.error = safeError(params.message);
    const error = new Error(params.message);
    negotiation?.reject(error);
    emit("error", { message: safeError(error) });
  } else if (method === "thread/realtime/closed") {
    timeline.partial();
    if (state.lastVoice) {
      state.lastVoice.closedAt = new Date().toISOString();
      state.lastVoice.closeReason = safeError(params.reason || "Voice ended.");
    }
    state.voiceActive = false;
    negotiation?.reject(new Error(params.reason || "Voice closed."));
    emit("closed", { reason: params.reason || "Voice ended." });
    changed();
  } else if (method === "thread/realtime/transcript/delta") {
    if (state.lastVoice) {
      const key =
        params.role === "user"
          ? "inputTranscriptEvents"
          : "outputTranscriptEvents";
      state.lastVoice[key]++;
    }
    if (!state.canonicalTimeline && state.realtimeMode !== "item") {
      state.realtimeMode = "flat";
      timeline.flat(params.role, params.delta);
      changed();
    }
    emit("transcript-delta", { role: params.role, text: params.delta });
  } else if (method === "thread/realtime/transcript/done") {
    if (!state.canonicalTimeline && state.realtimeMode !== "item") {
      state.realtimeMode = "flat";
      timeline.flat(params.role, params.text, { done: true });
      changed();
    }
    emit("transcript-done", { role: params.role, text: params.text });
  } else if (
    method === "thread/realtime/item/started" ||
    method === "thread/realtime/item/completed"
  ) {
    if (params.item.type === "transcriptSegment") {
      if (state.realtimeMode === "flat") return;
      state.realtimeMode = "item";
    }
    timeline.realtime(params.item, {
      status: method.endsWith("/started") ? "streaming" : "complete",
    });
    changed();
  } else if (method === "thread/realtime/item/transcript/delta") {
    if (state.realtimeMode !== "flat") {
      state.realtimeMode = "item";
      timeline.delta(params.itemId, params.delta);
      changed();
    }
  } else if (method === "item/agentMessage/delta") {
    timeline.delta(params.itemId, params.delta);
    changed();
  } else if (method === "turn/started") {
    if (completedTurns.has(params.turn.id)) return;
    state.activeTurnId = params.turn.id;
    state.status = "working";
    changed();
  } else if (method === "turn/completed") {
    for (const item of params.turn.items || []) record(item, params.turn.id);
    markCompleted(params.turn.id);
    if (!state.activeTurnId || state.activeTurnId === params.turn.id) {
      state.activeTurnId = null;
      state.status = params.turn.status;
    }
    if (params.turn.error)
      emit("notice", { message: safeError(errorMessage(params.turn.error)) });
    changed();
  } else if (method === "item/started" || method === "item/completed") {
    record(params.item, params.turnId, {
      status: method === "item/started" ? "streaming" : "complete",
    });
    changed();
  } else if (method === "serverRequest/resolved") {
    approvals.delete(String(params.requestId));
    changed();
  } else if (method === "error")
    emit("notice", {
      message: safeError(params.error?.message || "Backend work error."),
    });
}
