# Native access and project execution — #89 / #90

`CodexRuntimeAccessProvider.open` now implements a concrete macOS process boundary.
It starts the installed Codex app-server through an outer Seatbelt policy, checks the
actual effective native configuration, and uses native `account/read` to distinguish
signed-in subscription access from a required owner action. It never copies personal
authentication, reads tokens, or supplies an API-key fallback. Empty construction
remains blocked. A new home or an owner setting alone cannot produce `ready`.

## Owner setup

The production composition supplies a fresh, private Crew native directory, the verified
Codex executable, its exact runtime-config reference, authenticated session gateway
bindings, and selected immutable project skill paths. The initial tested CLI version is
`0.163.0-alpha.11`; another version requires current validation and otherwise fails closed.

In Subscription settings, the owner selects **Sign in with ChatGPT**. The owner-only
`beginSignIn()` API uses native `account/login/start` with `chatgptDeviceCode`, returning
the official verification URL and one-time user code. The owner completes that ceremony;
Crew checks `subscriptionStatus()` afterward. `cancelSignIn()` cancels only this pending
Crew login. No personal account is logged out or replaced. Codes and login URLs are
transient owner UI state, never tickets, logs or repository content.

Authentication is stored by Codex in the new native home using its supported file
credential store. Native account state is distinct from Crew service connections and
the encrypted vault. Subscription availability is not model entitlement: a real completed
turn is still needed to verify inference. Current validation reaches `sign_in_required`;
it does **not** claim a completed owner sign-in or subscription-backed response.

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

`native-boundary.mts` denies access by default and permits only system runtime files,
the owned native directory, and exact selected skill directories. Personal homes,
service configuration, keychain services, other processes and host Unix sockets are
outside the allowed boundary. Every descendant retains the outer policy, including
commands that would otherwise receive native escalation.

The only network destinations are exact loopback ports for the session's authenticated
Crew foundation and service MCP endpoints and a model-transport proxy. That proxy only accepts TLS CONNECT to
the fixed OpenAI host catalogue, rejects private DNS answers, pins the resolved public
address, and never decrypts TLS or injects a credential. It is not a generic service proxy.
The explicit child environment contains no inherited service tokens, SSH agent socket,
Git helper configuration or personal CLI configuration. The Crew session token authorizes
only that native session at the Crew gateway; it is not a provider secret.

Native TLS explicitly uses the macOS public CA bundle at `/private/etc/ssl/cert.pem`
through Codex's supported `CODEX_CA_CERTIFICATE` environment setting. The isolated
process cannot rely on personal keychain certificate discovery. An actual device-login
request failed after successful proxy CONNECT without this setting and started with it;
polling, cancellation and confirmed peer exit also passed. The policy and host allowlist
remain unchanged, and the existing keychain/outside-file/network denials still pass.
This verifies device-code issuance, not owner completion or token exchange.

The native model process has no project mounts or direct shell/JS tools. The adapter
must also pass `environments: []` on supported native thread-start and turn requests so
native filesystem tools have no selected environment, and verify the observed selection.
The inspected resume schema does not support this field: passing an ignored field is
not enforcement, and a resumed default local environment must fail closed until a
supported disabling route is verified. A removed feature flag is not enforcement.
Before skill discovery, the adapter sets the exact selected roots through supported
`skills/extraRoots/set`; personal or repository skill roots are not imported.

This restricted native route is a **bring-up and communication boundary**, not acceptance
of full project work. The two execution boundaries below must be composed together.

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

The gateway binding must be caller/session authenticated, revocable on Stop and owned by
the host. The host shares one admission gate across runtime, environment and gateway
dispatch and final shutdown. It registers admitted work under a short gate and performs
network/command I/O outside the mutex. Access-store projections remain the policy authority.

## Evidence and remaining acceptance

On macOS, bounded disposable checks exercised the actual installed CLI and outer policy:
native configuration/account read; permitted owned file read; denied synthetic outside
service file; denied descendant read; other-process denial; keychain-list denial; denied
host TCP and Unix socket access; allowed TLS to the model host and denied other-domain
proxy/direct host access. No owner credential values were read. Private evidence is
written to the owned native directory, not this repository.

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
