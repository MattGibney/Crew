# Runtime access isolation — Crew #89

`CodexRuntimeAccessProvider` in [`src/access/runtime-access.mts`](../src/access/runtime-access.mts)
implements the canonical [`RuntimeAccessProvider`](./AGENT-CONTRACTS.md) port. It currently
blocks every preparation. There is no verified route in this implementation that combines
ChatGPT subscription sign-in with the required exclusion of personal service credentials.
This is an implementation limitation, not a claim that Codex or OS isolation cannot support
such a route.

The rest of the access system can store policy, connections and grants independently. Those
records cannot make native execution safe or authorize an alternate unisolated launch. #88
must show the blocked reason and limitations before starting or resuming the agent runtime.
#86 owns final composition and combined acceptance; this module does not change the legacy
manager/worker launch path.

## Behavior and integration

- Construct `new CodexRuntimeAccessProvider()` and inject it as the canonical port.
- `prepare(caller, configuration)` returns `state: "blocked"` and a fresh limitations array.
  It never returns a binding, evidence reference or misleading verification timestamp.
- `release(caller)` is an idempotent no-op because this provider allocates nothing. It does
  not release another provider's resources, stop an agent or alter a permission session.
- Both methods leave configuration, auth, history, files, processes and native approvals
  untouched. Inputs are not echoed into diagnostics or treated as evidence. No reference
  is resolved, and no caller-supplied flag or attestation can enable execution.

Existing native approvals remain separate from Crew access grants. Neither approval system
can be treated as proof that the other system's boundary is enforced.

## Evidence reviewed on 22 October 2026

The installed bundled macOS CLI reported `codex-cli 0.163.0-alpha.11`. Its `--help`,
`app-server --help`, `sandbox --help` and experimental app-server JSON schema were inspected
using an empty temporary home/Codex home, a minimal explicit child environment, bounded
process lifetimes and cleanup. Schema generation succeeded and created no thread or turn.
No personal configuration, auth file, history or keychain item was inspected. No login,
model call, app-server listener or service connection was started. Temporary output was
removed. This inspection establishes available interfaces only, not enforcement.

An initial obsolete `sandbox macos --help` probe was interpreted by this CLI as a request
to execute a command named `macos`; it exited 71 because that command did not exist. It
provides no isolation evidence. The successful `sandbox --help` probe identified the
current command syntax; no sandbox workload was run.

The version-specific generated schema establishes:

| Interface                                  | Observed support                                                             | Boundary of the evidence                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `LoginAccountParams`                       | `chatgpt` and `chatgptDeviceCode` native login variants                      | Neither sign-in nor entitlement was exercised                                |
| `LoginAccountParams.chatgptAuthTokens`     | Marked unstable and **for OpenAI internal use only; do not use**             | Crew must not use this as an auth-copy or token-extraction route             |
| `ThreadStartParams` / `ThreadResumeParams` | `permissions`, `sandbox`, configuration overrides and native approval fields | A named profile and acknowledgement alone cannot prove containment           |
| `ThreadStartParams.environments`           | Empty selection disables environment access unless a turn overrides it       | Does not establish exclusion of other tool surfaces or durable enforcement   |
| `ConfigLayerSource`                        | Packaged, managed, enterprise, user, project and session layers              | A different user config directory does not remove every configuration source |

Official OpenAI documentation confirms native subscription sign-in and configurable auth
storage, including process-memory storage. Those are potential building blocks; selecting
storage does not prove that service credentials or host capabilities are inaccessible.
[Authentication](https://learn.chatgpt.com/docs/auth)

Named profiles can deny filesystem reads, filter shell environment inheritance and control
command networking. The network rules do not cover apps, MCP or hosted search, and proxy
rules require active enforcement. These knobs require observation across all execution
surfaces. [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)

Full approved sandbox escalation can bypass command-proxy restrictions. An outer boundary
must therefore continue to protect service authority while normal native approvals remain
available. [Agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security)

Current web documentation describes externally managed ChatGPT tokens as an experimental
host-owned auth mode, but the installed schema above expressly reserves that variant for
internal use. This implementation follows the narrower installed support boundary. It
does not extract credentials from the user's existing session.
[App-server authentication](https://learn.chatgpt.com/docs/app-server#3c-log-in-with-externally-managed-chatgpt-tokens-chatgptauthtokens)

The separately documented Sign in with ChatGPT plan-usage integration requires its own
owner-authorized OAuth lifecycle; its existence does not establish Crew client eligibility,
installed-runtime compatibility or isolation. It was reviewed as an alternative, not used.
[Plan-usage app-server integration](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)

## What remains unverified

1. **Filesystem, processes and OS credentials.** No containment implementation yet excludes
   personal homes, shared mounts, readable credential files, host keychain services, process
   inspection, Git credential helpers, SSH configuration and agent sockets. A private
   worktree or a new `CODEX_HOME` is configuration separation, not this boundary.
2. **Configuration and tool discovery.** No observed route excludes personal MCP/OAuth,
   apps/plugins, shell startup and CLI state across effective configuration layers and
   resumed threads. Environment filtering cannot establish filesystem or keychain denial.
3. **Model access.** Native subscription sign-in must be established within the chosen
   boundary through a supported owner sign-in flow. An opaque `signInRef`, catalog entry
   or existing login elsewhere is insufficient. No API-key fallback or copied auth.
4. **Direct operations and approvals.** The runtime must reach its authenticated gateway
   while arbitrary commands and other tool surfaces cannot bypass it using personal or
   Crew upstream credentials. Native escalation must remain inside an outer service
   isolation boundary, with exact caller/session correlation and revocation.

## Next implementation decision

Evaluate a separately provisioned OS/VM execution boundary with its own supported native
ChatGPT sign-in, no personal host mounts or forwarded credential/agent sockets, and a
session-bound Crew gateway. This is a candidate architecture requiring its own reviewed
scope and evidence, not a selected or provisioned backend. Do not provision accounts,
change the installed app, alter global Codex settings or trigger sign-in merely to make
the blocked result disappear.

A future provider must observe the exact runtime version, effective policy, owned boundary,
configuration revision and caller/session before returning `ready`. Use synthetic canary
credentials to verify denied personal-file/env/helper/socket/keychain/process access and
an allowed broker operation. Cover ordinary commands, approved commands, tool discovery,
thread resume and recovery. Verify owner-authorized subscription access separately;
never probe personal secret values. Preserve native approvals and produce inspectable,
sanitized evidence. Missing, stale or ambiguous proof stays blocked.

Releasing a future binding must act only on resources that provider owns. It must not stop
project services, delete worktrees or terminate detached work as an isolation side effect.

Validation for this module is a focused compile and disposable blocked-result check.
No authenticated end-to-end flow, native isolation or model access is claimed by those
checks; combined runtime acceptance remains pending under #86.
