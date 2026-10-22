import type { RuntimeBinding } from "../agents/contracts.mjs";
import type { PrimaryAgentVoice } from "../agents/voice-composition.mjs";

/** Validation-only owner adapter. Composition owns admission, native identity,
 * cancellation, public history, handoffs and lifecycle settlement. */
export function createVoiceOwnerCommands(
  voice: PrimaryAgentVoice,
  selectedVoice: () => string | null,
) {
  return async (command: string, value: unknown): Promise<unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Voice fields are required.");
    const args = value as Record<string, unknown>;
    const allowed =
      command === "voice.list"
        ? ["binding"]
        : command === "voice.start"
          ? ["binding", "callId", "sdp", "voice"]
          : command === "voice.ready"
            ? ["binding", "callId", "sessionToken"]
            : command === "voice.stop"
              ? ["binding", "callId"]
              : null;
    if (
      !allowed ||
      Object.keys(args).some((key) => !allowed.includes(key)) ||
      allowed.some((key) => !(key in args))
    )
      throw new Error("Unsupported voice fields.");
    const binding = args.binding as RuntimeBinding;
    if (
      !binding ||
      Object.keys(binding).sort().join(",") !==
        "agentId,projectId,sessionId,threadId" ||
      ![
        binding.projectId,
        binding.agentId,
        binding.sessionId,
        binding.threadId,
      ].every(identity)
    )
      throw new Error("Exact native voice identity is required.");
    if (command === "voice.list")
      return {
        ...(await voice.listVoices(binding)),
        selectedVoice: selectedVoice(),
      };
    if (!identity(args.callId))
      throw new Error("A bounded voice call identity is required.");
    const call = { binding, callId: args.callId };
    if (command === "voice.stop") return voice.stop(call);
    if (command === "voice.ready") {
      if (!identity(args.sessionToken))
        throw new Error("The active voice token is required.");
      return voice.ready({ ...call, sessionToken: args.sessionToken });
    }
    if (
      !identity(args.voice) ||
      typeof args.sdp !== "string" ||
      !args.sdp ||
      args.sdp.length > 1_000_000
    )
      throw new Error("A bounded offer and supported voice are required.");
    return voice.start({ ...call, sdp: args.sdp, voice: args.voice });
  };
}
function identity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
