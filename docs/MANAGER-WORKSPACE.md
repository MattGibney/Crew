# Crew manager workspace (AI-014)

Crew keeps one persistent manager conversation in the main pane and every worker in the adjacent workspace. Narrow windows use Conversation and Workers views. The manager remains the only conversational interface; cards request targeted actions through it.

## Everyday use

Type a message and press Enter (Shift Enter inserts a line break), or connect voice. Text and voice use the same saved Codex chat. Recent native user messages and manager replies are restored after reload; tool activity is available on demand. Questions and approvals remain explicit. Stop manager cancels its current turn without stopping independent workers.

Open microphone is the default. Connect voice starts the call and requests/enables the microphone once connected. Input stays active when switching apps or losing window focus until you choose Mute microphone or End call. Explicit mute/cancel remains in effect across reconnects and voice errors; Unmute microphone enables it again. Permission denial offers Retry microphone and never loops capture automatically. There is no separate push-to-talk mode. Closing the window, cancellation, disconnect and quit release all capture. Late permission results after cancellation are discarded. Configure the next call’s voice in Settings → Manager profile; it is saved in project state. Typed and spoken messages share one durable timeline. The composer defaults to Voice; selecting Text preserves the call and draft.

Worker cards show the agreed task, ticket reference, recorded execution status, fresh observed process liveness, meaningful progress, queued reviews, and elapsed wall time when supported by matching execution timestamps. Details retain actual project/repository/worktree identity and full reports. Completed, failed, stopped and removed records remain in expandable history; pending reviews and live/paused workers stay prominent. Pause, Stop, Resume and Remove worktree enter the manager with stable task/run/action IDs. Safe removal still refuses dirty or unresolved work. A request acknowledgement is not confirmed lifecycle completion.

The current durable task contract has ticket references but no verified Linear title/status snapshot. The UI explicitly marks those fields unavailable rather than displaying the task brief as a ticket title. Worker status is never presented as Linear status. A later metadata cache must carry actual read evidence and observation time, without ticket mutations or model polling.

## Design and theme

React JavaScript, official shadcn/ui components and Lucide continue unchanged as the foundation. Neutral light surfaces, standard semantic tokens, and the approved icon's blue primary are used throughout. `renderer/src/styles/theme.css` remains the sole theme file and accepts official theme output without translation. Both compilation and real rendering with an untouched official neutral preset were checked. There is no theme selector or dark-mode feature.

## Voice transport and boundaries

Voice uses the existing supported native Codex realtime handoff. No transcript event starts a manager turn and no result is relayed twice. Explicit Connect creates an AudioContext ConstantSource with offset zero into a MediaStream destination only. It never connects to the speaker destination. This supplies transport silence while negotiating; explicit Connect in open-mic mode replaces it with microphone input after connection unless explicitly muted. Stop restores silence and immediately disables/stops physical tracks. End call closes the peer and disposes nodes, generated track and context.

The real trackless A/B call connected but sent zero RTP and generated no greeting. Generated silence restored the selected Cove greeting, output transcript and inbound audio packets with zero input transcript events, no local microphone track and null microphone energy. This verifies generation and browser playback state, not human acoustic quality. The native startup greeting item and supported appendSpeech remain session-bound and unchanged.

Renderer API/origin/preload boundaries and controller/worker ownership remain unchanged. ReactMarkdown renders safe text formatting; raw HTML is not enabled. Assistant Markdown supports copyable code blocks and responsive same-origin/HTTPS images with alt text and an unavailable-image fallback. Native copy uses the bounded write-only preload action. Test-only browser fixtures are excluded from release packages. Rebuild then restart any source controller before testing pinned assets.

## Acceptance boundaries

See `tickets/AI-014.md` for the public capability summary. Browser fixtures cover synthetic media permission/race cleanup, targeted cards, approvals, saved setup values and responsive presentation. Real checks cover subscription preparation, saved native text conversation and voice transport/greeting without microphone capture. Existing controller concurrency/lifecycle regression tests remain required; this UI stage does not reprovision applications or modify any configured business repository. Native observation was unavailable during that acceptance run. Native accessibility and physical microphone/speaker/interruption acceptance remain separate human checks.

## Audible feedback

See [Voice and attention sounds](SOUNDS.md) for call connection, hang-up and mute/unmute cues, action-required notifications, deduplication and playback ownership. Routine completion and self-resolved failures stay quiet.

## Following workers (GitHub #14)

The manager's compact worker cards show ticket/task identity, a labelled colour status and title. Select a card to open the worker across the main workspace. The Workers navigation opens a wider overview with latest progress and execution timing when fresh run evidence supports it. All tasks remain reachable through All, Current and Needs attention filters.

Conversation displays available recorded manager assignments, worker reports/replies, questions, answers, lifecycle decisions and execution activity. Older tasks explicitly disclose gaps in retained history. Work notes displays the actual shared Markdown document once the manager or worker writes one; generated orchestration state is separate. Links contains supplied resource URLs and recorded local paths, without guessing a Linear URL or PR from a ticket key or branch. Overview contains assignment, identity, timing, original instructions, model evidence and manager-mediated actions. Ask questions, give direction and review decisions with the manager; Pause, Stop, Resume and safe Remove worktree in detail submit the existing correlated manager requests.

Back to manager restores the conversation and its draft. Other project views have a thin manager call bar with call state, microphone state and start/mute/end controls. Navigation preserves the same voice session and open-mic intent. Settings is outside the project content layout: it hides call controls while the call continues in the background, then restores the previous project view. Selecting another project still ends the departing project's voice session.

## Realtime handoff display (GitHub #20)

Native voice work requests project only the current user request. GitHub #38 places this backing record in Work details while the spoken transcript remains the normal You bubble. Native handoff markup and the recent conversation supplied to the agent stay out of the displayed request. Empty or incomplete handoff input displays “Voice request (transcript unavailable).” until a completed item provides the words. This projection does not dispatch work, reconstruct historical dialogue or deduplicate independent messages by matching text.

`conversation.mjs` projects native user items for live events, canonical timeline hydration and recent-turn replay. `conversation-timeline.mjs` applies the same correction to legacy presentation journals on restore. A persisted presentation marker prevents another unwrapping if current user wording itself contains a literal envelope example. Native chat data, item/turn IDs, promotion references, ordering and existing voice transport remain intact. Ordinary text containing tags and independently observed voice segments retain their original content.

## Reading and rich output

Message Scroller opens saved threads at the bottom and follows new messages and streaming output only while you stay at the bottom. Scrolling back preserves your position through updates; user messages do not anchor the viewport near the top. Jump to latest resumes following. Recorded tool activity expands through Trace; it never invents reasoning, execution or timing. Code blocks have their own Copy button, and manager replies offer Copy message. Text input grows with longer drafts. Enable audio appears only if playback was blocked and disappears on successful recovery or call end.

## Speech and written work details (GitHub #38)

Voice transcripts appear as the ordinary You/Manager conversation. Native voice
handoffs also record a backing work request, progress and a written answer, which
can differ from the words spoken. These appear in expandable **Work details**,
labelled Voice work request, Work progress and Written response. A written answer
remains available there even if no spoken response was observed. Ordinary typed
exchanges stay in the main conversation.

This is artifact presentation, not text deduplication: only the existing delegated
request provenance and its exact native turn establish backing-work identity.
Speech has its own stable native identity and no supplied link to a backing turn;
Crew does not invent one from matching words or timing. Repeated utterances remain
separate. Only consecutive backing records share a disclosure, preserving speech
interruptions and ordering. Completed speech replaces its live row by item ID;
interrupted speech retains a partial label. A live indication represents the
observed protocol lifecycle, not proof that audio was heard.

The presentation journal retains delegation origin on each native exchange item.
Canonical hydration carries that origin forward only for an exact saved
item/turn/actor match in the validated thread, keeping canonical content, status
and position authoritative. Native chat/history, native handoffs and call/audio
ownership are unchanged. No transcript callback launches work or returns a result.

If neither a delegated native request nor matching saved provenance is available
in the bounded history, Crew leaves the item in the ordinary conversation rather
than guessing its origin. No text is hidden based on similarity to speech.
