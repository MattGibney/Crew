# Shared agent contracts — Crew #87

Canonical source: [`src/agents/contracts.mts`](../src/agents/contracts.mts).
Design authority: [#86](https://github.com/MattGibney/Crew/issues/86), with domain detail in
[#87](https://github.com/MattGibney/Crew/issues/87), [#88](https://github.com/MattGibney/Crew/issues/88),
[#89](https://github.com/MattGibney/Crew/issues/89), [#90](https://github.com/MattGibney/Crew/issues/90).
The owner approved this boundary in PR #91, merged into `codex/unified-agent-platform`.
The contracts alone do not establish a working replacement runtime.

Integration checkpoint, 22 October 2026: PRs #92, #93 and #94 are consolidated on the
shared feature branch. Combined type-check/build and a disposable flow using the real
foundation, access, vault and gateway implementations passed. The flow caught and fixed
broker-only `createdAt` metadata leaking into the strict authorization input. Once
approval, execution, duplicate/reopen handling, revocation, Stop expiry and record
persistence were exercised with synthetic runtime/access and test-only encryption.
This is not native or installed-app acceptance. Production desktop composition, native
credential isolation and atomic Quit/update admission remain unfinished under #86.
The owner withdrew the local-install request; no installation or main merge is included.
Import using `import type { Agent } from "../agents/contracts.mjs"` (adjust relative path).
Renderer consumers can import types from the same source; do not copy DTOs into renderer contracts.

## Product behavior

Every agent is the same persistent colleague abstraction. Name, picture, personality,
instructions, skills and permissions distinguish responsibilities; there is no manager class.
Start makes an agent available without greeting, assignment or model turn. Stop preserves its
native chat, scratchpad, jobs and optional environments. Explicit Restart applies saved profile
changes on the same thread after native acknowledgement. An unavailable environment does not
prevent a non-coding conversation, provided an isolated private workspace is available.

Job progress is the sole business status: fixed broad colour/grouping, short agent-written
label, optional detail and optional percentage. All transitions are valid, including backwards;
null is unavailable. The UI selects the relevant job, or displays no job. Connection/turn facts
may be labelled separately but must not become a competing inferred workflow badge or ETA.
Scratchpads are mutable visible working notes, never private reasoning or immutable evidence.

## Ownership and integration

| Owner           | Exclusive new files/stores                                                                                                                            | Ports supplied / consumed                                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #87             | `src/agents/contracts.mts`, this document                                                                                                             | Shared definitions; changes go through a coordinated contract amendment, not local copies                                                                   |
| #88 foundation  | Other `src/agents/*`; agent/profile/scratchpad/job/assignment/session/message/help stores; native runtime and foundation UI                           | Supplies `AgentRuntimeAdapter`, `AgentLifecycle`; consumes `RuntimeAccessProvider`, `AuthorizationService`, `OperationBroker`                               |
| #89 access      | `src/access/*`; groups, memberships, connection records, secure vault, access requests, grants/reservations, isolation policies; access/credential UI | Supplies `AuthorizationService`, `CredentialVault`, `RuntimeAccessProvider`; consumes foundation identity/session facts; exposes connection metadata to #90 |
| #90 gateway     | `src/gateway/*`; upstream MCP/CLI adapters, capability catalogue, pending invocations/attempts/receipts; trusted executor configuration               | Supplies `OperationBroker`, `ServiceExecutor`; consumes #89 policy/vault/connection records                                                                 |
| #34 skills      | Native skill authoring/discovery/store implementation                                                                                                 | Foundation consumes `Skill` revisions/directories; #88 may add minimal selection UI, not a second skills store                                              |
| #86 integration | Final composition and shared app wiring                                                                                                               | Wires the three implementations; owns combined usable-flow acceptance and eventual cutover                                                                  |

Dependencies point toward contracts; contract source imports no implementation, Node or UI code.
Implementations receive explicit instances of the ports, never ambient current-agent globals.
#88 owns shared settings/navigation composition; #89 contributes its panels through that owner.
Connection CRUD and credentials belong solely to #89; #90 supplies discovery/authentication/health
adapters and returns observations to that store. Gateway owns OAuth protocol/refresh coordination;
vault owns storage and revision-checked replacement. One per-connection refresh lock and CAS prevent
competing token authorities. `TrustedCredentialHandle` is an opaque trusted-process vault adapter
handle: its `use` callback supplies credential bytes only inside the trusted executor for upstream authentication, never through an agent-callable tool. Do not serialize handles, return bytes from callbacks or include them in errors.
Owner credential-entry plumbing stays private to #89; it is not a model-facing DTO.

The first cut scopes agents, groups, connections, jobs and grants to one project. Validate all
referenced IDs and reporting edges against that project. This is a bounded implementation choice,
not a decision about future cross-project policy. References are opaque IDs, not authority or paths
an agent may resolve. Enforce revision checks for editable profiles/notes/groups/connections; the
foundation supplies the immutable `ConfigurationSnapshot` used for one start attempt. Destructive
resource actions remain explicit and separately authorized. No background workflow engine.

## Native session flow

1. An explicit Start allocates and durably records a logical session ID. Read the latest saved
   profile, enabled skill revisions and runtime config; #89 `prepare` must return observed isolation
   evidence plus `RuntimeAccessBinding`, or block with concrete limitations. No upstream credentials
   or personal authenticated tool configuration enters native runtime inputs.
2. Call adapter `start` with those inputs and either explicit initial `create` or retained `resume`.
   Never silently replace a missing thread. Persist native thread ID immediately when known, even if
   subsequent configuration application fails. Only native acknowledgement records applied revisions.
   `start` does not call deliver/start-turn. `RuntimeStartResult` retains a known thread ID on failed/uncertain application. A failed/uncertain start is reconciled with native facts
   before another create. Display desired/applied mismatch and failure rather than inventing success.
3. Start on an already started session is idempotent and does not apply a newly saved profile.
   Save changes desired configuration; Restart is required. Unsupported native instruction application
   blocks application and remains visible. No fabricated user message may apply system instructions.
4. A transport reconnect can retain session identity/grants only when the exact live session and
   native ownership are verified and the durable session has never closed. After a controller crash,
   uncertain ownership or missing proof, close the old permission session via `closeSession` and
   require a new explicit Start; retain the native thread. Never revive expired grants.
5. On explicit Stop/Restart first block new execution for that session and call `closeSession` to
   expire its session grants/cancel queued grant use, then settle native and broker execution.
   Record stopped only after native stop acknowledgement. Failure stays error/unknown and does not
   restore expired authority. Restart allocates a new session ID after stop settlement and repeats
   step 1 on the same thread. Persistent grants remain; native approvals are separate throughout.

`RuntimeAccessProvider` is #89's enforcement contract, implemented with #88's installed-runtime
constraints. Its ready result is a claim requiring observed evidence, not an isolation boolean.
Filesystem/process/network, env, personal MCP/OAuth/CLI config, Git/SSH helpers and OS vault access
all matter. If subscription authentication cannot coexist with enforced service isolation, block and
raise the concrete feasibility decision. Do not copy auth files or add API-key fallback. No model
credential is forwarded to the gateway. The gateway binding conveys only session caller identity.

## Message delivery and escalation

`AgentContent[]` is canonical, including a single text block for plain text; image/file blocks are
artifact references and structured tool data is sanitized JSON. No binary duplication. Authenticate
sender on ingress; agents cannot supply another agent or human identity. Technical/system traffic
uses `RuntimeEvent`, not a synthetic user `Actor`. Native history retains its native role while
Crew correlation preserves actual human/agent origin; unidentified external native input must not
be attributed to the owner without evidence. No private reasoning capture.

Persist outgoing intent before sending. Queue is FIFO per recipient, waiting for an active turn to
finish; steer may target that active native turn. A started idle recipient may begin a turn for an
actual message in either mode. A stopped recipient remains stopped with intent retained. Unsupported
steering returns `not_sent/unsupported`, never silently changes to queue. A stale expected turn is
reconciled and attempted only once a fresh target is known. No job status/dirty-file gates.

Every attempt has its own ID and exact session/thread/turn correlation. `acknowledged` means native
acceptance, not task completion. Definitive not-sent can be retried; uncertain requires native
reconciliation and must not be blindly replayed. An adapter unable to prove either outcome returns
uncertain. The broker's numeric retry limit applies to broker operations, not arbitrary chat traffic.

After acknowledgement, compact to `MessageReceipt` even if native message reference is unavailable:
thread + session + attempt identity + native acknowledgement remain the receipt. Null native ref
is never proof a message was absent. Keep unresolved/failed bodies until explicit resolution or
cancellation; never TTL-delete uncertain intent. Native chat/history is authoritative; rendered
history caches are disposable. No permanent second Crew chat or full tool-result transcript.

`reportsTo` is one explicit next hop, ending at the human owner. Reject cycles. `HelpRequest` links
to message intent; replies use `replyToMessageId`, and escalations create a new linked help hop.
Human targets use a durable owner inbox rather than a fake recipient agent. Agents choose triage,
batching and further escalation. Normal help responses confer no access authority; access review
uses `AccessRequest` and the protected authorization path. No multi-manager administration UI here.

## Jobs and source ownership

Ticket jobs retain only immutable provider identity, connection, canonical URL, assignment-specific
brief, assignment history and current progress. GitHub external ID must be repository-qualified
(e.g. `MattGibney/Crew#87`); Linear uses immutable issue ID. Provider requirements/status/results
remain provider-owned and are read/written through authorized broker calls. Display caches are
separate/disposable. Local jobs own title/objective/updates/outcome. Assignment actor is actual
human or agent; reassignment appends an event. Do not synthesize progress from tool/process events.
Job/scratchpad reads do not trigger a model turn or interrupt another agent.

## Access decision and grant lifecycle

All calls bind authenticated caller/project/session, validate current session and same-project
references, and default deny. `CrewAction` is the first capability catalogue for Crew's own tools;
service capability IDs come from actual provider discovery, not invented commands/scopes.
Crew group capabilities contain only an action and are enabled by presence. Assigned group
membership authorizes valid targets within the project; capabilities from multiple groups combine.
There are no per-capability target scopes. Operation target shapes still require validation. Membership changes, connection assignment and grant administration are themselves protected;
initial credential/access administration is human-owner only. A generic `grants.approve` bit alone
must not enable delegated authority; future agent approval requires a bounded, explicit delegation
model and is denied in this cut.

For service execution:

- Connection assignment is always required. An approval does not add connection membership.
- Given assignment, either a current group capability OR an active explicit owner-approved grant
  matching agent/connection/operation/arguments authorizes execution. Groups combine additively.
- An explicit grant can substitute for a missing standing group capability, but never bypass
  assignment, live session, project isolation or native Codex restrictions.
- Revoking one source does not subtract an independently valid source. UI explains remaining
  effective sources. Unassigning the connection denies every later call regardless of grant.
- Group capability access allows that discovered operation with schema-valid arguments. Approval
  exact scope matches fingerprint. Capability scope lists explicit operation IDs plus constraints;
  empty constraints means all schema-valid arguments and must be displayed as such at review.
  Constraints use JSON-pointer exact allowed values, AND across paths; missing values deny.
  Reject unsupported constraints. No prose-only authorization or implicit search-to-send expansion.

`AccessRequest` shows current exact invocation AND requested future scope. The reviewer chooses
duration and final scope separately; the requested scope cannot authorize itself. Once grants must
be exact-operation scoped and bound to the request's logical invocation. Session scope binds to the
actual requester's live logical session; persistent lasts until revocation, never unspecified scope.
Reject approval of an expired/stopped-session request; persistent grants already issued survive
restart. Pending requests persist, and are expired/cancelled truthfully on session closure.

`authorizeAndReserve` atomically locks one immutable logical invocation and matching once authority;
duplicate callers get the same reservation/result, never another concurrent execution. `beginAttempt`
creates an attempt permit; executor `redeem` is the execution admission/linearization point: atomically check current membership/assignment,
session, matching authority and revocation, serialize one active attempt, redeem the attempt-specific
one-use permit. Revocation before admission denies; admission before revocation may already be
in flight and cannot be undone. Executors must redeem that permit exactly once in trusted code.
Don't let a reservation ID bypass this check or let a queued permit execute after revocation without
admission. #89 and #90 implement permit admission/redemption as one controlled execution handoff.

`settle` is idempotent by reservation/attempt. Accepted/failed-after-acceptance consumes once;
uncertain holds the reservation (not reusable). Conclusive non-execution allows the SAME logical
operation's next attempt under the reservation, after fresh policy checks. `releaseNotExecuted`
closes an abandoned proven-unexecuted reservation: restores still-valid once authority only for its
original logical invocation, never another operation; revoked/expired state cannot be restored.
Reserved/consumed describe once grants; session/persistent remain active until expired/revoked while
per-invocation reservations serialize execution. Preserve revocation even when late results arrive.

## Broker outcomes, verification and retries

Gateway normalizes schema-validated JSON, rejects non-JSON/non-finite values, applies explicit defaults,
and computes SHA-256 of RFC 8785 canonical JSON. All three tracks use the gateway fingerprint; do not
hash ordinary `JSON.stringify` output independently. Operation identity binds project/agent/session,
connection/operation and fingerprint; reuse of invocation ID with any changed field is denied.
Access compares identity and scope, not human labels. No secret arguments; credential entry is owner
control plane. Store exact arguments only while needed for pending execution/verification, with
private bounded retention; resolved receipts retain fingerprint/identity and compact evidence.

`OperationBroker` handles authorization, durable attempts, retries, cancellation and result correlation;
`ServiceExecutor` executes ONE admitted attempt. Structured CLI argv/stdin/cwd mapping is private trusted
executor config, never an agent-supplied shell string. MCP uses stable connection-ID namespacing and
actual upstream schemas. Catalogue availability is not authorization. Call cancellation uses AbortSignal;
progress callbacks are technical transport, never inferred JobProgress. Sanitized outputs/artifacts and
bounded separate stdout/stderr diagnostics must not reveal upstream credentials or authentication config.

| Outcome             | Meaning / next action                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `succeeded`         | Accepted result or verified execution; return to same invocation/thread, no replay          |
| `approval_required` | Persist request and exact pending intent; resume only on valid approval and live session    |
| `denied`            | No admission; show reason, never invoke upstream                                            |
| `not_executed`      | Conclusive evidence of no execution; eligible for bounded retry                             |
| `uncertain`         | May have executed; read-only verify when supported, otherwise retain and escalate           |
| `failed`            | Definitive terminal error, including accepted operation failure; not proof of non-execution |

Attempt numbers are 1–4: original plus at most three additional attempts, each only after conclusive
non-execution and fresh `beginAttempt` and `redeem`. A generic timeout/error/aborted request is not that evidence.
Verification uses provider receipts/idempotency/resource evidence; no model guesses. Recovered execution
returns recovered result without repeating. Unknown/unsupported verification stays uncertain. Once at
attempt 4, stop even if proven unexecuted. Crash reconciliation reads durable attempts/reservations before
sending; pending at crash is uncertain until proven. Cancel after dispatch may remain uncertain and cannot
release once authority without proof. Result delivery uncertainty never repeats the service operation;
reconcile result delivery separately using native message/turn correlation.

## Quit, update and explicit cutover

After a partial desktop Quit, **Retry Quit** keeps the original reservations and
retries only projects whose closure is unconfirmed. Confirmed closures and
successful cleanup stages are skipped. Each unresolved composition rechecks its
reservation and current execution settlement; lost native Stop acknowledgements
use the existing exact-process exit proof. Return to work remains blocked once
shutdown starts. Reservations clear only after resource cleanup, with foundation
admission already closed. Failed persistence or unavailable ownership evidence
remains blocked; retry never resets state or grants permission to start work.

#88 `prepare` collects agent readiness/continuation while communication remains available. Just before
actual stop/restart/install, `reserveExecution` atomically blocks new turns/broker admissions, rechecks
readiness, native execution, messages and `BrokerSettlement`; release on cancellation/failure. No long
reservation during preparation. Known pending approvals/queued messages and uncertain receipts must be
durable before stop; unknown operations block installation until safely retained/reconciled with explicit
limits. Session termination expires session grants. No environment teardown as a lifecycle side effect;
independent user processes/resources remain owned separately. This is not an install implementation.

The owner chose fresh Crew state for two owner-managed installations. No legacy conversion, dual schemas
or old manager/worker compatibility. At a later explicitly authorized cutover, stop Crew-owned activity,
identify the exact Crew config/state to archive/reset, explain lost Crew records and recreate profiles,
groups and service connections through owner setup. Preserve personal Codex sign-in/history/storage,
repositories/worktrees, external tickets/service data and credentials. This task performs no reset.

## Groundwork, validation and remaining limits

[#84 / PR #85](https://github.com/MattGibney/Crew/pull/85) supplies useful persistent-thread,
optional-environment, notes/help and preparation work. It still uses separate worker paths and legacy
provenance/lifecycle records; it is not this unified model or credential broker. Reviewed its design/file
changes; no wholesale merge or cherry-pick. Reuse selected behavior in #88 against this contract.

This source defines interfaces only. Installed Codex instruction-update acknowledgement, sender mapping,
active-turn delivery/cancellation, history correlation, native skill isolation, sandbox/credential bypass
prevention, real Linear MCP and Lunar CLI/authentication remain to be verified by their implementation
owners. A declared ready/acknowledged state is not proof of those capabilities. No endpoint, CLI command,
secret, production compatibility or native acceptance is invented here.

#88/#89/#90 can implement independently after owner agreement on this PR. Before calling the combined
platform usable, #86 must demonstrate one disposable end-to-end request → scoped approval → broker call
→ same-thread result, plus revocation, restart and uncertainty behavior. Contract validation is limited
to TypeScript/build and small compile-only usage examples; there is no runtime/UI change to exercise.
No new tests, full suites, packaged/installed-app checks, service setup or physical microphone use.

Validation passed: `npm run typecheck`, `npm run build`, and a disposable compile-only example importing the three ports plus local/ticket work, progress, agent messages and exact once grants. The emitted contract module has no runtime exports. No tests were added or run.


## Usability composition amendments (#88, #89/#90, #95)

`ProjectAgentSettings` stores the explicit primary agent in foundation state; only
an authenticated owner can change it. `AgentCreationPreset` and assignments live
in access, with no second editable copy in foundation. `AgentProvisioning`
rechecks the exact approved preset revision before assignment. Foundation records
pending/ready/failed provisioning, holds Start until ready and projects current
access memberships on reads. Agent-created agents report to their authenticated
creator; owner may explicitly select another valid, acyclic relationship.

One `ExecutionAdmissionGate` instance serializes access redemption, native input
admission and final Quit/update reservation. It is an async critical section, not
an earlier liveness poll. Gate callbacks must not recursively acquire it. Pending
and admitted broker records remain the settlement authority after admission.

The owner API is a trusted main-process capability. HTTP deployment requires
unpredictable owner-session authentication as well as exact origin/host checks.
Native tools use a separate session-bound bearer and exact caller identity; no
model-provided actor can grant owner rights. Persist request/invocation correlation
before tool dispatch. End session authority at Stop/Restart, retaining receipts.

`ProjectSkillSource` supplies native directories at exact revisions from the
single project store. `AgentEnvironmentService` implements explicit authorized
actions and preserves request identity; absent integration reports unavailable.
Neither missing environments nor dirty/completed work gates communication.

Later #88 implementation amendments add exact preparation generation/freshness,
compact authoritative realtime promotion metadata and original provisioning creator
identity. See [Unified application composition](AGENT-UNIFIED-COMPOSITION.md) for
the implemented host boundaries and the separate native/provider acceptance limits.
