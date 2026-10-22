# Unified application composition — #88 / #95

`startUnifiedApplication` in `src/agents/service-composition.mts` is the reusable
host entry for the desktop application. It owns one project, one foundation store,
one access store, one gateway, one authenticated native tool host, one execution
admission gate and the actual native Codex runtime provider. Desktop supplies its
trusted executable path, encrypted credential backend and canonical project skill
store. Owner commands are bound to the authenticated main process; none accepts an
actor supplied by a model.

## Setup and retained identity

The runtime supplies actual model/configuration references for an initial
owner-approved creation preset. A preset can be saved before any agent exists.
The owner explicitly creates and designates the primary agent; list order has no
meaning. Creation persists the exact preset revision and original creator before
applying the access-store assignment. Incomplete provisioning holds Start. Recovery
reconciles the same application and does not restore a later revoked assignment.

Every native session has an authenticated foundation endpoint (including project
skill tools) and a separate authenticated service gateway endpoint. Session tokens
are launch capabilities, never owner/agent DTO fields or persisted transport data.
Durable request fingerprints bind MCP transport requests to logical invocations;
changed arguments reject and an uncertain mutation is not automatically replayed.

Native Start creates or resumes the same retained chat without inventing a user
message. The adapter sets the agent name, reads the native thread back and checks
applied configuration. Stopped history uses a separate read-only peer and never
resumes a turn. After an unexpected host exit, explicit recovery requires recorded
native process-exit evidence and settled session operations. A retained chat ID is
not evidence that its former process is dead.

## Public conversation and private work

Owner and agent messages retain authenticated sender identity. Schedules and
preparation use an explicit system origin and private visibility. Receipts retain
native turn identity; native history remains the content authority. Public input
during private work waits for a separate native turn, and private work during a
public turn waits likewise. An uncertain acceptance holds later dispatch until
reconciled. Delivery intent remains visible while waiting.

The scheduler passes its bounded local eligibility callback as the second argument
to `foundation.sendInternal(input, isCurrent)`. Foundation rechecks it under the
shared admission gate immediately before persisting the private intent. A stale
occurrence returns `null`; the host reports `accepted: false`. Native pumping runs
after releasing the gate. Checking eligibility only before calling Foundation
leaves a schedule-change/admission race.

Voice belongs to the explicit primary agent's existing native chat. Native
server-managed handoffs must not create a second model turn. Only authoritative
native promotion IDs establish public voice-turn history; transient transcript
notifications are not copied into a second conversation store. Private input waits
while owner voice remains connected. Connect/disconnect and microphone intent are
separate: the renderer owns permission/capture and no runtime setup action enables
a physical microphone.

## Preparation and execution admission

Preparation asks each current native session to save its continuation. Every
request has a fresh preparation ID. New native input, tool execution or skill
changes invalidate earlier readiness; reports must match the current ID and a
save time after that new work. Preparation never reserves execution.

A single short gate covers fresh admission checks and durable intent/in-flight
records. Remote model/service calls execute after releasing it. Final reservation
rechecks current sessions, readiness, deliveries, approvals, gateway operations,
workspace execution and realtime activity. Individual Stop checks only its exact
session's operations; whole-application Quit checks the project. Files and
independent project resources are not deleted by Stop or Quit.

## Validation boundary

The 22 October 2026 integration checkpoint is `0150543` (runtime code `5273d9d`).
The former outer-sandbox/resume blocker is superseded: the pinned native host uses
its own model authentication, while a verified native named profile constrains model
tools. Start/resume/turn selection retains the exact profile, `never` escalation and
neutral local workspace. Real project commands go through the separately authorized
executor. This is not process-wide isolation of the trusted native host. See
[the current native policy](ACCESS-ISOLATION.md#native-boundary).

The evidence sets remain distinct:

| Scope | Observed result | Limit |
| --- | --- | --- |
| Signed-in composed typed work | The manager created and started a worker, steered active work, queued input, ran an approved disposable project command and received the report. Both recorded jobs completed. | This verifies the tested manager/worker workflow, not arbitrary projects or external providers. |
| Isolated unsigned package | Actual launch, Quit and reopen preserved the same native chats and signed-in state. | No installed-app replacement, signed release or automatic-update acceptance. |
| Real access/broker components | Actual access store, authorization service, vault and gateway exercised exact once approval/resume, session and persistent grants, revocation before later admission, duplicate suppression and changed-argument rejection against an authenticated loopback MCP fixture. | The upstream and credential values were synthetic; this is not a live third-party service test. |
| Credential execution | The controlled CLI received its synthetic credential only inside the trusted executor; explicit environment, redacted output and final admission denial were checked. Actual Electron safeStorage separately passed synthetic store/rotate/reopen, stale-reference denial and deletion checks. | Vault storage and executor checks do not prove every provider's credential contract or isolate arbitrary trusted-host code. |
| Native model-tool permissions | Installed-runtime command checks denied protected reads/writes and direct network access; exact profile/configuration, skill paths and session revocation were checked. | No-model command checks and incomplete pre-execution model events do not establish every model-tool denial. |

[Gateway evidence](AGENT-GATEWAY.md#usability-integration-evidence--22-october-2026)
and [access semantics](ACCESS-CONTROLS.md#execution-and-recovery) retain the precise
once/session/persistent scope and fresh permit-redemption requirements. Credentials
stay in the vault until trusted executor use; neither native MCP dispatch approval nor
a previously advertised tool grants service authority. Connection removal/revocation
blocks later admission and does not undo an operation already admitted.

A separate real subscription WebRTC check used generated speech and produced one
server-created coding turn that completed in the same resumed chat, without the test
sending `turn/start`. The pinned runtime did not supply the promotion relationship
needed to publish that coding turn as owner voice history. A legacy realtime handoff
ID without coding turn/item IDs is not that relationship. Preserve native lifecycle
and history, but do not infer public voice provenance from timing or transcript text.
There was no physical microphone or human acoustic acceptance. See
[the native voice evidence and provenance limit](AGENT-NATIVE-RUNTIME.md#current-bounded-evidence).

Full acceptance is not asserted. Changed-profile context refresh through explicit
native compaction is approved and under implementation; its acknowledgement,
compaction-item/turn completion, retained history and unavailable cost evidence must
remain separate. Help/private-work/preparation UI checks are still in progress.
[The native context-refresh evidence](AGENT-NATIVE-RUNTIME.md#compaction-completion-history-and-cost-evidence)
records the supported diagnostic, not acceptance of the pending product integration.
Real third-party configuration/authentication/operation needs its own owner-approved
service evidence; no such success is inferred from the local broker fixtures.

Workspace commands retain private evidence for their launched process group and
observed descendants. Foreground completion and a background process's natural exit
plus `environmentOwnerApi.reconcileOperation(operationId)` passed the real Foundation
reservation check with a synthetic native session. This separate component check
preserves unknown outcomes and never replays or cleans resources. A dispatch crash
before its returned evidence reference is saved still blocks reservation. Sampling
does not establish unobserved daemonization or arbitrary resource cleanup.
