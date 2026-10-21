# Crew renderer acceptance fixture

`npm run renderer:build`, then `node tests/browser-fixture.mjs 4342` serves the **real compiled renderer** with a deliberately synthetic backend and microphone/WebRTC implementation. Open `http://127.0.0.1:4342/` using CUA. Setup is `/setup.html`. Rebuild then reload to test new renderer code; this fixture is not a real Crew controller and does not enforce the controller's asset-pinning policy.

No Codex calls, credentials, native permission request, microphone, worker process, Git worktree or Linear ticket is created. Do not describe fixture rendering as real execution, real ticket access or acoustic acceptance. All statuses and timestamps here are synthetic. Fixture scripts are not included in renderer or desktop output.

Read evidence with `curl -s http://127.0.0.1:4342/__proof`. It contains exact manager request bodies and media resources. Setup call/state evidence is in the test-only `#crew-fixture-evidence` JSON element because the genuine setup CSP intentionally forbids network calls. `/__state` returns current synthetic work and orchestration state. Commands use JSON POST `/__control`:

- `{"work":{"status":"working","activeTurnId":"fixture-turn","approvals":[{"id":"fixture-input","method":"item/tool/requestUserInput","params":{"questions":[{"id":"scope","question":"Include archived records?"}]}}]}}` displays a manager question. Fill it, repeat a work-state update, ensure input survives, submit and inspect exact `/api/approval` body.
- `{"work":{"approvals":[{"id":"fixture-command","method":"item/commandExecution/requestApproval","params":{"reason":"Synthetic harmless command approval","command":"echo fixture","availableDecisions":["accept","decline"]}}]}}` displays explicit approval. Verify Allow once and Decline remain distinct.
- `{"event":{"type":"transcript-done","role":"assistant","text":"Synthetic voice transcript."}}` exercises realtime transcript display without triggering a manager request.
- `{"media":{"delayed":true}}`, then explicitly start/hold input and release or disconnect before `{"media":{"resolve":true,"delayed":false}}`: the resolved track must end without transmission. The server observes synthetic tracks through `/__proof`.
- `{"media":{"denyNext":true}}` makes the next explicit input gesture fail permission, with no real OS request. Retry after the denial must be possible.
- `{"media":{"voiceEvent":"output_audio_buffer.started"}}` and `{"media":{"voiceEvent":"output_audio_buffer.stopped"}}` exercise speaking/ready from actual event names.
- `{"media":{"reconnectEvent":true}}` repeats connection callback to ensure one greeting request per connection.
- `{"dropEvents":true}` drops the manager SSE; active microphone must stop. EventSource may reconnect automatically; reconnection must not restart capture.
- `{"orchestration":{"maxConcurrent":6,"tasks":[]}}` exercises the empty state. Capture `/__state` first if restoring initial workers later.

Inspect all six ongoing workers, the completed worker with pending review, and expandable history. Task IDs are `fixture-task-1` through `fixture-task-10`; question attention is `question-2`, completed-result attention is `result-7`. Review must send exactly its task+attention pair. Lifecycle requests must mention only the selected task and use the normal manager endpoint, never direct worker conversations. Ticket titles/status are unavailable in the durable controller contract and must not be invented.

Opening the renderer and changing voice/input mode must leave media `calls` at zero. Explicit Connect in default open-mic mode starts exactly one synthetic capture after connection; reconnect events must never restart capture or override mute. Connect in push-to-talk mode leaves capture off until a hold gesture. The supported silent RTP source is tracked separately as `silentTracks`/`contexts`, and `peers[].source` distinguishes generated silence from a microphone. During a connected mute the sender may carry generated silence; disconnect must end silent tracks, close their context and close the peer. A closed peer may retain a reference to an ended generated track when microphone input was never started; this is not a live capture resource. Explicit Connect/unmute in open-mic mode or a held push-to-talk action can increase it. Open-mic mute, PTT hold release, pointer cancel/key release, disconnect and page closure must stop tracks. Ordinary blur retains open-mic capture and releases PTT capture only. Confirm space typed into the message composer does not acquire input. Lower-level voice-input tests cover race branches beyond available browser gestures.

Setup: choose a folder, analyze, inspect actual saved canonical folder/branch/name in `#crew-fixture-evidence` JSON text (read-only DOM inspection) and fixture call log; retain changes across check/save; navigate all six steps and skip microphone. This preload fixture proves renderer behavior only, not the native picker, auth checks or packaged permissions.

Use desktop and narrow screenshots outside the repository, inspect console errors and horizontal overflow, then stop the fixture server and close its tabs. Actual controller readiness and packaged native lifecycle are separate evidence.

An optional third argument selects another compiled assets folder, for example `node tests/browser-fixture.mjs 4343 /tmp/crew-official-theme`, so official-theme builds can be rendered without replacing normal assets.

## Sound acceptance (GitHub #8)

The fixture records synthesized output tone frequency/start scheduling as `media.tones` in `/__proof`. Connected is 523/784 Hz; ended is 659/440; muted is 440/330; unmuted is 330/440; attention is 880/1175. This is scheduling evidence only, not human acoustic acceptance. No physical media is acquired.

After interacting with the window to unlock audio, inject a new native input/approval, explicit successful tool item's `attention: {id,message}`, or current unanswered worker question. Each new identity sounds once; replay, answered/stale questions, ordinary completion/failure and messages stay quiet. `{"nativeAttentionSound":true}` through `/__control`, then reload, simulates a native owner: the renderer must suppress attention while retaining call cues. Restore false and reload for standalone browser acceptance.

## Worker overview/detail and project call lifetime (GitHub #14)

After building, run `node scripts/worker-overview-browser-acceptance.mjs`. Set `CREW_PLAYWRIGHT_MODULE` to an absolute Playwright module path when it is installed outside local `node_modules`, and optionally `CREW_BROWSER_EXECUTABLE` to an existing Chromium-family executable. The runner owns and cleans its synthetic fixture server/browser and writes screenshots to a temporary directory outside Git.

It checks ten correlated compact cards, a full-area read-only worker detail, actual fixture conversation history, refreshed history/Markdown, resource URLs, exact task/attention Review and task/run lifecycle requests through the manager, retained manager draft, call/microphone identity through project navigation and global Settings, mute/unmute/end, denied-microphone guidance, compact Text/Voice switching, typing without implicit unmute, open-mic blur preservation and muted Settings persistence, native-minimum 540×500 compose/send/call reachability and narrow-screen overflow. These checks establish renderer behavior with synthetic media, not native microphone permission, acoustic acceptance, real worker execution or cross-project native switching.

`GET /api/workers/fixture-task-1` returns correlated synthetic detail. POST `/__control` with `{"workerDetail":{"taskId":"fixture-task-1","notes":{"exists":true,"markdown":"# Updated notes","path":"/tmp/crew-fixture/w1/WORK-NOTES.md","updatedAt":"2026-10-21T12:00:00Z","source":"Task-owned shared Markdown"}}}` changes the read-only source and emits a refresh. The fixture links are explicitly synthetic examples; no external link is visited or mutated. Other task details deliberately have no shared document or links, so unavailable states can be verified.

## Unified conversation (#15)

The fixture now uses the production conversation projection for both typed and spoken messages. JSON POST `/__control` with `protocol: { method, params }` drives canonical synthetic events: `thread/realtime/item/started`, `thread/realtime/item/transcript/delta`, `thread/realtime/item/completed`, ordinary `item/started` / `item/completed`, `item/agentMessage/delta`, and `thread/realtime/closed`. Use actual generated protocol shapes: a transcript item has `id`, `type: "transcriptSegment"`, `realtimeSessionId`, `role` and `text`; a delta has `itemId` and `delta`. Final text replaces its same-ID partial. Repeating a final item cannot add another message. The flat `event` transcript controls remain supported as a distinct older-protocol fixture path; don't mix both paths as if they were independent speech.

Verify all messages occur under `#work-result` using the same message component; there is no separate voice transcript section. Interleave typed pairs and spoken segments, verify stable DOM identity during deltas/final, draft retention, identical text with distinct IDs, partial close, native promotion by referenced ID, SSE reconnect and full browser reload. `/__state` retains synthetic history for reload, while actual bridge recreation and disk persistence are covered by subprocess protocol tests.

For the current open-mic default, explicit Connect requests **synthetic** capture once connected. Initial mount requests none; mute/end releases it. Connect/end/reconnect must retain every conversation row. The older no-capture-on-connect wording above is historical and superseded by AI-016. No physical media APIs are used by this fixture.

## Chat scroll regression (GitHub #32)

Build the renderer, then run `node scripts/chat-scroll-browser-acceptance.mjs` with the same optional `CREW_PLAYWRIGHT_MODULE` and `CREW_BROWSER_EXECUTABLE` settings. The disposable fixture uses port 4348 by default (`CREW_ACCEPTANCE_PORT` overrides it). A long saved transcript must open at the bottom, retain the exact reading position through repeated refreshes/new user rows/streamed replies, and follow streamed growth only at the bottom. A small deliberate scroll away stops following; Jump to latest resumes it. Completion and Text/Voice composer height changes must retain bottom following. Screenshots are written to a private temporary directory outside the repository. No model, worker or microphone is used.
