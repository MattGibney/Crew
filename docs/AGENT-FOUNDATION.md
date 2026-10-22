# Unified agent foundation — Crew #88

[Issue #88](https://github.com/MattGibney/Crew/issues/88) implements the foundation track of
[#86](https://github.com/MattGibney/Crew/issues/86) on the agreed
`codex/unified-agent-platform` branch. Canonical DTOs and ports remain in
[`src/agents/contracts.mts`](../src/agents/contracts.mts); this track does not change them.
This is a fresh-state composition, not a migration or a second runtime mode inside the installed app.
The existing desktop bootstrap is not switched by this PR. #86 owns the explicit combined cutover.

## What the owner can do

The agent renderer uses one profile and session model for every agent. Create an agent with a name,
optional picture reference, personality, complete instructions and selected native skill references.
Start opens an idle session. Saving a profile does not send a message or change active instructions;
Restart applies the saved configuration on the retained thread only after native acknowledgement.
The UI shows pending revisions as plain restart guidance and preserves unsaved drafts.

Open an agent to read native conversation/tool activity, visible working notes, assignments and
delivery evidence. Queue waits for an active turn to finish; Steer targets the active turn. A stopped
recipient retains intent until explicit Start. Acceptance is labelled as delivery, never task
completion. Failed or uncertain delivery remains visible; reconciliation never blindly replays it.

Jobs are either local objectives with updates/outcomes or thin external ticket references. Agent-set
status, short label, detail and optional percentage are one coherent job display. Crew does not infer
progress from process activity, enforce transition order, or run project commands from a status.
Ticket contents remain provider-owned; only identity/link/assignment/progress are stored here.

Every agent has the same read-only owner scratchpad view. Authorized agent tools can replace or clear
the notes with revision checks. Help follows the explicit reporting relationship, ending at the
owner inbox. Responding delivers a correlated answer; it does not grant external service access.
Archive hides an agent while preserving its session, thread, notes, jobs and resources.

## Integration entry points

| Module                              | Entry point and responsibility                                                                                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agents/store.mts`              | `FoundationStore.open({ directory, projectId, ownerUserId })`: single trusted writer, private atomic JSON, strict validation and revisions.                                 |
| `src/agents/records.mts`            | `FoundationRecords`: agent/profile/skills/scratchpad/job/help mutations; authenticated principals and same-project references.                                              |
| `src/agents/foundation.mts`         | `AgentFoundation`: canonical `AgentLifecycle`, durable sends/receipts, native events, owner native approvals, preparation/reservation.                                      |
| `src/agents/codex-runtime.mts`      | `createCodexAgentRuntime`: actual installed app-server adapter. Required trusted `CodexLaunchResolver`, optional authorized attachment mapping.                             |
| `src/agents/composition.mts`        | `createFoundationSenderLookup(store)`: exact persisted sender attribution across logical sessions on one native thread.                                                     |
| `src/agents/tools.mts`              | `createFoundationAgentTools(foundation, authenticatedCaller)`: bounded agent tool catalogue and dispatcher for a session-bound MCP/native host. Caller is never model JSON. |
| `src/agents/owner-api.mts`          | `createOwnerApi(options, authenticatedUserId)`: owner projection and typed renderer commands. Runtime/model defaults and catalogues come from trusted composition.          |
| `src/agents/http.mts`               | `startFoundationHttp`: exact-host/origin loopback HTTP/SSE with pinned compiled renderer assets. Returns `origin` and `close()`.                                            |
| `renderer/src/agents/AgentsApp.tsx` | `AgentsApp({ client, settingsPanels })`: standalone shared navigation with injected #89 settings panels. `renderer/agents.html` is built by Vite.                           |

Construct the store, then native adapter with `createFoundationSenderLookup(store)`, then the
foundation with explicit `AuthorizationService`, `RuntimeAccessProvider`, `OperationBroker`,
configuration loader and external-reference validator. There are no permissive default ports.
Call `recover()` before serving a reopened store. Bind agent tools only through authenticated
session transport; bind the owner API only to the local owner's control surface. Inject #89 panels
through `AgentsApp.settingsPanels`; no credential-entry form is implemented in this track.

#89 must use `foundation.executionAllowed(caller)` in its fresh execution admission path before
`admissionUsesFoundationBarrier` may be enabled. Without this composition assertion,
`reserveExecution` blocks. Once reserved, foundation sends/starts and fresh broker admission are
held; broker settlement then checks previously admitted operations. Normal messages remain
available during preparation. Reservation release resumes eligible existing message queues without
starting intentionally stopped agents. This is a project boundary; parent-wide installed-app
Quit/update must reserve every project before stopping any host.

`requestPreparation(binding, reason)` is an optional trusted native control-channel hook. The shared
runtime port has no technical preparation-message method, so absence is an explicit blocked
readiness state. The owner can send a genuine preparation request; the agent reports readiness
through `preparation_readiness`, tied to its exact session and continuation save time. No invented
human message is used to make preparation appear delivered. Actual installation remains outside
this module. A missing all-project/app lifecycle composition is not a successful update claim.

Skills are selected by native references/revisions from #34. They are not authored or copied here.
Resource references are independent of agent identity. No environment command, deletion or setup
is performed implicitly. Existing project tooling/environment operations still need an explicitly
authorized host contribution; this track supplies resource reads and preserves the references.

## Durable evidence and recovery

Crew persists profiles, jobs, assignment history, working notes, open help/inbox content, unresolved
message bodies, attempts, native approval identities, start-dispatch evidence and lifecycle intent.
After native acceptance it removes the message body and keeps a compact receipt plus an intent
digest. Reusing that message ID with changed intent is rejected without retaining another chat.
Codex history stays authoritative; renderer history is disposable. Private reasoning is omitted.

The state file is owner-only and written atomically under a non-stealing single-writer lock. A
retained lock needs explicit ownership recovery; unknown ownership never expires by age. Invalid
or foreign state is rejected. `close()` drains persistence before releasing its owned lock. Store
disposal does not mean native processes stopped. A host must explicitly settle sessions before
controlled shutdown; unverified recovery expires prior logical-session grants and retains native
identity/uncertain intent for resolution. There is no automatic create/replay/adoption path.

Stop first holds session execution and expires session grants, then settles native/broker execution.
It only records stopped after native acknowledgement, or durable proof that native start was never
dispatched. Repeated Stop cannot convert an uncertain create with no known thread into proof of no
native work. Native approvals require an explicit owner choice and correlated resolution; uncertain
responses are retained and never resent automatically. Native resources/services are not destroyed.

## Focused validation and remaining limits

Validation uses TypeScript/build, bounded disposable record/service/adapter flows, and the compiled
renderer against the real foundation store/API with synthetic runtime/access/broker peers. No test
suite or permanent fixture framework is added; no full regression suite is run. Private evidence
and screenshots stay outside Git. These checks do not establish real service or packaged acceptance.

The native no-generation probe found that Codex 0.163.0-alpha.11 accepts idle startup and exact
settings acknowledgement, but a new idle thread is not resumable before its first genuine message.
The adapter preserves `missing_thread`; it does not create a replacement or fabricate a message.
Native timeline/item APIs advertised in generated types are unavailable, so history uses turn
pagination. See [native runtime evidence](AGENT-NATIVE-RUNTIME.md) for method-level limits.

Remaining integration/feasibility work is explicit: #89's enforced isolation plus subscription
authentication and owner setup; #90's real broker/catalogue/executors; #34 native skills; approved
artifact resolution; actual materialized-thread profile/model behavior; native active-turn approvals
and steering; brokered ticket display; unsupported permission/MCP elicitation UI; explicit environment
actions; preparation control channel and all-project native Quit/update wiring. None is replaced by
an insecure fallback. The old installed UI/runtime is not silently cut over, reset or migrated.

At an eventual owner-authorized cutover, identify and archive only the selected Crew-owned state,
then create profiles/groups/connections afresh. Preserve personal Codex sign-in/history/storage,
repositories/worktrees, service data and credentials. This PR performs no reset, release or install.
