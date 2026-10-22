# Saved public voice calls (#107)

Codex remains authoritative for native chat and model context. The installed
`0.163.0-alpha.11` and verified `0.163.0-alpha.11.2` builds do not implement the
advertised native timeline/item retrieval route needed to restore voice text.
Crew therefore owns a separate, explicitly labelled **voice-call artifact** for
owner display. It is not another agent conversation and is never used as input,
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
change. Saved calls appear in their own section after closure, with source and
partial/interrupted state. The live projection clears on call end, avoiding a
second rendering of the same active items. Older loaded calls remain reachable
during refresh and reconnect. Private/unknown coding turns remain hidden by the
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
