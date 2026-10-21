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

Connect voice, reconnect, changing voice and choosing input mode must leave media `calls` at zero. The supported silent RTP source is tracked separately as `silentTracks`/`contexts`, and `peers[].source` distinguishes generated silence from a microphone. During a connected mute the sender may carry generated silence; disconnect must end silent tracks, close their context and close the peer. A closed peer may retain a reference to an ended generated track when microphone input was never started; this is not a live capture resource. Only an explicit Start microphone or held push-to-talk action can increase it. Open-mic Stop, hold release, pointer cancel, key release, blur, disconnect and page closure must stop tracks. Confirm space typed into the message composer does not acquire input. Lower-level voice-input tests cover race branches beyond available browser gestures.

Setup: choose a folder, analyze, inspect actual saved canonical folder/branch/name in `#crew-fixture-evidence` JSON text (read-only DOM inspection) and fixture call log; retain changes across check/save; navigate all six steps and skip microphone. This preload fixture proves renderer behavior only, not the native picker, auth checks or packaged permissions.

Use desktop and narrow screenshots outside the repository, inspect console errors and horizontal overflow, then stop the fixture server and close its tabs. Actual controller readiness and packaged native lifecycle are separate evidence.

An optional third argument selects another compiled assets folder, for example `node tests/browser-fixture.mjs 4343 /tmp/crew-official-theme`, so official-theme builds can be rendered without replacing normal assets.

## Unified conversation (#15)

The fixture now uses the production conversation projection for both typed and spoken messages. JSON POST `/__control` with `protocol: { method, params }` drives canonical synthetic events: `thread/realtime/item/started`, `thread/realtime/item/transcript/delta`, `thread/realtime/item/completed`, ordinary `item/started` / `item/completed`, `item/agentMessage/delta`, and `thread/realtime/closed`. Use actual generated protocol shapes: a transcript item has `id`, `type: "transcriptSegment"`, `realtimeSessionId`, `role` and `text`; a delta has `itemId` and `delta`. Final text replaces its same-ID partial. Repeating a final item cannot add another message. The flat `event` transcript controls remain supported as a distinct older-protocol fixture path; don't mix both paths as if they were independent speech.

Verify all messages occur under `#work-result` using the same message component; there is no separate voice transcript section. Interleave typed pairs and spoken segments, verify stable DOM identity during deltas/final, draft retention, identical text with distinct IDs, partial close, native promotion by referenced ID, SSE reconnect and full browser reload. `/__state` retains synthetic history for reload, while actual bridge recreation and disk persistence are covered by subprocess protocol tests.

For the current open-mic default, explicit Connect requests **synthetic** capture once connected. Initial mount requests none; mute/end releases it. Connect/end/reconnect must retain every conversation row. The older no-capture-on-connect wording above is historical and superseded by AI-016. No physical media APIs are used by this fixture.
