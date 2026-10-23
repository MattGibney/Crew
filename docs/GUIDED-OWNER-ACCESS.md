# Guided owner access — #100 / #101

The owner can connect a Linear, GitHub or Gmail account explicitly for Crew. Choose either
the owner's personal service account or a dedicated agent account, then enter a
credential created for that account. This choice describes the owner's intent;
provider identity verification establishes which account actually authenticated.
ChatGPT subscription sign-in is separate. Crew never imports personal Codex,
browser or service credentials, and connecting an account grants no agent access.

## Supported providers

Linear's [official MCP documentation](https://linear.app/docs/mcp) supports API keys
in Bearer authentication for the standard and read-only hosted MCP endpoints. Its
[API key documentation](https://linear.app/docs/api-and-webhooks) describes limiting
keys by permission and team. The guided path uses an owner-entered API key; account
identity is checked through Linear's authenticated viewer query.

GitHub's [host integration documentation](https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md)
supports an owner-provided personal access token and explains that its remote MCP
server does not supply authentication services. The
[remote server documentation](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md)
defines standard and read-only endpoints. The owner chooses the token's permitted
repositories and permissions at GitHub. Crew checks the authenticated account with
GitHub's user endpoint and discovers the actual MCP catalogue. A successful account
check does not establish access to every repository, organization or operation.

Gmail uses the fixed first-party REST adapter with explicit owner OAuth access-token or credential-bundle input. Read-only and mail/drafts choices keep sending as a separate ungranted capability. See [group-derived access and Gmail setup](GROUP-DERIVED-ACCESS.md) for supported operations, owner-managed Google client requirements, refresh and fixture-only acceptance.

No registered Crew OAuth client, universal MCP compatibility or provider account
creation is assumed. Advanced connection editing still uses trusted registrations;
it cannot install an arbitrary endpoint or command. External connections can be
skipped for local-only setup.

## Embedding and owner API

`ServiceConnectionWizard` and `ServiceConnectionWizardProps` are exported from
`renderer/src/access/index.ts`. Pass the authenticated `AccessOwnerView`, `isOwner`,
`onCommand(name, args)`, `onNotify`, `onComplete(connectionId)`, `onCancel`, and an
optional `onSkip`. Settings uses this same component. Mount it without a changing
snapshot/revision key so typed non-secret choices survive refreshes. Token entry
is transient and cleared after verification submission, cancellation or unmount.

The existing owner command channel exposes:

- `verifyConnectionDraft({requestId, setupChoiceId, name, accountKind, credential,
  connectionId?, expectedRevision?})`. Account kind is `personal` or `dedicated`.
  A new credential enters the existing encrypted vault under a reserved connection
  ID. Existing connection selection uses its exact revision and no new credential.
  Identity and catalogue are verified explicitly. No group, assignment, native
  session or service mutation is created. The returned `OwnerConnectionVerification`
  contains safe evidence, a verification ID and a fifteen-minute review expiry.
- `discardConnectionDraft({requestId})`. This aborts pending verification and
  tombstones a new draft's credential. It leaves existing connections untouched.
  A cancelled request cannot later publish verified state or save access.
- `saveVerifiedConnection({requestId, verificationId, groupSelections,
  agentSelections})`. Group selections carry captured revisions and discovered
  capability IDs. Agent selections carry captured assignment revisions and groups.
  The canonical access-store transaction saves the connection and additive group/
  agent changes together. Unrelated memberships, connections and grants remain.

Verification work runs outside the access-store transaction. Drafts are durable
workflow records in that store, not assigned service connections or a second grant
authority. The runtime gateway cannot look them up. Its separate verification-only
executor has no assigned connections and denies every operation admission.
Provider responses, secrets and exceptions are bounded and sanitized.

The final save rechecks the connection, vault revision, verified catalogue and each
selected group/assignment revision. A proven review conflict returns
`{state: "review_required", reason}` without committing authority. An unknown save
response retains the exact request and payload for an idempotent retry. Saved
receipts return the original connection ID and never restore later revoked access.
Correcting a token or editing provider/account details discards the old draft and
uses a fresh request ID; silently reusing different private input is rejected.

An existing connection needs a stable saved external account ID matching the newly
verified account. A legacy owner-entered label with no stable ID cannot safely be
rebound: create a new connection. Groups are shared; adding capabilities affects
all current and future members. Connection availability derives from these group grants; no individual connection allowlist is required. Explicit approval grants
remain independent. Existing native sessions may need an explicit Restart to
refresh tool discovery; no wizard action starts or restarts them automatically.

## Folder access for onboarding

`environments.prepareFolderAccess({workspaceDirectory, access})` accepts `none`,
`read_only` or `read_write`. Types `FolderAccessPreparation` and
`PreparedFolderAccess` are exported from `src/agents/environments.mts`.

The result is `{access, canonicalPath, policy, requiredGrants}`. `none` validates
the folder and returns a null policy and empty grants. Read-only/read-write
preparation creates and publishes an unassigned policy for the exact canonical
folder and mode. Call it after owner review. Repeating the exact choice reuses
its current policy/revision; conflicting roots, mode or tool allowances fail.
It never changes another mode's policy, assigns agents or starts work.

The returned grants contain group capabilities `environments.read`, `attach` and `execute`
plus the exact policy ID. Onboarding applies them through the existing group and
preset authority. A selected folder or saved policy alone grants no access.
Permissions combine: choosing none or read-only does not revoke an independent
read-write group. Review the effective union before saving; correct only the
chosen agent's memberships, rather than modifying a shared group silently.

The native model keeps its neutral isolated workspace. The discoverable project
route is `environments_read` to find the allowed folder/policy, `environment_action`
with `attach` if needed, then `execute` with the returned environment ID and argv.
Every call rechecks current permissions, policy identity and lifecycle admission.
Read-only/write and outside-folder enforcement belongs to the existing sandboxed
executor. Saving a group is not evidence a model used this route successfully.

## Validation boundaries

Focused checks use disposable accounts, encrypted vault records, loopback MCP
upstreams and project files. No live service mutation, new owner sign-in,
installation, physical microphone or broad regression suite is part of this work.
Exact completed renderer, provider, owner-API and native-folder checks are recorded
in the implementation PR; controlled tool invocation and real native model use
are reported separately. Current-token dispatch, revocation and uncertain-outcome
semantics remain those in [access controls](ACCESS-CONTROLS.md) and
[the gateway](AGENT-GATEWAY.md).

The actual isolated browser flow through the real owner API, setup service,
encrypted vault and controlled provider/MCP passed invalid-to-corrected-token
retry, Back/account edits, selected group/capability/agent save, concurrent group
revision recovery, an identical retry after a lost committed-save response,
in-flight verification cancellation and local-only Skip. The provider fixture
recorded no service tool calls, execution admissions or external destinations.
Separate real-store checks covered assignment conflicts, saved/revoked response
replay, durable reopen and malformed state. Authenticated environment-tool calls
through Foundation and the macOS executor passed selected-folder reads, explicitly
enabled writes, read-only and outside/symlink denial, and immediate grant removal.

The prepared genuine native-model folder harness did not launch: preflight found
another acceptance process using the approved isolated model home. This work
therefore does not yet establish normal-language model selection of the folder
tools or the combined project-onboarding walkthrough. Those checks need an idle
approved model home and the combined candidate; no new sign-in or competing
process was used to manufacture acceptance.
