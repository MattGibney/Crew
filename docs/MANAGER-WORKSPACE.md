# Crew manager workspace (AI-014)

Crew 0.8 keeps one persistent manager conversation in the main pane and every worker in the adjacent workspace. Narrow windows use Conversation and Workers views. The manager remains the only conversational interface; cards request targeted actions through it.

## Everyday use

Type a message and press Enter (Shift Enter inserts a line break), or connect voice. Text and voice use the same saved Codex chat. Recent native user messages and manager replies are restored after reload; tool activity is available on demand. Questions and approvals remain explicit. Stop manager cancels its current turn without stopping independent workers.

Connect voice prepares a call with the microphone off. In Push to talk, hold the visible button or Space outside editable/interactive controls; release stops physical capture. Enter also works while the hold button has focus. In Open microphone, explicitly choose Start microphone, then Stop microphone. Window blur, hiding, cancellation and disconnect stop input. A permission result arriving after release is discarded. End the call before changing mode or voice. Voice selection remains saved locally. The current call's transcript is labelled separately from durable manager work messages.

Worker cards show the agreed task, ticket reference, recorded execution status, fresh observed process liveness, meaningful progress, queued reviews, and elapsed wall time when supported by matching execution timestamps. Details retain actual project/repository/worktree identity and full reports. Completed, failed, stopped and removed records remain in expandable history; pending reviews and live/paused workers stay prominent. Pause, Stop, Resume and Remove worktree enter the manager with stable task/run/action IDs. Safe removal still refuses dirty or unresolved work. A request acknowledgement is not confirmed lifecycle completion.

The current durable task contract has ticket references but no verified Linear title/status snapshot. The UI explicitly marks those fields unavailable rather than displaying the task brief as a ticket title. Worker status is never presented as Linear status. A later metadata cache must carry actual read evidence and observation time, without ticket mutations or model polling.

## Design and theme

React JavaScript, official shadcn/ui components and Lucide continue unchanged as the foundation. Neutral light surfaces, standard semantic tokens, and the approved icon's blue primary are used throughout. `renderer/src/styles/theme.css` remains the sole theme file and accepts official theme output without translation. Both compilation and real rendering with an untouched official neutral preset were checked. There is no theme selector or dark-mode feature.

## Voice transport and boundaries

Voice uses the existing supported native Codex realtime handoff. No transcript event starts a manager turn and no result is relayed twice. Explicit Connect creates an AudioContext ConstantSource with offset zero into a MediaStream destination only. It never connects to the speaker destination or opens an input device. This supplies transport silence; physical microphone tracks replace it only for explicit input. Stop restores silence and immediately disables/stops physical tracks. End call closes the peer and disposes nodes, generated track and context.

The real trackless A/B call connected but sent zero RTP and generated no greeting. Generated silence restored the selected Cove greeting, output transcript and inbound audio packets with zero input transcript events, no local microphone track and null microphone energy. This verifies generation and browser playback state, not human acoustic quality. The native startup greeting item and supported appendSpeech remain session-bound and unchanged.

Renderer API/origin/preload boundaries and controller/worker ownership remain unchanged. ReactMarkdown renders safe text formatting; raw HTML is not enabled and remote message images are not fetched. Test-only browser fixtures are excluded from release packages. Rebuild then restart any source controller before testing pinned assets.

## Acceptance boundaries

See `tickets/AI-014.md` for the public capability summary. Browser fixtures cover synthetic media permission/race cleanup, targeted cards, approvals, saved setup values and responsive presentation. Real checks cover subscription preparation, saved native text conversation and voice transport/greeting without microphone capture. Existing controller concurrency/lifecycle regression tests remain required; this UI stage does not reprovision applications or modify any configured business repository. Native observation was unavailable during that acceptance run. Native accessibility and physical microphone/speaker/interruption acceptance remain separate human checks.
