# Prototype validation history

Historical evidence from AI-001 through AI-005. Current setup and limits are in the main README and AI-006 ticket. Historical task IDs are fixture execution records, not business tickets.

# Local voice manager and file-backed worker loop

AI-001 browser speech/barge-in and AI-002 browser voice → real Linear MCP → spoken result **passed by user report**. [AI-004](tickets/AI-004.md) now implements a deterministic local controller plus one isolated worker, durable reports, attention, manager-mediated answers/resume and independently verified completion. The user talks only to the manager.

## Run and test

Requires Node 22+ and the installed macOS ChatGPT bundle. No npm dependencies.

```sh
node server.mjs
```

Open http://127.0.0.1:4317 in one Chrome tab. Refresh an old proof tab to load the updated work-chat UI. Preparing the page checks ChatGPT sign-in and resumes the backing chat; it does not start voice or a model turn. End other voice calls before clicking **Connect voice**.

The controller is ordinary Node code started by `node server.mjs`, not a voice/model polling loop. It runs while the browser and voice are closed. The page shows pending attention; Review with manager is an explicit request for manager reasoning and never opens the microphone. Connect voice only when you choose. The autonomous audit is archived for a clean human acceptance test. Explicitly authorize a new bounded fixture audit to start that test. **Stop manager work** calls `turn/interrupt` for the manager turn, not the detached worker.

**Disconnect** releases the microphone and ends voice. Backend work can continue, with approval requests waiting in the page. Closing the tab/event stream also stops voice; the bridge remains running for the work chat. Ctrl-C stops the controller/manager service but leaves an already dispatched detached worker supervisor running and reporting to files. Restart `node server.mjs` to recover it. This prototype is manually started, not an installed login service. If voice-stop signaling times out, the bridge kills its manager process rather than risk leaving voice running.

## Voice selection (AI-005)

The **Voice** dropdown loads the installed Codex v3 catalog and marks the default (currently Cove). Choose a voice, then **Connect voice** to audition it. The browser remembers your choice. **Disconnect** before changing voices; changing the selection never starts a microphone or restarts a call. If catalog loading fails, Connect stays disabled and **Retry loading voices** is available.

Each successfully connected new call requests a brief greeting in its selected voice: **“Hi, Cove here.”**, for example. A developer startup item instructs the voice to greet immediately and then listen, preserving the normal realtime prompt. The bridge also supplies the brief speakable text through `thread/realtime/appendSpeech` after browser connection confirmation. The startup instruction is necessary: speech append alone was accepted as context but did not produce an opening greeting in actual testing. Session tokens and a synchronous claim prevent duplicate greeting requests; disconnect invalidates the token. SSE reconnect never requests another greeting; the connection-confirmed speech append is not sent for a failed browser connection. No fake user message or backing work turn is created. An actual subscription-backed Juniper connection produced the opening transcript and a non-zero received audio waveform, then answered a locally generated hello with further audio. That test used a generated input stream and muted playback, without accessing a physical microphone. Safari playback and human barge-in still need user acceptance; automatic retries are avoided if delivery is uncertain.

A bounded in-memory call snapshot retains the selected voice, sanitized errors/closure, transcript-event counts, and existing browser track/transport/playback metadata. It contains no audio, SDP, credentials or raw protocol messages, invokes no model polling, and does not affect the call if collection fails. This helps distinguish capture, transport and playback failures without guessing from a connected label or packet count alone.

## Existing Codex mechanisms

The browser negotiates WebRTC through the experimental app-server `thread/realtime/start` method with v3, audio output, `clientManagedHandoffs:false`, and `includeStartupContext:true`. Codex itself routes voice delegations to its existing StartOrSteer execution loop in that same thread and forwards backend responses into voice. This bridge observes progress and results. It never starts turns from transcript/handoff notifications and never re-appends native results. No separate model/tool loop was added. The isolated worker runs the existing `codex exec` harness in its own session/worktree.

The previous proof used client-managed response handoffs and test-only backing instructions. The work chat removes that test-only restriction, uses normal Codex instructions plus a bounded developer instruction, and uses a durable thread. The read-only local sandbox and on-request/user-reviewed approval policy remain. Configured MCP servers and their existing authentication are inherited from Codex. External mutations need the user's actual instruction and normal tool approvals; validation does not mutate tickets.

The page shows actual command/MCP completion events and final Codex messages. Progress stays visual; the bridge does not synthesize extra spoken tool chatter. Command/file approvals, permission requests scoped to a turn, simple MCP tool approval forms, and `requestUserInput` questions use native JSON-RPC responses and explicit page actions. URL MCP verification can be handed to the user. Complex MCP forms and unsupported client capabilities fail closed with an explanation; they require a fuller Codex client. Existing external tool approvals are preserved. Only the new bounded local-state MCP adapter is configured as approved, so writing progress and relaying an already-authorized task do not require repeated prompts. Worker reports are bound to one task/run; this grants no external connector permission.

The saved `.voice-chat.json` is owner-readable and Git-ignored. It records this client's backing thread ID and, after recovery, its previous thread ID and reason. If another Codex runtime holds the saved chat's writer lock, the bridge uses a native history-preserving fork after checking for active work; it retains the original chat, reuses the same worker state and starts no turn. Other preparation errors do not fork. Successful ChatGPT authentication is reported separately from saved-chat preparation errors. Conversation history stays in Codex's normal durable thread store. Reconnects and bridge restarts resume this same chat and load recent backend results. The original AI-001 ephemeral counting conversation is not imported. The narrow `/api/work` JSON endpoint exists for explicit text diagnostics in this same chat; repeated request IDs within the bridge process are idempotent. Voice events never invoke it. Upstream exactly-once handling of duplicated raw realtime delegation events is not claimed.

## Subscription and access boundary

The bridge forces ChatGPT login and the OpenAI provider and removes API-key/base-URL environment variables from its child. It verifies `account/read` returns `chatgpt`. It never reads/exports stored credentials, overrides voice endpoints, or falls back to API-key voice. SDP and raw Codex diagnostics are not logged. Published Desktop voice pricing does not independently guarantee external browser pricing; the observed working path uses the existing Codex ChatGPT authentication.

HTTP binds only to 127.0.0.1, checks Host and Origin, requires same-origin JSON for actions, limits requests, supports one browser controller, and exposes no arbitrary RPC proxy. Transcript text is in the page DOM. Backend history follows normal Codex handling. Microphone mute and audio-player controls are local media controls; they do not implement the deferred push-to-talk or “raise hand before speaking” requirements.

## Verification

- Real installed app-server: ChatGPT Pro authentication and durable chat resume passed.
- Real bounded read-only task in that chat: `codex_apps/linear.get_issue` failed, then `codex_apps/linear.search` completed with a result. Codex returned `SET-6 — Role-based reporting views`. No ticket changes were requested. These are actual backend events, not a simulated answer.
- Mock-process checks: cancelled initialization starts no voice; repeated transcript/handoff notifications start no work; repeated explicit diagnostic request ID starts one turn; invalid approval rejected, decline sent once, replay rejected.
- Browser: the updated page displays the actual tool statuses and final response. A second controller tab is rejected. Earlier AI-001 desktop/mobile layout, microphone denial/retry, delayed-permission cancellation, and page-exit cancellation were checked without real capture.
- Syntax checks passed. A read-only code review identified and fixed cancellation/readiness races. Screenshots and scratch tests remain outside the repository.
- AI-002 voice → real Linear tool → spoken result passed by user report. AI-004 real background file/controller loop passed autonomous checks below. The full clean human manager-worker voice test subsequently passed by user report; automated checks never opened a competing microphone. Production readiness and full connector-form coverage are not claimed.

Installed CLI: `0.163.0-alpha.10.2`. Schemas came from that executable. This is version-sensitive experimental functionality. No Git commit was created; HEAD is unborn.

## File-backed worker loop (AI-004)

The manager uses the local MCP adapter to submit the explicitly agreed brief/ticket to `.orchestration/tasks/<requestId>.json`. A one-second deterministic controller poll sees queued work, prepares a real Git worktree and starts a detached worker supervisor. The worker uses a separate subscription-authenticated `codex exec` session. It writes meaningful progress, questions, blockers and result candidates through a worker-only MCP tool bound to its task/run. No code path invokes another model just to poll status.

Only the manager sees and mediates worker questions. A question closes the worker's report gate and ends that turn. The controller records awaiting-answer and a visible hand. The user chooses when to review/connect voice; the manager relays their answer to the exact question. The controller resumes the SAME Codex worker session in the SAME worktree. The worker is never a direct conversation target for the user. No background update starts a microphone, voice call, or forced speech.

When a result candidate and successful Codex exit arrive, the controller independently checks the real worktree baseline, clean state, successful tool commands and fixture outputs against the structured worker evidence. Dispatch, a successful process exit, or a confident model message alone cannot mark the audit completed. A verified result creates completion attention; the manager explains it when the user requests review.

Files:

- `.orchestration/tasks/<id>.json` is authoritative; `<id>.md` is its readable projection. The agreed brief/ticket are immutable. Reusing an ID with different content is rejected.
- Controller-owned fields: lifecycle, run ID, worktree, runner PID, question, verification, attention. Worker-owned reports are bound to current run ID and stable report IDs. Answers are manager-mediated; acknowledgments do not launch anything.
- `.orchestration/runs/<id>/<runId>/` retains run config (no auth values), supervisor/runtime/exit records, bounded public CLI event metadata and final text. This state is outside the disposable worktree and Git-ignored.
- Atomic renames and owner-private files/locks protect state. Recognizable keys/Bearer/private-key text is rejected (a narrow safeguard, not full DLP). Stale runs, replayed reports/answers and duplicate launch claims fail closed.
- A detached supervisor survives controller restart. A matching started record recovers its PID. A missing supervisor, interrupted launch or exit without the required durable report becomes attention/failure, never an automatic relaunch. A worker run has a five-minute ceiling. Hard-crash stale locks require local inspection; the prototype does not silently break them.

This first worker capability is a **read-only disposable-fixture audit**, not general product execution. AI Manager HEAD is unborn, so no product commit was made: a separate temporary fixture repository contains the audit source and has a real committed baseline/worktree. Linear remains the development-ticket authority; the local execution state is not a second backlog. Production edits, worker cancellation UI, multi-project scheduling, broad ticket UI and later voice controls are outside this slice.

### Human acceptance from a clean start

The previous autonomous task records are archived under `.orchestration/archive/before-human-acceptance-20261020T190432Z/tasks/`; original run evidence and fixture worktrees remain preserved. The current task list was cleared without restarting the server or browser. Manager conversation history is preserved and explicitly marked historical; its prior answer is not authorization for the new test. No new worker has been launched.

1. Open the existing page at http://127.0.0.1:4317 in one tab. It should show no current workers or pending attention. End your other voice call, then click **Connect voice**.
2. Say: **“For ticket AI-004, delegate one new read-only audit of the disposable totals fixture to a separate worker in its own Git worktree. Have it inspect the code, report progress, then pause and ask me whether an empty total should be zero or include a base fee of one. Leave that decision open until I answer. Do not edit anything.”**
3. Wait for the manager to confirm dispatch and the worker panel to show the new task running with its own worker session/worktree. Dispatch alone is not completion. Click **Disconnect** while it works; leave the page open to observe progress. You may also close/reopen the page to check persistence. Do not stop the Node server.
4. The worker should pause with a raised-hand question. Voice stays off. Connect voice when ready and say: **“What does the worker need from me?”** Expected question: should the empty total be **zero**, or include a **base fee of one**? Speak only to the manager.
5. Say: **“Use zero. There is no base fee. Please relay that answer and let the same worker finish.”** The worker should resume in the same session/worktree. You may disconnect again while it checks the code.
6. At completion attention, reconnect and say: **“Explain the verified result and whether any files changed.”** Expected finding: the code starts its total at one; an empty list produces **1 instead of 0**, and `[1,2,3]` produces **7 instead of 6**. The read-only worktree should be clean and the controller should show verification passed. The manager may acknowledge attention after explaining the result.

No automated process answers or reviews this human test. These are expected outcomes, not a claim that live spoken acceptance has passed. If the worker reports a blocker or verification fails, preserve the evidence and report the actual state.

### Actual autonomous end-to-end evidence

Task `e2e-ai004-20261020`, ticket AI-004, was submitted by the real managing Codex chat through its MCP tool, not by a mock model. The manager returned queued status immediately. Worker session `01a15aab-81fb-7e52-ad05-db1fab4701da` inspected real tracked files in its own Git worktree, wrote one progress report and a semantic question, then ended its first turn successfully. Voice was disconnected, and the controller was restarted; the same pending task/session recovered without another launch.

Review with manager produced the actual question. The automated fixture test supplied the answer zero through the manager, which called answer_question. The controller resumed that same worker session in a second run, and the worker ran real Node checks. The controller independently matched `sum([])=1` and `sum([1,2,3])=7` against the worker evidence and expected 0/6, confirmed the initial-value bug and clean worktree, then queued completion. The actual page Review button invoked the manager, which explained the verified finding and acknowledged attention. Voice remained off throughout these autonomous checks.

Assertions passed: one task/worktree, exactly two runs of the same worker session (initial and resume), duplicate task ID causes no new run, stale report rejected, file progress/question/result path, independent verification and manager final acknowledgment. Focused scratch checks also covered racing submissions, report gates, secret-text rejection, malformed state, missing-result failure, runner PID recovery, duplicate supervisor claims and approval validation. Browser desktop/mobile layout, hand/result display and Review action were checked; screenshots are outside the repository under `/tmp/codex-voice-feasibility.tujSgo/`.

## Sources

- [App-server protocol, threads, turns, events and approvals](https://learn.chatgpt.com/docs/app-server)
- [Configuration and voice rollout gates](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Authentication](https://learn.chatgpt.com/docs/auth), [published Desktop voice pricing](https://learn.chatgpt.com/docs/pricing)
- [Native realtime handoff implementation](https://github.com/openai/codex/blob/main/codex-rs/core/src/realtime_conversation.rs)
- [CLI signaling implementation](https://github.com/openai/codex/blob/main/codex-rs/tui/src/app_server_session/realtime.rs)

## AI-009 — Crew 0.4.0

48 automated checks passed. A fresh final-DMG installation opened Crew setup with the chosen artwork and Crew default paths. A live legacy default was blocked safely; after its explicit shutdown, config/profile migration retained the same chat and Viola preference, original JSON backup and old-path aliases. Duplicate launch preserved the controller; close left zero windows and a ready background controller. Explicit custom config stayed byte-identical outside Crew and ran with an independent chat/profile alongside the default. Original browser 4317 remained responsive. No microphone, account reset or new business worker was automated. Full paths/artifact hashes and remaining acceptance boundaries are in AI-009; screenshots remain outside Git.
