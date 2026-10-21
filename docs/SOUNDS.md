# Voice and attention sounds

Tracked by [GitHub #8](https://github.com/MattGibney/Crew/issues/8).

Crew uses short original two-note sine tones, generated locally without downloaded assets or an external audio service. Call connection rises; hang-up falls. Mute falls and unmute rises with a shorter, lower pair. A higher chime identifies a request for your attention. System output volume still controls audibility.

The connection cue plays when WebRTC reports connected, not when Connect is clicked. It confirms the call transport, not microphone permission or audible manager speech. Hang-up plays once when an established call releases its local resources, including transport loss; it does not claim the remote shutdown request succeeded. Canceling a call before it connects stays quiet. Mute/unmute cues follow successful explicit open-microphone control changes. Automatic initial capture, PTT holds/releases and failed or canceled permission requests do not add mute/unmute tones.

## When attention sounds

A notification means Crew needs your response or action. Supported evidence is a native manager question/approval/connector request, a current unanswered worker question, or the manager's explicit `local_orchestration.request_attention` signal. A worker completion, failure or blocker by itself stays quiet. The manager can recover a failure quietly; if it needs a decision, it explicitly signals that need.

Conversational questions use `request_attention({requestId,message})` with a stable unique request ID. The manager must ask the question in its normal conversation and reuse the ID on retries. It must not emit another signal for a native input request or an existing worker question. The adapter accepts only a completed, validated successful call to this exact tool. Text content and punctuation are never used to guess intent. This depends on the manager following the explicit tool protocol, rather than claiming perfect detection of arbitrary prose questions.

Call cues deduplicate per call and actual input transition. Attention keys include manager thread/request identity or worker task/run/question identity. Multiple new requests in one snapshot produce one chime. Repeated snapshots, reconnect/replay and reopening do not replay recorded identities. Answered and stale worker questions do not sound.

## Playback ownership and limits

In macOS Crew, each project host plays attention independently of the disposable manager window, including unselected projects. The browser renderer defers attention playback to that owner. Each project retains its own private seen-event ledger alongside its desktop state; identical request IDs in different projects remain independent. The host invokes the system audio player with a bundled original WAV and never opens a microphone or model session for sound. A playback or ledger failure is reported as unavailable instead of repeatedly retrying old notifications.

Standalone browser sessions play attention through the renderer and retain seen identities in local storage for that loopback instance. Browser autoplay restrictions can block sound until interaction. Crew displays a sound-unavailable notice and enables future cues after a click or keypress; it never queues stale sounds to play later. If storage is unavailable, deduplication remains in memory for the current window. Visual requests remain available regardless of playback, system volume or output device. Native and browser playback are separate from the manager voice player's volume/mute controls.

The existing single manager SSE consumer remains unchanged. Sound neither starts a call nor captures input, creates a turn, answers a question or relays a result. Closing the window or switching projects releases call audio resources while project attention owners and independent work can continue. Attention behavior lives in the editable default manager instructions and the explicit tool schema; custom full-replacement instructions remain authoritative. Saved manager instruction changes follow the existing explicit Start/Restart activation rules. Manager stop and coordinated updates retain their current lifecycle and admission guards.

## Validation

Run `npm test` and `npm run renderer:build`. Sound policy and voice-hook tests cover event correlation, actual capture success, denial/cancellation, mute persistence, repeated callbacks and cleanup. The browser fixture records oscillator scheduling as synthetic telemetry; it does not capture physical input or prove human acoustic acceptance. Native tests cover private ledger persistence, window-independent event delivery and playback failure handling. Human judgment of volume, tone preference and real device audibility remains separate from automated evidence.
