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

Bounded checks use real durable stores and the real MCP HTTP protocol. Synthetic
native adapters are explicitly labelled and prove only control-plane behavior.
Unsigned-in native probes have verified empty-thread persistence/read/resume,
profile acknowledgement and voice catalogue discovery without inference or audio.
The workspace sandbox has separately exercised local inspect/edit/test and denied
outside access. These do not establish a signed-in agent completing project work,
a real external provider mutation, physical microphone/acoustic acceptance or a
packaged application lifecycle. Those milestones remain distinct acceptance steps.


Current unresolved acceptance: a fresh-process native resume restores a local
environment, so the adapter blocks that path rather than claiming isolation.
Workspace commands retain unsettled status until the real executor supplies
confirmed process-group evidence; root command exit alone does not release it.
These are held boundaries in this checkpoint, not successful Stop/Restart/Quit
acceptance after arbitrary project work.
