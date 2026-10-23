# Agent tool gateway — Crew #90

This module implements the gateway track of [#86](https://github.com/MattGibney/Crew/issues/86)
against the merged [shared contracts](AGENT-CONTRACTS.md). It is a composition library for the
new platform, not a replacement of the installed application. No legacy runtime wiring or migration
is included. The implementation PR targets `codex/unified-agent-platform`.

## What an agent sees

Group-derived service connections advertise their permitted tools with stable, connection-specific names,
upstream descriptions and input/output schemas. Listing a tool confers no execution permission.
Calls use current #89 authorization. A missing grant returns a correlated approval request; after
owner review, `crew_resume_operation` resumes the exact saved operation. The agent can also use
`crew_reconcile_operation` (read-only outcome verification) and `crew_cancel_operation`.

An accepted operation is never repeated to recover a missing response. Definitive non-execution
permits at most three retries after the first attempt. Every attempt obtains and redeems a fresh
permit. Unknown effects remain uncertain; ordinary errors and cancellation do not prove absence
of an effect. Failed provider operations are terminal, including failures after partial effects.

## Host integration

Import from `src/gateway/index.mts` (emitted as `runtime/gateway/index.mjs`):

```typescript
const registry = createSupportedGatewayRegistry();
const { broker, executor, store, catalogue } = await createGateway({
  privateDirectory, // New owner-only Crew data directory, inaccessible to agents
  authorization,
  vault, // Actual #89 vault: metadataForReference + withReplacement + CredentialVault
  admission, // GatewayExecutionAdmission; required shared host admission lease
  connections: {
    get: readConnection, // #89 authoritative trusted ServiceConnection lookup
    listAssigned: assignedConnectionsForCaller,
  },
  resolveConfiguration: registry.resolve, // Trusted host registry; not a runtime tool
  validateCaller, // #88 live session, project/job ownership and lifecycle admission
});
const journal = new GatewayRequestJournal(privateRequestDirectory);
await journal.initialize();
const transportBinding = await attachGatewayMcpTransport({
  broker,
  transport: authenticatedTransport, // #88 owns authentication/listener/session lifetime
  journal,
  authenticatedCaller, // Revalidate the authenticated session on each request
  nativeRequest, // (requestId) => { epoch, requestId: durableNativeRequestKey }
});
// Logical Stop closes the binding and expires its caller session.
await transportBinding.close();
```

`broker` implements `OperationBroker`; `executor` implements `ServiceExecutor`. Direct executor
access, configuration resolution and credential callbacks are trusted host-only entry points.
`createGatewayMcpServer` creates no listener, model session or turn. #88/#89 own transport identity,
isolation and runtime configuration. Never expose its constructor parameters as model JSON or
expose an unauthenticated HTTP/stdio endpoint. Only the gateway endpoint enters the agent config.

`GatewayRequestJournal` commits the authenticated caller/native-request mapping and argument
fingerprint before the broker admits a request. The host must supply the same native key on delivery
retry, and a new epoch when a new MCP client resets its JSON-RPC ID counter. A bare request number
without that namespace cannot establish durable identity. Conflicting arguments under the same key
are rejected. Tool JSON cannot select a new invocation ID through `_meta`; the explicit resume,
reconcile and cancel controls select retained operations that the broker verifies belong to this
caller. Responses include invocation/receipt/approval references in `_meta`.
Ordinary proxied calls have `jobId: null`; trusted hosts can call `broker.invoke` with a validated job.

#89 remains the sole authority for groups, connection assignment, approvals, revocation and vault
storage. `validateCaller` is an additional live-session check, not a substitute for authorization.
`GatewayExecutionAdmission.run(invocation, permit, dispatch)` is mandatory. The host acquires its
shared short admission lock, checks the current caller and closing/final reservation state, redeems
the permit and registers an in-flight lease. It releases that lock before awaiting `dispatch` and
retains the lease until the result settles. Final reservation consults the same gate and leases;
preparation/status/messaging stay responsive during remote I/O. `run` returns either
`{ state: "denied" }` or `{ state: "admitted", result }`. The executor never substitutes a preliminary
`validateCaller` boolean for this boundary, and does not redeem the permit twice. Integrate
`broker.settlement(projectId)` before stopping/replacing the host. Pending approval, in-flight,
uncertain and unflushed authorization-settlement records remain distinguishable.
Individual agent Stop uses `broker.settlement(projectId, caller)` to inspect only
that exact project, agent and session. This observation remains available after
session admission closes; it does not grant authority to execute new work.

Immediately before dispatch, the executor rechecks the prepared connection snapshot
and reuses its scoped vault handle to validate the current credential revision.
Rotation, deletion or refresh during preparation therefore returns proven
non-execution instead of dispatching with cached old bytes. The vault orders its
callback admission with credential mutation and releases that short lock before
awaiting remote I/O. A callback admitted before a later rotation may still finish;
credential replacement does not undo already admitted work.

`GatewayCatalogue` is an observed schema projection. `refresh(connection)` performs discovery
outside access transactions; `hasOperation` only consults that projection and cannot re-enter the
access store. Executor listing updates the projection. Owner setup refreshes before presenting or
saving capabilities, and invalidates it after connection changes. Calls still rediscover and validate
the actual operation schema immediately before admission. Catalogue presence never grants execution.

## Connection setup

1. The owner creates a connection and enters credentials through #89's private setup path.
   Connection records contain references only. Do not reuse personal Codex connector sessions,
   read auth files, or put service secrets into runtime environment/configuration.
2. Select a registered adapter from `registry.setupChoices()` and validate the saved connection with
   `registry.assertConnection`. `createSupportedGatewayRegistry()` supplies Linear and GitHub read-only
   and standard hosted MCP choices, using owner-entered token authentication. Gmail supplies fixed REST-backed read-only or mail/drafts tools with explicit owner OAuth tokens/bundles; see [Gmail setup](GROUP-DERIVED-ACCESS.md). Custom CLI registrations
   belong to trusted host code via `TrustedGatewayRegistry`; no runtime/owner JSON endpoint accepts
   arbitrary commands, config paths or endpoints. Changing endpoint, service or acting identity uses
   a new connection ID so previous grants cannot silently retarget.
3. Assign a group with the connection and appropriate operations, or let the owner review exact access
   requests. Capability names come from `broker.listCapabilities`; never hand-invent permissions.
4. Connect the authenticated runtime transport and preserve request identity. A session refresh may
   be required for changed tool catalogues; it does not grant access or start a model turn here.

### Linear MCP

[Linear's official documentation](https://linear.app/docs/mcp) specifies Streamable HTTP at
`https://mcp.linear.app/mcp`. Its read-only endpoint is `https://mcp.linear.app/mcp/readonly`.
Both OAuth access tokens and Linear API keys can use a Bearer header. The old SSE endpoint is
deprecated. Different workspaces need separate authentication contexts.

A trusted `McpHttpConfiguration` contains `type: "mcp"`, the verified URL and `timeoutMs` (1–120,000).
Production endpoints require HTTPS without credentials/query/fragment. HTTP loopback is available
only through the explicit disposable-fixture option. Redirects and automatic POST replay are disabled.
Token credentials are UTF-8 bearer material in the vault. They are read only inside trusted execution.

OAuth credentials are private JSON bytes containing `access_token`, `refresh_token`, `expires_at`
(Unix milliseconds), and optionally `client_secret`. Configuration separately pins `tokenEndpoint`,
`clientId`, `resource` and `clientAuthentication` (`none` for the supported public/PKCE grant,
or `client_secret_post`). These values must come from verified issuer/client metadata for the
owner-created grant, not an assumed Linear account or a model argument.

The gateway refreshes before dispatch, serializes refresh per connection, checks the exact connection
snapshot, and commits replacements using the vault revision from `metadataForReference`. The vault
creates the scoped handle through `withReplacement`; a fabricated handle is not accepted. Connection
revision and vault revision are independent and never substituted for each other. A durable pending marker prevents
replaying an uncertain token rotation; reauthentication/revision replacement is then required.
[Linear's OAuth documentation](https://linear.app/developers/oauth-2-0-authentication) documents
rotating refresh tokens and client authentication requirements. No interactive browser sign-in,
dynamic registration, OAuth callback UI or automatic audience discovery is implemented in this track;
#89 owner setup must supply a verified grant. This does not claim live Linear OAuth acceptance.

### Guided GitHub and account verification

The [guided owner flow](GUIDED-OWNER-ACCESS.md) uses verified official provider
documentation and fixed endpoints for GitHub PAT and Linear API-key setup. The
owner explicitly chooses a personal or dedicated account. The verification-only
executor discovers the actual MCP catalogue and checks identity using fixed
provider reads; it denies tool execution and cannot assign agents. Draft lookup
is not wired into the runtime gateway. A final revision-checked access transaction
grants only reviewed capabilities and selected assignments. Changed credentials,
cancellation and unknown outcomes preserve the existing vault/admission boundary.

GitHub's [remote server documentation](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md)
defines its standard and read-only hosted endpoints. Its
[host authentication guidance](https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md)
permits owner-provided PATs and does not supply a Crew OAuth registration. These
registrations do not establish arbitrary MCP compatibility or live provider
acceptance. Account intent remains an owner declaration, separate from the actual
provider-verified identity and resource-specific provider authorization.

### Controlled CLI / Lunar boundary

No Lunar executable or authoritative Lunar argv/authentication documentation was available in this
checkout/environment. No Lunar command, endpoint, token scope or installation has been invented.
Configure it only after the owner supplies/verifies the actual supported CLI and credential contract.

`CliConfiguration` pins an absolute executable plus SHA-256, canonical cwd, explicit clean environment,
timeout, credential input, and a small list of actual operations. Each operation has a JSON schema and
trusted `map(arguments) -> { argv, stdin? }`. No shell is used. Secrets can enter only a configured
trusted child environment variable or its stdin, never argv or an agent-facing config file. Credential
stdin cannot be combined with mapped stdin. No ambient HOME/PATH/personal configuration is inherited;
the trusted registry must choose a private HOME and necessary system PATH explicitly when required.

Only trusted, bounded foreground CLIs are supported. Do not register daemon launchers, arbitrary
shells or binaries/scripts writable by agents. Hashing the executable does not protect agent-writable
scripts, libraries or a cwd that loads credentials/configuration; host isolation must protect all of
them. Revocation prevents later admission but cannot undo accepted work.

Cancellation sends SIGTERM only to the owned child and never force-kills or tears down user resources.
Unconfirmed exit stays in-flight/uncertain. A durable per-attempt exit marker prevents a recovered
executor from retrying while a child may have survived a controller crash. Missing/pending markers
block automatic CLI verification/retry; independent owner process evidence is needed for recovery.
There is no automatic process-adoption/forced-cleanup implementation in this track.

## Persistence and protocol limits

- Schema-valid JSON is normalized with explicit defaults, without coercion/removal. Draft-07 and
  2020-12 object schemas are supported; unsupported schemas fail rather than widening access.
  SHA-256 uses RFC 8785 canonical ordering/number/string rules; non-finite values, invalid Unicode,
  cyclic/non-JSON input and excessive size/depth are rejected. Use the exported normalizer in every track.
- Private files are atomic and synchronized, with verified-owner operation locks. Invocation identity,
  original schema/defaults, attempts and compact receipts survive restart. Exact argument bodies remain
  only while needed for unresolved intent. Success bodies are not journalled: native history owns them.
  A duplicate returns the recorded outcome and explains when the response body is no longer available.
  `reconcileOwned` is a trusted lifecycle-only read-only recovery entry point for retained old sessions.
- Unknown/approval intent has no TTL deletion. After explicit cancellation, the broker refuses future
  dispatch. #89's approval record remains its audit responsibility; the shared port has no generic
  access-request cancellation method. The gateway never impersonates an owner denial.
- MCP supports Streamable HTTP initialization, bounded tools discovery, tools/call, progress and
  cancellation. It proxies supported MCP content/structured results, sanitized, under native schemas.
  No legacy SSE/stdio upstream, sampling, elicitation, roots, resource fetching/subscriptions, prompts,
  tasks, arbitrary resumable streams or universal server compatibility. Linked resources are references,
  not permission to fetch them. Pagination is capped at 20 pages / 500 tools; HTTP responses at 512 KiB.
- CLI stdout/stderr each have separate 64 KiB bounds. Overflow discards diagnostic bodies and stays
  uncertain. Credential strings/known encodings and sensitive fields are redacted before truncation;
  raw transport exceptions are never surfaced. This is defense in depth for trusted upstreams, not a
  guarantee against a malicious server deliberately encoding secrets. Host process/filesystem/network
  isolation, environment visibility and OS-vault restrictions remain #89's enforceable boundary.
- A read-only verifier must provide conclusive final execution/non-execution evidence, not a temporary
  absence observation. Generic MCP/CLI errors have no such meaning. Without a verified adapter,
  outcome verification is explicitly unsupported. The gateway never guesses a Lunar/Linear verifier.

## Focused evidence and remaining acceptance

Type-check/build passed. Disposable SDK client → authenticated local MCP upstream and controlled Node
CLI checks passed: catalogue/forwarding, pending approval/reopen/exact resume, immutable identity,
concurrent deduplication, blocked/revoked admission, literal argv, clean environment, credential
redaction, compact receipts, verified retries (two attempts), four-attempt ceiling, executed recovery
(one attempt), unknown retained (one attempt), cross-instance cancellation before dispatch and retained
success during provider outage. Separate synthetic OAuth checks proved one locked refresh/CAS,
stale binding rejection before credential reads and no replay after uncertain rotation.

The initial track checks above used synthetic authorization/vault adapters. The
later real-store walkthrough below closes that composition gap. Current native
and package evidence, together with remaining acceptance limits, is recorded in
[the application composition](AGENT-UNIFIED-COMPOSITION.md#validation-boundary).
No broad regression suite, live Linear/Lunar mutation or personal service
credential was used in these gateway checks.

## Usability integration evidence — 22 October 2026

Owner snapshots use the synchronous `catalogueSnapshot(connection)` callback wired to
`gateway.catalogue.projection(connection)`. This is a local, revision-matched projection
with `available`, `undiscovered` and `failed` states. A successfully discovered empty
catalogue is distinct from a connection never checked. Explicit connection verification
performs remote discovery. Refresh retains the previous same-revision observation during
I/O and atomically publishes the new catalogue; concurrent refreshes share one request,
and invalidated or superseded results cannot republish stale schemas. Authorization uses
the local operation projection without waiting on network work inside a state transaction.

A focused disposable walkthrough now uses the actual `AccessStore`,
`ProjectAuthorizationService` and `EncryptedCredentialVault` with a disposable AES encryption backend.
An MCP SDK client connects through the gateway transport to an authenticated loopback HTTP MCP
upstream. It verifies discovery, exact once approval/resume, session and persistent exact grants,
revocation before later calls, retained duplicate suppression, changed-argument rejection and Stop.
The controlled CLI verifies the pinned binary, literal argv, explicit environment, token injection
inside the trusted executor, redacted output and final admission denial. The request journal is reopened
and proves stable identity plus conflicting replay rejection. Final settlement has no in-flight or
uncertain invocations. macOS adds `__CF_USER_TEXT_ENCODING` in the controlled Node child; no ambient
service environment is inherited.

A separate bounded synthetic OAuth response check uses the real vault and two concurrent refresh
requests: one refresh occurs; vault revision advances from 1 to 2 while connection revision remains 7;
replacement uses the vault-created scoped handle. This closes the earlier synthetic-vault integration
gap. The disposable provider and encryption backend do not establish OS safeStorage, native Codex
isolation, live Linear authentication, Lunar compatibility or packaged lifecycle acceptance. Those
remain separately owned native/provider checks. No personal tokens or live account were accessed.

A later focused review reproduced stale-token dispatch after owner rotation during
admission, plus a vault read of the old record racing a committed rotation. Final
connection/handle validation and locked credential callback admission close both
cases. Real-vault rotation, deletion and refresh checks now reject stale dispatch;
a once grant remains retryable after proven non-execution and is consumed after
the fresh-credential retry. The actual-store MCP/CLI and concurrent OAuth flows
passed again with these changes. Already admitted callbacks may complete after a
later rotation; the lock does not span remote I/O.

The combined access/gateway fixes are integrated as `7e4bb63` (Crew scope choices)
and `dd77143` (credential admission). Their bounded renderer/real-store evidence is
separate from the earlier packaged `5273d9d` lifecycle walkthrough: both idle agents
saved fresh preparation notes, normal Quit exited 0 with native processes absent and
the presentation port closed, and reopen retained chats, notes and completed jobs with
sessions stopped. Private scheduled content stayed hidden before and after reopen.
Help completed after canonical-ID recovery; the later direct incoming-message-ID fix
still needs an app recheck. Native compaction has Foundation/adapter acceptance, while
its desktop check and the ephemeral voice display check remain separate. Real third-party
operation and retained voice provenance remain unverified by these package checks.
