# Agent tool gateway — Crew #90

This module implements the gateway track of [#86](https://github.com/MattGibney/Crew/issues/86)
against the merged [shared contracts](AGENT-CONTRACTS.md). It is a composition library for the
new platform, not a replacement of the installed application. No legacy runtime wiring or migration
is included. The implementation PR targets `codex/unified-agent-platform`.

## What an agent sees

Assigned service connections advertise their actual tools with stable, connection-specific names,
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
const { broker, executor, store } = await createGateway({
  privateDirectory, // New owner-only Crew data directory, inaccessible to agents
  authorization,
  vault, // #89 AuthorizationService and CredentialVault
  connections: {
    get: readConnection, // #89 authoritative trusted ServiceConnection lookup
    listAssigned: assignedConnectionsForCaller,
  },
  resolveConfiguration, // Trusted host registry; not a runtime tool
  validateCaller, // #88 live session, project/job ownership and lifecycle admission
});
const server = createGatewayMcpServer({
  broker,
  authenticatedCaller, // Revalidate the authenticated session on each request
  invocationIdForRequest, // Durable host/native request identity across delivery retries
});
await server.connect(authenticatedTransport);
```

`broker` implements `OperationBroker`; `executor` implements `ServiceExecutor`. Direct executor
access, configuration resolution and credential callbacks are trusted host-only entry points.
`createGatewayMcpServer` creates no listener, model session or turn. #88/#89 own transport identity,
isolation and runtime configuration. Never expose its constructor parameters as model JSON or
expose an unauthenticated HTTP/stdio endpoint. Only the gateway endpoint enters the agent config.

The host must persist the native/tool request-to-invocation mapping before admitting a request and
reuse it after reconnect. MCP `_meta["crew/invocationId"]` can explicitly select a retained ID;
it cannot change its caller/session/job/connection/operation/normalized arguments. A new operation
needs a new identity. Responses include invocation/receipt/approval references in `_meta`.
Ordinary proxied calls have `jobId: null`; trusted hosts can call `broker.invoke` with a validated job.

#89 remains the sole authority for groups, connection assignment, approvals, revocation and vault
storage. `validateCaller` is an additional live-session check, not a substitute for authorization.
The final #88 execution reservation must share #89's atomic `redeem` admission barrier; an async
boolean check alone cannot make a global Quit/update reservation atomic. Integrate
`broker.settlement(projectId)` before stopping/replacing the host. Pending approval, in-flight,
uncertain and unflushed authorization-settlement records remain distinguishable.

## Connection setup

1. The owner creates a connection and enters credentials through #89's private setup path.
   Connection records contain references only. Do not reuse personal Codex connector sessions,
   read auth files, or put service secrets into runtime environment/configuration.
2. Register immutable trusted executor configuration, then store its reference in that connection.
   Changing endpoints, client identity or executable mappings requires a new configuration reference
   and a connection revision. The registry must be inaccessible to agent filesystem/tool access.
3. Assign the connection and appropriate group capability, or let the owner review exact access
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
snapshot, and commits replacements using vault revision CAS. A durable pending marker prevents
replaying an uncertain token rotation; reauthentication/revision replacement is then required.
[Linear's OAuth documentation](https://linear.app/developers/oauth-2-0-authentication) documents
rotating refresh tokens and client authentication requirements. No interactive browser sign-in,
dynamic registration, OAuth callback UI or automatic audience discovery is implemented in this track;
#89 owner setup must supply a verified grant. This does not claim live Linear OAuth acceptance.

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

These checks used synthetic authorization/vault adapters, not #89's final store or genuine provider
credentials. No broad test coverage/full regression suite, physical microphone, installed application,
native Codex conversation, live Linear/Lunar mutation or personal service credential was used.
Parent #86 must finish the integrated #88/#89 approval and same-native-thread result flow, once/session/
persistent policy acceptance, actual isolation evidence, native/package lifecycle and real provider setup.
