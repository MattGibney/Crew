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

Mount, changing voice and choosing input mode must leave media `calls` at zero. Explicit Connect authorizes one open-microphone capture after connection; with push-to-talk selected or retained mute intent it leaves `calls` unchanged. Repeated connected events must never recapture. The supported silent RTP source is tracked separately as `silentTracks`/`contexts`, and `peers[].source` distinguishes generated silence from a microphone. During a connected mute the sender may carry generated silence; disconnect must end silent tracks, close their context and close the peer. A closed peer may retain a reference to an ended generated track when microphone input was never started; this is not a live capture resource. Explicit Connect in unmuted open-microphone mode, explicit unmute, or a held push-to-talk action can increase it. Open-mic Stop, hold release, pointer cancel, key release, blur, disconnect and page closure must stop tracks. Confirm space typed into the message composer does not acquire input. Lower-level voice-input tests cover race branches beyond available browser gestures.

Setup: choose a folder, analyze, inspect actual saved canonical folder/branch/name in `#crew-fixture-evidence` JSON text (read-only DOM inspection) and fixture call log; retain changes across check/save; navigate all six steps and skip microphone. This preload fixture proves renderer behavior only, not the native picker, auth checks or packaged permissions.

Use desktop and narrow screenshots outside the repository, inspect console errors and horizontal overflow, then stop the fixture server and close its tabs. Actual controller readiness and packaged native lifecycle are separate evidence.

An optional third argument selects another compiled assets folder, for example `node tests/browser-fixture.mjs 4343 /tmp/crew-official-theme`, so official-theme builds can be rendered without replacing normal assets.

## Sound acceptance (GitHub #8)

The fixture records synthesized output tone frequency/start scheduling as `media.tones` in `/__proof`. Connected is 523/784 Hz; ended is 659/440; muted is 440/330; unmuted is 330/440; attention is 880/1175. This is scheduling evidence only, not human acoustic acceptance. No physical media is acquired.

After interacting with the window to unlock audio, inject a new native input/approval, explicit successful tool item's `attention: {id,message}`, or current unanswered worker question. Each new identity sounds once; replay, answered/stale questions, ordinary completion/failure and messages stay quiet. `{"nativeAttentionSound":true}` through `/__control`, then reload, simulates a native owner: the renderer must suppress attention while retaining call cues. Restore false and reload for standalone browser acceptance.
