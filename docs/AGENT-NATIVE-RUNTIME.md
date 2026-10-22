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
  nativePermissions: { profileId: "provider-owned-profile", approvalPolicy: "never" },
}
```

This is a private trusted-process seam, never an agent-configurable executable or environment.
The policy field is optional in the TypeScript shape for staged provider integration, but absence
or invalid metadata blocks before native spawn. There is no legacy fallback.
#89 must resolve opaque references and enforce the native model-tool filesystem/network/configuration
boundary. The pinned native host is trusted to read its Crew model auth. Host-control RPCs must not
be exposed as model tools; the adapter never reads or copies auth values. A declaration
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

Profile instructions, optional name and personality are sent through the supported direct
`developerInstructions` field on `thread/start` and `thread/resume`. Creation was behaviorally
verified; changed instructions on retained chats use the explicitly requested Restart preparation
described below. Native configuration is also acknowledged through
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


## Historical resume restriction discovered during composition

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

The final minimal OS controls narrowed this further without running Codex or
reading real private files. An inert outer `(allow default)` profile allowed a
second sandbox. Adding only a deny-read rule for one synthetic private directory
correctly blocked its canary read, allowed a single `/usr/bin/true`, and made a
second sandbox around `/usr/bin/true` fail with exit 71 and the same error. The
installed Apple SDK's `sandbox.h` documents that `sandbox_init` errors when the
process is already sandboxed. No supported narrow permission addition has been
established that lets this restrictive outer Seatbelt policy coexist with the
native runtime's own sandbox initialization. Loosening unrelated path allowances
is not a supported repair.

The smallest alternative is an explicit trust-boundary change: run the pinned
app-server as a trusted host process and let native named permissions be the sole
model-tool sandbox, with exact deny rules for Crew private state and personal
credential roots and no escalation beyond those rules. This is a candidate, not
accepted isolation: complete model-tool coverage and a server-created handoff
must be verified after owner sign-in before removing the current hold. It drops
the claim that Crew's outer OS policy confines the app-server itself. If that
process-wide guarantee is required, a separate OS isolation layer, such as an
isolated runtime VM with no personal-file mounts, is needed instead of nesting
Seatbelt. Neither alternative was implemented or authorized by this investigation;
no install, account, credentials, native launch policy or production access changed.

## Historical disposable native-owned permission investigation

A subsequent owner-directed investigation tested the native boundary on its own,
without changing production launch code. It used a separate synthetic HOME and
CODEX_HOME, synthetic Crew/auth/vault roots and a synthetic credential file outside
the main fixture. No personal files or real credentials were read or copied.

The filesystem rules below were verified across resume; environment inheritance
was checked separately with the same profile and the explicit `inherit` setting:

```toml
default_permissions = "crew-probe"
cli_auth_credentials_store = "file"
forced_login_method = "chatgpt"
approval_policy = "never"
allow_login_shell = false
shell_environment_policy.inherit = "none"

[permissions.crew-probe]
extends = ":read-only"

[permissions.crew-probe.filesystem]
":root" = "deny"
":minimal" = "read"
"/synthetic-fixture" = "deny"
"/synthetic-fixture/workspace" = "read"
```

The literal fixture paths above stand for canonical disposable paths. The thread
was created and named without model input, its process exited, and a fresh process
resumed the same ID using `permissions: "crew-probe"`; the selected profile was
returned. The filesystem/execution matrix and separate environment check produced
these results:

| Surface | Observed result |
| --- | --- |
| `command/exec`, selected or configured default profile | Allowed workspace read; denied synthetic Crew, auth, vault and outside credential reads. |
| `command/exec` with `shell_environment_policy.inherit="none"` | Neither the synthetic transport-token nor personal-token environment canary reached the process. |
| Host `fs/readFile`, `fs/readDirectory`, `fs/getMetadata` | Could read or inspect denied fixture paths; these RPCs are not governed by the command profile. |
| Host `fs/writeFile`, `fs/copy` | Mutated/copied the synthetic private data; resulting bytes were checked. |
| Host `process/spawn`, `thread/shellCommand` | Could read the private canary, consistent with their explicit unsandboxed host-control contract. |

The host read of the synthetic auth marker demonstrates that the native process
retains file access while sandboxed commands do not. It does not prove a valid
subscription session: the malformed marker produced no account, while an earlier
token-shaped synthetic fixture triggered an unauthorized workspace-routing check.
Only genuine owner sign-in can establish working model authentication. No model
inference was invoked. The explicit host shell command did create a user-shell
turn and corresponding native events, so this matrix is not a zero-turn fixture.

Installed protocol inspection also covers host watchers/search, Git diffs,
configuration/skill/plugin readers and native history readers. Those host methods
are not a model-tool inventory. There is no complete effective model-tool catalogue
or no-model client invocation for native `apply_patch`, image viewing or possible
dedicated file/search tools in this generated API. MCP and connector inventories
cover only their own surfaces. Their presence, absence or host-RPC behavior cannot
prove complete model exposure or denial.

Disposition: this is a concrete candidate command policy and a verified separation
between trusted host controls and sandboxed execution, not accepted full model
isolation. Keep host filesystem/process/shell RPCs out of agent-facing tools.
After owner sign-in, the remaining bounded acceptance is to exercise the available
native model file/command/edit/image surfaces against synthetic protected markers,
then stop, resume the same chat in a fresh process and trigger one server-managed
realtime handoff with synthetic media. Confirm denied markers, allowed workspace
work, unchanged selected policy, exact handoff identity and no credential canaries
in tool environments. Do not probe real auth values. Production restrictions stay
unchanged until that evidence and the trust-boundary choice are accepted.

## Owner-confirmed boundary and real-model acceptance

The owner has since clarified the intended product boundary: the pinned native
app-server is trusted to access its own Crew model authentication. Model tools
must not read Crew vault or personal-service credentials, or bypass owner-approved
tools and workspaces. A VM or process-wide protection against that trusted native
host is not a product requirement. The earlier discussion of that stronger
guarantee is historical investigation, not an outstanding owner decision.

The candidate therefore retains Crew-only HOME/config, existing authentication in
place, current session authorization and broker-only production tool exposure.
Native named filesystem/network permissions would replace the incompatible outer
Seatbelt layer for model tools. Host filesystem, process and shell RPCs remain
trusted adapter controls and must never become agent-facing tools. Native profile
selection and verification must cover thread creation, fresh-process same-chat
resume, explicit turns and server-managed realtime handoffs.

The owner authorized candidate implementation while acceptance continued. The adapter now binds
`permissions` and `approvalPolicy: "never"` on start, resume and explicit turns. It verifies the
returned profile, approval policy, cwd/root list and exactly one local environment. A settings or
workspace mismatch latches a configuration rejection and blocks later text/realtime input. The
foundation keeps the exact session/turn references while reporting unknown state. Native command
and file requests may only be declined or cancelled; a broker grant cannot expand native policy.
The provider must independently provision and verify the effective named profile.

### Current bounded evidence

Real signed-in acceptance used the owner's explicitly handed-off, idle Crew auth home in place.
Only the pinned native host accessed authentication. No auth values, personal service files or
personal configuration were read/copied, and no new sign-in was started. Disposable test helpers,
markers and detailed evidence remain outside the repository.

| Check | Observed result and limit |
| --- | --- |
| Genuine subscription inference | Completed native model turns using ChatGPT authentication. |
| Allowed native file/image surfaces | A workspace canary read and permitted image view succeeded. |
| Tool environment | Actual `printenv` for synthetic transport/private environment canaries returned no values. |
| Direct tool network | Actual loopback curl failed; the live synthetic endpoint recorded zero requests. |
| Authenticated MCP | Allowed synthetic read succeeded; forbidden operation reached the broker and was explicitly denied. No retries or external action. |
| Same-chat fresh-process resume | Same native ID returned the named profile, never-approve policy and exact local cwd/roots. |
| Synthetic realtime handoff | Subscription WebRTC connected. Generated speech produced one native completed coding turn; retained history contains the server-created realtime delegation. The test sent no `turn/start`. |
| Protected file/image/edit checks | Models reported permission denials and protected fixture bytes stayed unchanged. The inspected public item stream/history omits some pre-execution failures, so those claims alone do not establish per-tool denial coverage. |
| Production adapter typed path | Native resume and exact profile-settings acknowledgement, genuine text delivery/completion, Stop, fresh-process same-thread restart and a second Stop passed through the actual adapter. |
| Profile behavior | Direct `thread/start.developerInstructions` produced the required prefix on a new chat. After same-chat restart, a changed launch instruction was confirmed in config but the model kept the original prefix. Collaboration-mode and direct resume overrides also failed to change behavior. |

The stress profile intentionally enabled native command tools to exercise enforcement; production
retains additional native-tool disablement and requires its own combined candidate validation.
The exact authenticated Crew/services MCP endpoints use documented native dispatch approval
configuration, while current Crew session/group/broker policy remains authoritative. Global native
approval stays `never`; native dispatch trust is not a service grant.

Earlier synthetic attempts are preserved as failures: v3 text output was rejected, the WebSocket
audio route required API-key auth, and a WebRTC text append acknowledged without a handoff. No
API-key fallback was used. The successful attempt fed generated speech through a synthetic browser
audio track; it acquired no physical microphone, played no speaker audio and did not fabricate a
human utterance. All owned peers and the temporary browser were closed after the check.

The pinned runtime did not emit `bemItemPromoted` for the real handoff. Ordinary native turn events
still drive activity, completion and Stop. Each newly observed nonterminal turn invalidates exact-session
preparation readiness; completion and voice closure do not restore a stale readiness report. The probe's promotion-specific result therefore remains
incomplete even though independent native history confirms delegation and completion. Production
must not label a turn as owner voice solely because it overlaps a voice call or contains delegation
text. Public-history provenance and human acoustic acceptance remain separate checks. Typed app
validation can proceed against the candidate; none of this implies installed-product acceptance,
release permission, or complete coverage of every model-accessible tool.

The adapter sends the saved profile through the direct native startup field,
without adding a workspace instruction file or another durable profile source. Its settings
acknowledgement remains a configuration claim. The pinned runtime's changed-profile behavior on
retained chats requires the approved native context refresh below; settings acceptance alone is
insufficient. The second synthetic voice check captured a legacy `handoff_request`
with realtime handoff/item IDs but no coding turn/item IDs; it provides no safe public-history
correlation fallback.

The new direct-start adapter path was itself exercised with real subscription inference: a plain
arithmetic question returned the prefix supplied only through the saved startup profile, followed
by confirmed Stop, fresh-process same-ID resume and another Stop. The latter steps establish
configuration/lifecycle behavior, not consumption of a changed profile. In the independent #95
walkthrough, the model returned the current saved-profile marker after reading the profile through
Crew tools. That proves saved-profile access and successful tool work; it neither contradicts nor
resolves the private instruction-only resume control. Preserve both evidence sets and scope the
remaining limitation to the tested native instruction paths.

### Explicit native context refresh control

A final bounded diagnostic established a supported same-chat option for the tested retained-profile
problem: cold `thread/resume` with the new direct `developerInstructions`, followed by explicit
`thread/compact/start`. The compact request returned acknowledgement, then a real native turn and
a matching `contextCompaction` item completed successfully. A fresh thread read confirmed idle.
The next plain arithmetic input used the new instruction-only prefix. Before/after native reads
preserved all five existing turns and ten existing item IDs under the same thread ID.

This is native context maintenance with a real turn lifecycle, not an idle or zero-work restart.
It may use model allowance; the diagnostic did not capture an exact token count. Inspectable native
history remained intact, while the active model context was summarized. Do not describe that
summary as lossless. The owner subsequently approved this operation for explicit changed-instructions
Restart. Ordinary Start never silently runs compaction.

The approved implementation is an explicitly authorized changed-instructions Restart that
retains the thread, supplies the current profile, runs native compaction, and acknowledges the
applied revision only after the exact compaction item and successful turn complete and native
policy/idle state is rechecked. RPC acknowledgement or a turn ending alone is insufficient; errors,
timeouts and missing item completion remain failures/uncertainty. New idle Start does not
run this operation. This explicit owner choice supersedes the earlier policy hold.

### Compaction completion, history and cost evidence

The private evidence records the exact thread, compaction turn and item IDs. Completion was
verified by all of these observations, in order:

1. `thread/compact/start` acknowledged submission. This alone does not establish success.
2. `turn/started` identified the native compaction turn.
3. `item/completed` identified a `contextCompaction` item on that exact turn.
4. `turn/completed` reported `completed` for the same turn.
5. `thread/read` returned the same thread ID with idle state.

A later read-only native process verified all five prior turns and all ten prior item IDs again.
Their item counts were unchanged, and each original user/assistant message text matched the
recorded pre-compaction test inputs and outputs. The native compaction turn/item and the subsequent
arithmetic turn are additional history. This establishes retained inspectable message history for
this fixture; it does not claim byte-identical hidden storage or lossless active model context.

The diagnostic recorded an actual native compaction turn, so it must be treated as work in
activity/preparation/reservation handling. No per-compaction token usage was captured. Token count,
monetary cost and allowance impact are unavailable, not zero; no cost estimate is inferred from
its duration. The final history verification sent no model input and confirmed its reader exited.

The applied configuration retains only a SHA-256 digest of the composed instruction bytes as
provenance. The saved profile remains the sole current instruction source. A picture-only or other
non-instruction revision does not cause compaction when the verified digest is unchanged. New
threads and unchanged verified Start/Restart remain idle. A retained chat with changed instructions
or no verified digest requires explicit Restart; ordinary Start returns actionable guidance before
native launch. Legacy applied configurations without the optional digest remain readable.

`AgentSession.instructionPreparation` exposes `compacting`, `completed`, `failed` or `uncertain`,
the exact native thread and observed turn/item IDs, timestamps and a sanitized error. The session
stays `starting` until verification succeeds; the previous applied configuration remains in place
on failure, with its instruction verification digest invalidated before compaction can dispatch.
This prevents reverting saved instructions from reusing a stale digest after an uncertain refresh;
the prior revision remains historical provenance, and another explicit Restart must verify context.
Controller recovery makes incomplete compaction uncertain and never replays it.
Preparation uses the existing permission/profile startup path, preserves readable history, and
does not submit a synthetic work assignment. No token or monetary-cost estimate is exposed.

### Approved Restart implementation acceptance

The production foundation and native adapter were exercised together against the pinned signed-in
native build using an isolated synthetic chat and a trusted synthetic permission resolver. A new
idle Start acknowledged a digest, and a genuine arithmetic message returned the old instruction-only
marker. After a saved profile change, ordinary Start rejected before native launch and settled its
unused logical session. Explicit Restart retained the chat, recorded the exact native compaction
turn/item and completed preparation. A subsequent genuine arithmetic message returned the new
instruction-only marker. The prior public message IDs and content remained readable through the
foundation history API. An unchanged Restart emitted no native turn, and final Stop confirmed exit.

The initial acceptance harness accidentally consumed a buffered compaction completion while
waiting for the next arithmetic result; it stopped the arithmetic turn before a response. The
corrected harness matches the message receipt's exact session and turn, and passed. Both private
evidence records remain available; this was a harness correction, not a product workaround.

Eight bounded protocol test groups cover unchanged idle paths, pre-launch rejection, required
durable progress, exact success, missing/conflicting completion, native error followed by a terminal
turn, lost history, policy drift, timeouts, no replay and explicit Stop. Real-store checks cover
legacy optional fields, rejected Start followed by Restart, durable preparation, blocked execution
and final reservation, stale identity rejection, and recovery to uncertainty. Typecheck and build
passed. This acceptance uses no physical microphone and does not establish installed-app UI,
production permission-provider or retained voice-history acceptance.

### Proposed narrow treatment for missing voice provenance

The inspected legacy `thread/realtime/itemAdded` payload contains `handoff_request`, a realtime
`handoff_id`/`item_id`, and transcript text. It has no coding turn/item ID. The retained coding user
item uses a different ID, and no typed promotion supplied a link. These observations are insufficient
to publish the coding turn as owner voice or attach it to a public user message.

The narrow proposed presentation is a fixed transient status such as “Voice handoff requested;
its conversation link is unavailable.” It may acknowledge only a validated request on the exact
active voice/thread binding. Do not forward the opaque payload, save its transcript as another
conversation, or imply a correlated execution/completion. Generic native agent activity remains
separately observable, and the actual coding history remains native-owned with unknown visibility.

Continue to block public disclosure/steering that requires missing provenance. Preserve generic
turn lifecycle, preparation invalidation, exact Stop and native history. Do not replay the handoff,
create another chat, or infer provenance from timing, transcript wording, a missing client ID or
voice being active. A future native event supplying the exact realtime/turn/item relationship can
resolve the association. This transient-status treatment is a proposal, not an implemented fallback
or a claim that public voice history acceptance is complete.

### Live voice display (#95)

The desktop owner bridge projects validated native transcript items into the existing conversation
view as a live call transcript. Partial deltas append and final snapshots replace the same native
item. The display is bounded to 32 recent items, 16,000 characters per item and 64,000 total
characters. It stays in memory during navigation and clears when the call ends or its binding
changes. It never writes another chat or sends a model input. Raw realtime payloads and native
audio are not forwarded through this bridge.

This restores live text only. On the pinned runtime, timeline/item pagination is unsupported and
turn pagination omits voice transcript segments. Reopening the app therefore cannot restore this
live transcript. The absent promotion still prevents attributing the server-created coding turn
to owner voice; private and unknown turns remain hidden by the existing history filter.

The transcript controller waits for native started with a nonnull realtime session ID before
accepting item transcripts, then requires exact item/session identity. Deltas require a role
registered by an accepted item in that call. Delayed prior-call items cannot be relabeled with
the pending call's host identity. A bounded synthetic fail-before/pass-after check covers the
old-call completion before new started, null native identity, old/unknown deltas and valid new text.
