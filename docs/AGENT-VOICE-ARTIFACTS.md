# Saved public voice calls (#107)

Codex remains authoritative for native chat and model context. The installed
`0.163.0-alpha.11` and verified `0.163.0-alpha.11.2` builds do not implement the
advertised native timeline/item retrieval route needed to restore voice text.
Crew therefore owns a separate **voice-call artifact** for owner display. It is not another agent conversation and is never used as input,
initial context, an injected native item or a replacement thread.

Only validated role-bearing native transcript items qualify. The runtime first
requires native started and exact realtime-session identity; the primary voice
host then matches its current public call and exact binding. Each artifact keeps
project/agent/native-thread identity, Crew call ID, runtime voice-session ID,
native realtime-session ID and native item IDs. A native realtime ID alone may
repeat across calls. Speaker roles cannot change. Full completed snapshots win
over partial deltas; duplicates upsert the same item. Local observation ordinal
records item order within the call, not an inferred native coding timeline.

The artifacts use private atomic JSON files under the project state directory.
The foundation single-writer lock must cover open, recovery, writes and disposal.
They are not Git content or an agent-readable tool resource. A host restart marks
unfinished calls interrupted; observed text remains readable without inventing a
missing tail. Explicit call close drains current writes, while microphone/audio
release remains independent. Storage errors surface separately and preserve an
interrupted/incomplete marker where writing that marker is possible. No item is
silently evicted or truncated: limits are 2 MiB per call, 2,048 items per call and
200,000 characters per item. Owner reads page through calls.

Pending updates for the same exact native item coalesce before disk writing;
completed native snapshots supersede partials. The pending queue is bounded to
128 distinct items. An overflow reports a storage failure and an incomplete call
instead of silently evicting text. This bounds delayed writes without changing
the native item/call identity or using the artifact as model context.

The owner API exposes `readVoiceArtifacts(agentId, cursor?)` after authorizing
history access and deriving the native thread from the durable agent record.
`voiceArtifactsRevision` refreshes the selected conversation when artifacts
change. Since [#123](https://github.com/MattGibney/Crew/issues/123), typed native
messages and live/retained voice items appear in one chronological conversation,
with the same message styling and speaker attribution. There is no separate
saved-calls section or saved/historical message label. Provenance stays in the
native records and artifacts. The display joins exact native thread, Crew call
and transcript-item IDs, never text or guessed coding-turn links. A live snapshot
stays visible through delayed retention after hangup; its stable row identity
survives the transition. Completed retained snapshots win over late live partials.
Active artifacts also restore visible text after a window reload. Older loaded
calls remain reachable during refresh and reconnect, with loading/errors and
incomplete/interrupted text disclosed without claiming missing words exist.

Ordering uses available native timing and voice observation times. Codex's native
turn start is Unix seconds and is explicitly disclosed as coarse timing, not an
exact item timestamp. Missing native times keep original native order beside a
known native neighbor; if none exists they precede dated voice, with an explicit
notice that cross-source order cannot be verified. No read/reload time is assigned
to old messages. New artifact writes retain each item's first observed time
across deltas and completion; older artifacts retain their existing observation
times. Equal times preserve native order and deterministic call/item order.
The display does not change model context, dispatch, call or microphone behavior.

Run `npm run typecheck`, `npm run build`, then
`node scripts/unified-chat-timeline-browser-acceptance.mjs` (set
`CREW_PLAYWRIGHT_MODULE` if Playwright is provided outside the checkout).
The focused flow uses real AgentsApp components with disposable synthetic ports,
headless Chrome, no model or media and screenshots in the system temporary
folder. It covers interleaving, live-to-retained reconciliation, delayed/stale
reads, reload, ties, unavailable times, drafts, earlier pages, scroll and narrow
layout. It does not establish human acoustic acceptance or a packaged native
voice-call run. Private/unknown coding turns remain hidden by the
existing native-history filter; only an actual native promotion can link them.

Acceptance includes production host/API/component checks with synthetic peers,
plus a real generated-audio WebRTC flow on `0.163.0-alpha.11.2`: the spoken
two-plus-two request and native reply remained exact after disconnect, unchanged
Restart, changed-profile native compaction/Restart, Stop and state/archive reopen
on the same native chat. No physical microphone, speaker output or auth copying
was used. This establishes generated-input retention, not human acoustic quality.

Transcripts from before artifact capture was available cannot be reconstructed
from model memory, timing or delegation text. They remain unavailable until a
supported native retrieval route supplies them. A successfully saved new call
does not establish recovery of that older evidence.
