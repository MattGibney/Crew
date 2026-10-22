# Native access and project execution — #89 / #90

`CodexRuntimeAccessProvider.open` launches the pinned Codex app-server as a trusted host
with a native model-tool permission profile. It checks the actual effective native
configuration and uses native `account/read` to distinguish
signed-in subscription access from a required owner action. It never copies personal
authentication, reads tokens, or supplies an API-key fallback. Empty construction
remains blocked. A new home or an owner setting alone cannot produce `ready`.

This replacement is draft implementation pending #88's actual native handoff proof and
the composed application walkthrough. Isolated candidate validation is authorized;
configuration and disposable command checks do not establish complete model-tool isolation.

## Owner setup

The production composition supplies a fresh, private Crew native directory, the verified
Codex executable, its exact runtime-config reference, authenticated session gateway
bindings, and selected immutable project skill paths. The initial tested CLI version is
`0.163.0-alpha.11`; another version requires current validation and otherwise fails closed.

In Subscription settings, the owner selects **Sign in with ChatGPT**. The owner-only
`beginSignIn()` API uses native `account/login/start` with `chatgpt`, returning
`{type: "browser", loginId, authorizationUrl}`. The URL must use an allowed official
HTTPS origin and the expected loopback callback. The owner opens that link and completes
the browser ceremony; Crew checks `subscriptionStatus()` afterward. `cancelSignIn()`
cancels only this pending Crew login. No personal account is logged out or replaced.
Authorization URLs are transient owner UI state, never tickets, logs or repository content.

Only explicit owner browser sign-in requests the callback listener at `localhost:1455`.
The pinned host owns callback verification and credential persistence; Crew never
parses authorization codes or tokens. A busy callback port fails startup without killing
another process. Browser startup/cancellation does not establish completed authentication.

While signed out, `subscriptionStatus()` includes optional `signIn` state: `pending`
with a null reason, or `failed` with a fixed safe reason, stage and numeric RPC code
when available. Failure remains visible across status refreshes until a new attempt or
explicit cancellation. Missing `signIn` means no active or retained attempt. The owner
UI clears its transient link and waiting state when the attempt fails or disappears.
Stages distinguish initialization, configuration, request, response, completion and
transport; arbitrary native errors are never returned. A matching login-completion
failure closes only the owned attempt. Explicit cancellation is tracked by generation,
not inferred from error text. Completion success alone does not establish sign-in;
a fresh account read must confirm the stored ChatGPT account.

Authentication is stored by Codex in its existing Crew native home using its supported file
credential store. Native account state is distinct from Crew service connections and
the encrypted vault. Subscription availability is not model entitlement: a real completed
turn is still needed to verify inference. In the coordinated 22 October 2026 owner run,
the UI track confirmed a fresh native `account/read` reported signed in after the owner
completed browser OAuth. This establishes the owner sign-in path, not a subscription-backed
model response or the proposed native model-tool permission boundary. The storage marker
and `crew.codex.broker-only.v1` configuration reference remain compatible; this change
does not replace, import, reset or copy the existing authentication directory.

## Confirmed native process shutdown

Every access probe and sign-in app-server is retained until its exit is observed.
Ending stdin is a stop request, not exit evidence. If the native peer does not confirm
exit within its bounded close wait, cancellation reports that uncertainty and further
launches/sign-in are blocked. The same native home also remains blocked if initial
provider opening fails with an unfinished process. Confirmed later exit clears that
in-process hold; Crew never force-stops it or discards its reference to retry silently.

Provider close attempts every tool-binding revocation and model-egress close even when
a native process remains alive, then reports the pending owned process. A later close
can confirm completion. Cancelling during initial sign-in RPC setup waits for that exact
attempt to stop before permitting another attempt. This tracks processes owned by the
current controller; it does not claim persisted crash adoption or native installation
lifecycle acceptance.

## Native boundary

The previous outer Seatbelt policy prevented native nested sandbox helpers from loading
a resumed local environment. The provider now launches the exact pinned executable
directly. The host is trusted with its own model authentication; native named permissions
constrain model tools. Host RPCs such as filesystem readers and process spawning are not
model-safe interfaces and must never be exposed through Crew tools. The retained model
proxy is a fixed OpenAI transport route, not an operating-system boundary around this
trusted host.

Each launch gets one `crew-model-v2-<roots-hash>` profile extending `:read-only`, with
filesystem default deny, minimal system reads, explicit personal-home/native-root deny,
and read access only to its neutral workspace and selected immutable skill directories.
Network is disabled and global native escalation is `never`. Shell/JS/apps/plugins and
other unrelated surfaces remain disabled, but feature flags alone are not enforcement.
The host receives an explicit environment; model commands inherit none and have no
explicit variable injection. Crew's session bearer identifies only the authenticated
session and does not contain an upstream provider credential.

The verifier compares the complete effective profile: exact filesystem entries, no
extra profiles, no network/socket allowances, no environment overrides and no escalation.
Native normalized null defaults remain null. Canonical private storage directories and
narrow skill roots are checked before launch. The resolver repeats the managed store's
exact-revision/resource-manifest verification and rejects changed paths; private storage
directory identities must remain the same. It rechecks session revocation after these
asynchronous reads. Existing auth files are neither read nor rewritten by Crew. TLS
retains the supported public CA bundle setting. New `native-permissions-evidence.json`
records profile checks separately from historical outer-boundary evidence.

The trusted resolver returns `nativePermissions: { profileId, approvalPolicy: "never" }`.
#88 selects that profile explicitly on start/resume/turn requests and verifies the
returned profile, approval policy and exact local workspace. It must fail closed on
missing or changed evidence. This replaces the earlier empty-environment requirement;
the local environment is the neutral read-only workspace, never a real project root.
Before discovery, selected skill roots are still sent through `skills/extraRoots/set`.
Real project work remains behind the separately authorized executor below.

## Actual project work

`runMacWorkspaceCommand(policy, input)` is the trusted executor contribution consumed by
#88's `AgentEnvironmentService`. It genuinely reads, edits and executes project commands
inside a separately sandboxed workspace. The environment authority resolves the current
owner assignment, filesystem grants and tool installations before invoking it. Model
arguments cannot supply host policy roots or executable directories.

The executor receives an explicit command string (passed as one shell argument), relative
working directory and bounded timeout. It uses a fresh empty HOME, no inherited secrets,
no native subscription directory and no broker vault. Stdout and stderr have separate
32 KiB limits. It distinguishes launch failure, root command exit and timeout; a timeout
may already have produced effects and is never evidence for automatic retry. Root command
exit does not prove independently launched project resources were removed.

Results include `processesSettled` and `processEvidenceRef`. The executor records the
actual detached process group, root exit and observed descendant PID/start/command hashes
in a private receipt outside writable command scratch. It confirms fresh group and
observed-process absence before setting `processesSettled: true`. Foreground completion
can therefore release an execution reservation while background work remains unsettled.
Workspace and tool roots may not overlap this private directory.

The host persists every returned reference, including both creation and registration
commands for a managed worktree. It can later call
`reconcileMacWorkspaceCommand(privateDirectory, processEvidenceRef)` and use a fresh
confirmed result to settle the original operation. Reconciliation reads evidence and OS
process state only: it neither repeats commands nor sends stop signals. Missing, unsafe,
incomplete or malformed evidence stays unsettled; retain the original reference on failure.
The proof covers the launched group and observed descendants. It does not prove arbitrary
unobserved daemonization or that databases, containers or other independent resources were
removed. Those require their own explicit project lifecycle evidence.

The initial executor has no network access. Package downloads, networked project setup,
container sockets, development-server port binding and additional runtime libraries need
explicit supported environment policy before they can work. Do not present the narrow
local command proof as acceptance of an arbitrary existing project setup. No project
source patch or Crew-specific integration is required for local file/edit/test operations.

## Composition API

```ts
const access = await CodexRuntimeAccessProvider.open({
  directory,
  projectId,
  executable,
  runtimeConfigRef: "crew.codex.broker-only.v1",
  gatewayFor: async (caller) => ({
    url: gatewayUrl,
    foundationUrl,
    bearerToken,
    bindingRef,
    release,
  }),
  resolveSkills: async (skills) => exactSelectedSkillPaths,
});
// Inject access.prepare/release and access.resolveLaunch into the one #88 host.
// Mount subscriptionStatus/beginSignIn/cancelSignIn on authenticated owner ingress.
// For retained history, first verify the saved agent/thread identity in the host,
// then call access.resolveHistoryLaunch(binding). It opens no service session.
// close only after the host has settled sessions and reserved final shutdown.
```

Native MCP configuration contains exactly `crew` for foundation actions/skills and
`services` for the service gateway. Both exact URLs and required bearer-token settings
are read back from the native process before preparation succeeds. A single gateway
endpoint alone does not expose agent management or selected skills.

Only these two authenticated servers set `default_tools_approval_mode="approve"`.
This supported native setting skips a redundant Codex MCP confirmation before Crew
dispatch; it does not grant a Crew capability. Foundation authorization and the
service broker still check the current caller, session, group or explicit grant at
dispatch. It does not relax the native profile's `never` escalation policy. Preparation verifies
the exact server set, approval defaults and absence of per-tool overrides. Owner login
and retained-history launches configure no MCP servers.

The setting applies to new native launches, not an already pending elicitation.
Never answer or replay a pending owner request to apply it. Real MCP forms and URL
elicitations remain separate supported-UI work; `approve` is not permission to fabricate
their responses or enable unrelated native tools.

The gateway binding must be caller/session authenticated, revocable on Stop and owned by
the host. The host shares one admission gate across runtime, environment and gateway
dispatch and final shutdown. It registers admitted work under a short gate and performs
network/command I/O outside the mutex. Access-store projections remain the policy authority.

## Evidence and remaining acceptance

Historical macOS checks below exercised the earlier outer policy; they are not current
trusted-host containment claims:
native configuration/account read; permitted owned file read; denied synthetic outside
service file; denied descendant read; other-process denial; keychain-list denial; denied
host TCP and Unix socket access; allowed TLS to the model host and denied other-domain
proxy/direct host access. No owner credential values were read. Private evidence is
written to the owned native directory, not this repository.

Actual device-login checks now exercise public begin/status/cancel/retry with the fixed
CA environment. Cancellation clears pending status only alongside confirmed peer exit.
A controlled native cancellation delivered as a completion event (without calling the
provider's cancel method) verifies persistent failed-completion status, owned peer exit
and a permitted new attempt. Removing the CA setting only in a disposable diagnostic
launch reproduces the original request failure and retains stage `request` / RPC code
`-32603` across polling and retry. No owner authorization was completed or token values
read; these checks stop at code issuance and cancellation.

The later owner device-code ceremony reported browser success while the native process
remained active, exchanged network bytes and had no observed credential file or completion
event. Its polling/persistence cause was not established. The authorized corrective route
uses ordinary browser OAuth with the narrow callback permission described above; it is not
a claim that the device-code completion problem was diagnosed. Preserve any existing attempt
until the replacement app is ready and the owner coordinates cancellation/retry.

The browser replacement passed actual public-provider begin/status/cancel/close in a
fresh disposable native home. Its only listener was `127.0.0.1:1455`; original boundary
canaries still passed under the login policy, and normal owner/model policies retained
no inbound permission. The authorization URL passed the same official-origin/length
constraints as the UI. No browser was opened or authentication completed by that check.

The separate workspace executor inspected a disposable script, edited it and ran its test
successfully. It also denied an outside canary and read-only mutation, showed a clean
environment, and reported timeout as possibly executed. These are actual process/file
checks, not a completed agent-mediated project walkthrough.

Actual process-settlement checks confirm foreground completion, a background sleep that
blocks settlement, and later read-only confirmation after natural exit. Invalid evidence,
private-root overlap and attempted receipt tampering fail closed. A component composition
using the real access store, environment service, admission gate and sandbox executor
confirms that foreground work clears execution settlement, a held final reservation
rejects new commands, and running background work remains a settlement blocker. That check
uses a controlled session identity; it does not establish a native agent turn.

The installed native process also discovered two controlled SDK MCP servers using
the exact foundation and service URLs with bearer authentication. A mismatched expected
foundation URL failed configuration verification. This proves native transport discovery;
the controlled endpoint catalogue is not the composed application's live tool catalogue.

Before the native-owned replacement, installed CLI 0.163.0-alpha.11 read back
`default_tools_approval_mode="approve"` for both endpoints and retained global
`approval_policy="on-request"`. Both authenticated endpoints discovered successfully;
the verifier rejected missing approval mode, a per-tool override and a third server.
This was a disposable unsigned-in configuration/transport check. Separately, #88
reported an actual subscription model call with per-tool `approval_mode="approve"`:
an allowed synthetic call reached Crew and a forbidden call was rejected by its broker
while global policy remained `never`. That establishes the narrow approval-mode
semantics, not final composed-app or server-default model acceptance.

The current native-owned draft passed a separate unsigned-in/no-model check using the
actual provider and installed runtime. Commands read the neutral workspace and selected
skill, denied outside/native-private reads and workspace writes, inherited no synthetic
tokens and failed to reach a loopback canary (zero received requests). Skill discovery
and idle start, warm resume and fresh-process same-chat resume retained the exact profile,
`never` approval and neutral local workspace, with zero turns. Twelve altered config
readbacks were rejected. Replaced/symlinked workspace and skill paths and a mismatched
managed directory reference were rejected. All owned peers exited. These are native
command/configuration checks, not a claim that every model tool or realtime handoff is
contained. #88 owns the real-model handoff evidence; #95 validates the isolated composed
candidate. Final acceptance remains pending.

A separate controlled resolver-state check emitted the exact trusted permissions for
matched state, then denied launch when that session was released during asynchronous
skill validation. It used a seeded binding and is not authenticated preparation evidence.

Actual Electron 44.9.2 safeStorage plus the real vault passed synthetic store/read/rotate,
second-process reopen, stale-reference denial and deletion. This proves host OS storage
integration, not signed/installed Crew application identity or process isolation.

Still required for the full #86 acceptance: owner sign-in and real inference; same-thread
Start/Stop/Restart/profile application through the composed app; authenticated native Crew
MCP; real agent-mediated project work; actual configured service verification; and packaged
launch/Quit/reopen. Physical microphone capture and signed automatic updates were not tested.

References: [native authentication](https://learn.chatgpt.com/docs/auth),
[app-server protocol](https://learn.chatgpt.com/docs/app-server),
[configuration](https://learn.chatgpt.com/docs/config-file/config-reference), and the
installed CLI's generated experimental protocol schema. Native token-import variants
marked internal-only are not used.

The certificate setting is documented in [native environment variables](https://learn.chatgpt.com/docs/config-file/environment-variables).
