# Manager scratchpad and follow-up (GitHub #26)

Each project has one saved manager working record. Open **Scratchpad** beside Conversation and Workers to inspect commitments, intended outcomes, next actions, linked ticket/task/run references, notes, decisions, questions and the last saved time. The view works without a call and while the manager is stopped. It is read only: ask for corrections in the ordinary conversation. Voice and text use the same manager and tools. This record is intentional factual context, not hidden reasoning or the entire model context.

The default manager instructions capture explicit requests and promises, including multiple distinct requests in one utterance. Brainstorming and ticket triage do not create commitments by default. The manager corrects stale notes after meaningful changes and keeps delegated commitments open until it reviews actual matching execution evidence. Worker records remain the source of execution truth; tickets remain the source of development scope. No worker scratchpad is added.

## Instructions and adoption

The behavior is visible in the default manager instructions in Settings. Customized and previously saved profiles keep their full replacement semantics: they are not silently extended. To adopt the behavior in an existing saved profile, include the Saved commitments and periodic review guidance from `prompts/manager.md`, save, then explicitly Restart manager in Project settings → Sessions. Ordinary window/controller reloads keep the active instruction snapshot. Tools and saved data are available independently of the chosen profile, but capture is model behavior, not a deterministic transcript extractor or a guarantee that every utterance is recorded.

## Local review

The project controller uses the single local manager schedule engine. The built-in Review commitments schedule defaults to ten minutes and is editable in Project settings → Manager schedules (#64). Only saved outstanding commitments qualify. Empty records and completed/cancelled commitments do not launch model work. The manager must be enabled, idle, without pending native approvals and with voice disconnected; local and all-project update holds block admission. A final check after native preparation protects races with Stop, conversation, voice and update reservations. A stopped manager is never restarted by this scheduler. Only the user's explicit Start re-enables it.

Each eligible review asks the same persistent subscription-backed manager to inspect saved commitments and matching worker evidence. It grants no additional execution, lifecycle, external mutation or approval authority. A question requiring human judgment uses existing attention, without opening a call or microphone. The scheduler itself never launches workers or chooses tickets/backlog.

A durable fingerprint suppresses unchanged already-reviewed commitments/evidence. `nextReviewAt` is an optional UTC timestamp for intentional timed follow-up. A future time defers review until due unless meaningful matching worker evidence arrives earlier; a merely queued/running worker does not override it. Crossing that time makes a new review due. The manager should set a new future time when another timed check is needed. Worker evidence is included only when both task and current run match the commitment. Unknown or failed turn delivery consumes its reservation rather than automatically replaying potentially executed actions; a definite rejection before admission can retry at a later interval. New evidence, changed commitments or a new due time allow another review. This favors avoiding duplicate work over silently retrying uncertain delivery. A checkpoint is not proof that a review completed.

## Storage and protocol

Within the existing project orchestration directory:

- `manager-scratchpad.json`: versioned structured record, bounded at 256 KiB, revision and timestamp. Commitments use stable IDs and pending/delegated/blocked/completed/cancelled statuses, optional outcome, nextAction, nextReviewAt and task/run/ticket references. Notes, decisions and questions are arrays of concise strings.
- `manager-review.json`: last reserved review fingerprint/time. Contains no credentials or audio.
- `manager-schedules.json`: saved schedule definitions and optimistic revision.
- `manager-schedule-runs.json`: last submission, next slot and status/error receipts.

Only manager-role `local_orchestration.read_manager_scratchpad` and `update_manager_scratchpad` expose the record. Updates supply `patchJson` containing expectedRevision and complete replacement arrays for included sections. Omitted sections are preserved. Cross-process state locking and atomic replacement protect revision checks; identical saves do not advance time/revision. Malformed data is preserved and fails closed. Do not store secrets, private reasoning or raw conversation dumps.

The current saved record is attached as data when opening/resuming the native manager thread. The read tool retrieves current state during later turns. `/api/state` and the existing single SSE work-state consumer expose it to the renderer; a one-second disk check publishes MCP changes without a new conversation. Prepare/lifecycle responses retain the same scratchpad state. A read failure retains the last good saved content with an explicit stale-data warning, clearing only on recovery. No HTTP write/editor route is added. Existing project identity binding, controller ownership and native configuration/authentication remain authoritative. This is local persistence, not synchronization or a replacement ticket system.

## Validation boundaries

Automated tests cover MCP role separation, four-entry capture contract, revisions, corruption, restart, project isolation, HTTP/SSE refresh, native context hydration, real lifecycle stop/restart, review cadence/replay and admission races. Browser/native UI acceptance uses disposable profiles and synthetic providers/media. Subscription acceptance separately checks model capture, brainstorming and correction across real native chat resume. These tests do not establish physical microphone or human acoustic acceptance, and do not change the user's installed profile, project services or business workers.
