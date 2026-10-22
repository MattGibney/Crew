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
opens or resumes the exact requested thread. It never calls `turn/start`, generates a greeting,
executes setup or submits synthetic user input. A missing resumed thread remains missing.

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

`readHistory` currently requires a live adapter session. After Stop it returns disconnected;
the host needs a separately owned read-only native transport to offer stopped-session browsing.
This adapter does not silently restart the agent or open a model session just to read history.

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
- `thread/resume` immediately returned `-32600: no rollout found for thread id …` for the new
  unmaterialized idle thread. **Idle creation is not durable resumption before the first real user
  message in this build.** The adapter preserves the identity and error; it never manufactures a
  message or replacement thread to conceal this limitation.
- Both `thread/timeline/list` and `thread/items/list`, although present in generated types, returned
  `-32601` and “not supported yet”. The adapter uses turn pagination. Before the first message,
  `thread/turns/list` returned the specific native unmaterialized-thread error.
- Native unsubscribe and process exit completed; disposable state was removed after exit.

`npx tsc -p tsconfig.json --noEmit` passed. A separate short disposable **synthetic transport** flow
passed idle start, exact profile event acknowledgement, enumerated approval validation/resolution,
queue/steer correlation, lost-ack history reconciliation, sender attribution, interruption/exit and
same-thread profile restart. This exercised adapter control flow, not subscription inference or
native business-tool execution. No test files were added and no full regression suite was run.

Materialized same-thread profile behavior, genuine active-turn steering/approval execution, full
native history pagination after model work, selected skill execution, credential isolation, gateway
operations and packaged application integration remain combined acceptance work. The resolver seam
does not by itself make those capabilities ready. No personal profile/install, physical microphone,
business service or repository worktree was modified by the native probe.
