# Native Codex adapter — Crew #88

The unified foundation calls `createCodexAgentRuntime` from
[`src/agents/codex-runtime.mts`](../src/agents/codex-runtime.mts). The adapter implements the
canonical [shared contract](AGENT-CONTRACTS.md); it does not launch legacy manager or worker
paths. [Issue #88](https://github.com/MattGibney/Crew/issues/88) owns this implementation and
[parent #86](https://github.com/MattGibney/Crew/issues/86) owns combined acceptance.

## Trusted composition with #89

Construction requires a `CodexLaunchResolver`. There is deliberately no default resolver, binary
discovery, ambient environment copy, personal configuration fallback, credential lookup or sign-in
implementation. The resolver receives the exact `RuntimeStartInput`, including `RuntimeAccessBinding`,
configuration snapshot and opaque subscription reference, and returns either a blocked error or:

```ts
{
  state: "ready",
  launch: {
    executable: "/absolute/trusted/runtime",
    args: [/* trusted isolation launcher arguments and app-server stdio arguments */],
    cwd: "/absolute/isolated/workspace",
    env: { /* the complete environment; never merged with process.env */ },
  },
  skills: [/* { id, revision, nativePath: "/isolated/path/SKILL.md" } */],
}
```

This is a private trusted-process seam, never an agent-configurable executable or environment.
#89 must resolve the opaque references, enforce the actual filesystem/process/network/configuration,
OS credential and personal-tool boundaries, and preserve supported native approvals. A declaration
that isolation is ready is not proof. The adapter validates exact caller identity, selected skill
revision bindings and native discovery of those paths. It checks `account/read` for `chatgpt`
authentication and rejects an API-key environment; it does not read or copy authentication files.
Native skill discovery proves availability, not sandbox isolation. No service credential belongs in
this launch, messages, profiles or history projection.

Optional `resolveAttachment` maps an authorized image/file artifact reference to a supported native
image/file-ID, local-image or mention input. Without that resolver, attachment delivery returns
`not_sent/unsupported`; opaque references are never assumed to be arbitrary filesystem paths.
Optional `lookupSender` resolves a native client-message ID against compact durable Crew receipts.
Use exported `codexClientMessageId(binding, attemptId)` to construct that identity; never infer the
sender from wording, adjacency or native `user` role.

## Session and profile behavior

Start initializes one explicitly owned stdio app-server, verifies subscription authentication and
opens or resumes the exact requested thread. For a new thread, it sets the native thread name from
its saved agent name (or agent ID) with `thread/name/set` and verifies that name using `thread/read`.
This supported metadata operation materializes an otherwise unused persistent thread in the
inspected runtime, allowing an idle Start → Stop → Start on the same ID. It never calls `turn/start`,
generates a greeting, executes setup or submits synthetic user input. A missing resumed thread
remains missing; naming is never used to replace an established conversation.

Profile instructions, optional name and personality are applied through native
`thread/settings/update` → `thread/settings/updated` using
`collaborationMode.settings.developer_instructions`. New threads use Codex's default collaboration
mode and its returned model/effort. Resumed threads must expose their effective `collaborationMode`;
the adapter preserves that mode/model/effort and refuses to infer missing state. The exact instruction
bytes must be present in the correlated effective-settings event before the revision is acknowledged.
If resume already returns the exact instruction bytes, that native readback is the acknowledgement.
No-op settings updates are not a settings-read operation: this runtime emits no event for them.

This proves native configuration acceptance. It is not a claim that a materialized conversation's
next model response has been behaviorally accepted. Saved profiles need an explicit restart;
calling Start again on an already started logical session returns its existing applied snapshot.
Native provider instructions and execution policy remain independent.

Stop blocks new adapter sends, cooperatively interrupts only the exact active native turn when
needed, waits for its terminal notification, checks unresolved native requests and fresh native idle
state, closes stdin and waits for the owned process's exit. It never signals process groups, kills
service descendants, tears down an environment or answers approvals. Lost ownership/unknown state
remains a failure. A confirmed idle failed-start cleanup retains a compact stop acknowledgement so
the foundation can close the logical session without inventing a second process. Startup events are
buffered until observation begins; an overrun blocks rather than silently losing startup state.

The production composition supplies `onProcessStarted(caller, pid)` to record each owned launch
before the adapter sends `initialize` or any thread request. Missing PIDs or failed recording block
native dispatch. `NativeProcessRegistry` stores immutable caller/PID/time records as owner-private,
fsynced JSON, with the existing process-owned state lock protecting publication. A different PID
cannot replace an existing logical session's record.

After controller recovery, `confirmExited(caller)` reports success only when a durably recorded
launch PID returns OS `ESRCH` from the signal-zero existence probe. It delivers no signal. Live PIDs
(including reused PIDs), permission errors, missing records and unsafe/malformed files stay blocked.
This confirms absence of the owned native launch only; it does not establish descendant exit or
stop environments. If the controller crashes before recording, no native request has been sent,
but missing evidence is still not converted into an exit confirmation. The foundation owns the
explicit recovery action and its session/permission changes.

## Messages, native history and approvals

Each delivery uses native `clientUserMessageId` derived from the exact logical session, thread and
attempt. Crew's authenticated sender and optional job/reply identity are application context,
separate from the native user-role body. A queue delivery requires native idle state; active steering
uses `turn/steer` and its mandatory `expectedTurnId`. Native turn acknowledgement is acceptance,
not completion. Delayed completion cannot clear a different newer turn. Reusing a live attempt with
changed input is rejected.

Timeout/disconnect and ambiguous native errors retain uncertainty. Reconciliation searches at most
20 native history pages for the exact client ID or an already known native item reference. It never
uses matching text or interprets missing history as proof of non-delivery. No uncertain input is
automatically repeated. The foundation owns durable pending bodies/attempts and compact receipts;
the adapter stores no permanent parallel conversation.

History uses `thread/turns/list` with full items and an opaque cursor. The first page contains recent
turns; items inside each page are chronological. Prepend subsequent pages to show older history.
The exact native unmaterialized-empty-thread error is empty history only for a known live thread
with no observed items, never for an unavailable/stopped session. Assistant deltas use
`metadata.update: "delta"`; started/completed items are snapshots. Consumer overflow closes that
observation and requires rehydration. Reasoning and hook-prompt items are omitted. Tool projection
retains type/status/timing and names, but does not copy tool arguments/results or credentials.
Uncorrelated native user input stays `unattributed_native`.

`readHistory` uses the live owned transport when available. Stopped and controller-recovered
history uses the optional trusted hook:

```ts
resolveHistoryLaunch(binding: RuntimeBinding): Promise<
  | { state: "ready"; launch: CodexLaunch }
  | { state: "blocked"; error: RuntimeError }
>
```

The composition must validate the retained project/agent/thread reference and resolve its isolated
native storage. An expired session bearer must not be reused. The adapter launches a separate
read-only peer, initializes it, verifies the exact ID with `thread/read`, pages `thread/turns/list`
and closes the owned process. It never resumes a thread, starts a turn, signs in, changes settings
or answers an approval. An unconfirmed reader exit is an explicit failure, never a force-stop.
Absent storage, unsupported methods and missing resolver remain errors rather than empty history.
Native history continues to own all messages; this path creates no transcript copy. Delivery
reconciliation can use the same stopped read path to find exact persisted IDs without replaying
uncertain messages.

Native server requests retain exact session/thread/turn/request identity. Raw request parameters
remain only in the adapter's process memory. Exported `projectCodexApproval` is the bounded,
allowlisted display/persistence projection: it copies only reviewed command/cwd/reason or bounded
non-secret user-question fields. Unsupported requests expose method metadata and an unavailable
message only; MCP/OAuth URLs, authentication state, configuration and unknown payload structures
never enter the durable approval event. Display strings with known credential markers, URLs,
control characters or excessive length are withheld. This is a narrow protocol projection, not a
general-purpose secret detector.

Simple command approvals require complete safe command and cwd fields, no unsupported additional
permissions/network scope, and respect `availableDecisions` when supplied. Withheld or incomplete
scope removes positive choices in both the UI projection and response validator. Native denial and
cancellation remain available when supported. File requests alone do not contain a reviewable patch,
and this adapter deliberately omits raw file diffs, so they currently offer denial/cancellation only.
Secret or incompletely projected user-input questions cannot receive answers through this adapter.
The owner must choose a response. Sending it is not acknowledgement: the adapter waits for the
matching `serverRequest/resolved` notification and never retries an uncertain response. That event
also emits an approval history update with `{ approvalId, state: "resolved" }`, allowing the durable
foundation to remove a request resolved or cancelled by native Codex itself.

The current response UI/validator does not support exec-policy amendments, permission-profile
grants or MCP/OAuth elicitation. These requests remain visible and unanswered rather than being
silently denied or approved. A request without a supported native turn identity blocks with an
explicit unsupported-state observation; it is not attributed to an invented turn. Native
`item/tool/requestUserInput` answer records are supported through the adapter; composing that form
is a UI concern. A Crew service grant never substitutes for a native approval.

## Explicit same-thread voice control

The concrete `CodexAgentRuntime` implements `CodexRealtimePort`, exported from
`codex-runtime.mts`. The foundation's generic adapter contract is unchanged. The application
binds owner authentication and the primary agent before calling:

- `listRealtimeVoices(binding)` reads the native v3 catalogue on an already started session.
- `connectRealtime(binding, { transport, voice? })` accepts a WebRTC SDP offer or native websocket
  transport. It returns the selected voice, a call-specific `voiceSessionId`, the native realtime
  session reference and the SDP answer when relevant.
- `appendRealtimeAudio(binding, voiceSessionId, audio)` accepts bounded native audio chunks only
  for the exact active websocket call. WebRTC media stays with the browser transport.
- `disconnectRealtime(binding, voiceSessionId)` waits for native closure; a stale call ID cannot
  disconnect a later call.
- `realtimeStatus(binding)` exposes closed/connecting/active/stopping/uncertain native state for
  shared execution admission. `subscribeRealtime(listener)` observes typed transient events.

These controls do not start an agent, connect automatically, acquire a microphone, or append a
synthetic greeting or user utterance. Start requires the existing native thread/session and uses its
acknowledged editable profile. `clientManagedHandoffs` stays false. Transcripts and native promoted
items never invoke `turn/start`, `turn/steer`, `appendText` or `appendSpeech`. The renderer owns
microphone permission, mute intent, track lifetime and audio playback. Repeated native started
notifications do not generate another startup request.

Native `bemItemPromoted` notifications produce a deduplicated `handoff` event containing the actual
native realtime session, turn and item identities. The composition may use those exact references
for public history correlation; overlapping ordinary turn events are not evidence of voice origin.
Transcript deltas/final snapshots are transient display events, not a second persisted Crew chat.
Unknown raw realtime payloads are not forwarded. Native history methods that omit realtime-only
transcript segments remain an explicit display limitation rather than permission to mirror them.

Connect and disconnect retain one outstanding call per owned peer. An ambiguous start or close
remains uncertain and prevents reconnect until closure is confirmed. Audio acknowledgement failure
never retries the chunk. Agent Stop first closes its native voice call cooperatively, then applies
the existing native-turn/approval/exit checks; it does not kill independent work or resources.
The host must include connecting/active/stopping/uncertain voice in final Quit/update admission.

## Installed-runtime evidence and limits

Inspection on 22 October 2026 used the installed `codex-cli 0.163.0-alpha.11` bundled with the
ChatGPT desktop app. Its `app-server generate-ts --experimental` output was generated only in a
temporary directory. The protocol definitions, actual stdio responses and current
[official app-server documentation](https://learn.chatgpt.com/docs/app-server) were compared.

A bounded native probe used a disposable HOME, CODEX_HOME, workspace and file credential-store
setting, with no sign-in, credentials, personal configuration or model turn. It observed:

- `thread/start` succeeded with native idle status and zero turn events.
- A changed settings call emitted the exact instruction text in the same thread's
  `thread/settings/updated` event; a no-op settings call emitted no such event.
- `thread/read` observed the same live idle thread.
- Initially, `thread/resume` immediately returned `-32600: no rollout found for thread id …` for
  a new unnamed idle thread. The later bounded naming probe below resolves this specific case with
  a native metadata operation, without a message or replacement thread.
- Both `thread/timeline/list` and `thread/items/list`, although present in generated types, returned
  `-32601` and “not supported yet”. The adapter uses turn pagination. Before the first message,
  `thread/turns/list` returned the specific native unmaterialized-thread error.
- Native unsubscribe and process exit completed; disposable state was removed after exit.

A follow-on native probe on the same installed version used another disposable HOME/CODEX_HOME
and no sign-in or model request. It observed `thread/name/set` and exact name readback after idle
`thread/start`, acknowledged profile instruction revision one, then confirmed process exit. A new
app-server read the same thread as `notLoaded` and returned empty turn pagination without resuming
it. Explicit `thread/resume` then returned that same ID and revision-one instructions; a second
settings update emitted exact revision-two instructions. Both owned processes exited, and the
entire flow had zero turn events. This establishes unused-thread persistence and read-only native
history mechanics, not subscription inference, credential isolation or model behavior.

The updated adapter itself then read that stopped native thread using the trusted history resolver,
returned its native empty history, rejected a foreign thread binding, and kept an absent delivery
receipt uncertain without a replay. Current `tsc -p tsconfig.json --noEmit` and diff validation passed.
The reader's launch resolver was scoped to the disposable thread; its execution resolver remained
blocked, so this acceptance could not start a model session. No new permanent tests were added.

A further disposable real-process check verified that live recorded PIDs block, absent recorded
PIDs confirm exit after reopening the registry, and missing/malformed evidence and replacement
PIDs are refused. A synthetic stdin peer verified that a rejected `onProcessStarted` callback
closes the owned process without sending any native request. This checks durable recovery
mechanics, not an installed-app crash/reopen flow. Type checking passed after these changes.

The installed no-auth runtime returned 25 v3 voices from `thread/realtime/listVoices` with zero
realtime connections and zero turns. A separate synthetic protocol peer exercised the concrete
adapter's WebRTC negotiation, selected voice, websocket synthetic audio append/output, stale-call
rejection, deduplicated native promotion, same-thread routing and cooperative voice closure during
Agent Stop. No synthetic/user text was sent and no turn was started by those controls. Type
checking passed. This is catalogue/protocol evidence, not subscription-backed voice generation,
real WebRTC media, human acoustic acceptance or physical-microphone testing.

Earlier focused validation: `npx tsc -p tsconfig.json --noEmit` passed. A separate short disposable **synthetic transport** flow
passed idle start, exact profile event acknowledgement, enumerated approval validation/resolution,
queue/steer correlation, lost-ack history reconciliation, sender attribution, interruption/exit and
same-thread profile restart. This exercised adapter control flow, not subscription inference or
native business-tool execution. No test files were added and no full regression suite was run.

Materialized same-thread profile behavior, genuine active-turn steering/approval execution, full
native history pagination after model work, selected skill execution, credential isolation, gateway
operations and packaged application integration remain combined acceptance work. The resolver seam
does not by itself make those capabilities ready. No personal profile/install, physical microphone,
business service or repository worktree was modified by the native probe.


## Installed-runtime resume restriction discovered during composition

The installed 0.163.0-alpha.11 accepts `environments: []` on thread/start and
turn/start. Its ThreadResumeParams has no environment selection field. A real
fresh-process resume of an unused named native thread restores a local environment,
even if an unknown `environments: []` field is supplied. Same-process resume alone
missed this difference. The adapter now requires the loaded thread's environment
selection to be exactly empty and blocks otherwise, retaining the same chat ID.
It never invents input or creates a replacement chat to conceal the limitation.

Selected project skills are exposed through supported `skills/extraRoots/set`
before skills/list; exact SKILL.md parent directories are acknowledged in an
unsigned-in native probe. No signed-in model turn or resumed voice inference has
yet established the complete isolation/continuity milestone. The new restriction
is an isolation-verification blocker for this implementation in addition to owner
subscription sign-in. Restored environment metadata alone is not an observation of
model filesystem-tool use. Explicit text turns support an override; server-managed
realtime handoffs do not pass through Crew's turn/start call, and effective tool
exposure for that resumed route remains unverified.

A bounded follow-up found that the same installed runtime supports named permission
profiles on thread/resume. A fresh native process resumed the same unused named chat
with the selected profile. A standalone `command/exec` using that profile read an
allowed synthetic workspace file and received `Operation not permitted` for a
synthetic private-state file; the read-only baseline could read that private file.
Both native processes exited normally and no model turn occurred. This establishes
profile selection and command-sandbox enforcement only. `command/exec` is standalone
and has no thread identity, so it does not establish that server-created realtime
handoffs inherit the profile or that every model-accessible filesystem tool enforces
its deny rules. The current provider's outer OS policy allows the native process
access to its own private runtime root; that policy alone does not exclude that root
from native tool descendants. Full resumed handoff isolation remains unresolved,
and this probe did not change the production launch policy or relax its hold.

The final bounded composition probe ran that same sequence under Crew's actual
`nativeSeatbeltPolicy` (a fresh synthetic root and no allowed network ports). Idle
thread creation and naming succeeded. After confirmed process exit, same-chat
resume with the named profile failed before any turn while loading local
environment instructions: `fs sandbox helper failed with status exit status: 71:
sandbox-exec: sandbox_apply: Operation not permitted`. Both native processes exited
normally. The previous standalone profile result therefore cannot be promoted to
evidence that the profile composes with Crew's outer OS boundary.

Disposition: no usable full same-chat resume/realtime route has been established
with the current pair of boundaries. The observed failure is specific to this
installed runtime and Crew outer policy, not proof that macOS or the native runtime
cannot support a different configuration. Removing the outer boundary or granting
unrestricted native execution would discard the existing containment claim and was
not attempted. Owner sign-in alone cannot repair this local pre-turn failure.
After resolving boundary composition, effective permission enforcement in a real
server-created handoff still needs its own bounded synthetic-private-file check;
selection metadata and standalone command execution are insufficient evidence.
