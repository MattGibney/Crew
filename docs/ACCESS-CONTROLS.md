# Access controls and credentials — Crew #89

Implementation for [#89](https://github.com/MattGibney/Crew/issues/89), against the
[canonical contracts](AGENT-CONTRACTS.md). Integration targets
`codex/unified-agent-platform`. The provider and matching #88 runtime adapter are
integrated into the isolated application candidate; #95 owns its composed walkthrough.
The existing installed app has not been replaced.

## Owner behavior

Create a service connection with its intended acting account and a configured
executor. Credentials are entered through the private owner settings path. Model
access remains native ChatGPT subscription sign-in, separate from service credentials.
To use another account or executor, create another connection and assign it explicitly;
changing an existing connection's identity would silently retarget existing approvals.
Name and credentials can be updated; reconnect is a gateway-owned callback.

Assign connections and permission groups to each agent. Both are needed: assignment
alone permits no operation. A current group capability or an explicit scoped owner
grant supplies authority. Editing a shared group affects later calls for every member.
Skills, help replies and workflow statuses never confer permission.

Review the caller, acting service identity, operation, arguments and justification
before approving. The default scope is the exact operation and arguments. Duration is
chosen separately: once for this logical invocation, until this agent session stops,
or until revoked. Broader requested capabilities show their argument restrictions;
an empty restriction list explicitly means all schema-valid arguments. A persistent
exact search grant does not allow another search or sending a message.

Revocation blocks later admission. An operation already admitted may have executed;
revocation cannot undo it. Other current groups or grants can independently authorize
the same capability. Removing a connection removes all assignments, cancels pending
requests and revokes active grants; its ID cannot be reused. It does not claim to revoke
credentials at the provider. Credential deletion is a separate owner vault operation.

Native access is implemented and available for isolated candidate validation. Owner
browser sign-in was confirmed by native account readback. Preparation still requires
that signed-in state, an exact authenticated Crew tool binding and verified native
model-tool permissions; missing or changed evidence blocks Start. This is not full
combined-app or voice acceptance. See [current evidence and limits](ACCESS-ISOLATION.md).

## Integration entry points

Import runtime implementations from `src/access/index.mts` (emitted as `.mjs`):

| Export                                                      | Responsibility                                                                               |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `AccessStore.create(directory, projectId, ownerUserId)`     | Explicit new private store; rejects an existing directory                                    |
| `AccessStore.open(directory, projectId, ownerUserId)`       | Reopen existing valid state without resetting it                                             |
| `ProjectAuthorizationService(store, identities, catalogue)` | Canonical `AuthorizationService`, protected settings and connection metadata                 |
| `EncryptedCredentialVault(options)`                         | Canonical `CredentialVault`, owner entry/deletion and trusted refresh storage                |
| `createElectronCredentialEncryption(safeStorage)`           | OS-backed Electron encryption adapter, injected after app readiness                          |
| `CodexRuntimeAccessProvider`                                | Verified native model-tool profile and authenticated Crew binding; fails closed on missing or changed evidence |

`AccessIdentitySource.getAgent/getJob` reads #88's authoritative records. The access
store owns membership/connection assignments; project them into `Agent.access` views.
Do not introduce a second editable membership store. `AccessCatalogue.hasOperation`
reads #90's discovered operations. Gateway validates/normalizes JSON and computes the
canonical RFC 8785 fingerprint before calling policy; access does not hash a separate
serialization. IDs and fingerprints arriving from agents are not trusted identities.
Discover capabilities before entering the access-store transaction and supply a trusted
catalogue snapshot. `hasOperation` must not call back into access connection lookups or
gateway discovery that acquires the same store lock; that would deadlock authorization.

The trusted composition binds caller and owner actors from authenticated transport.
Never expose the store, owner administration, vault, permit or settlement methods as
generic model-callable tools. A renderer `isOwner` flag is presentation only. Owner
administration rejects agents even if a group contains an administrative action bit.
Access grants never answer pending native requests. Only the two authenticated Crew
MCP servers skip redundant native tool confirmation; fresh foundation/group/broker
checks still decide dispatch. Native model-tool escalation remains disabled, and genuine
form/URL elicitations require their own supported response flow.

Owner methods: `snapshot`, `saveGroup`, `setAssignments`, `saveConnection`,
`removeConnection`, `saveEnvironmentPolicy`, and the canonical `decide`/`revoke`.
Saves require `expectedRevision` (`null` only for a new record); stale writes fail.
Environment policy records describe intended enforcement and cannot make Start ready.
The gateway reads `getConnection`, writes only health through `observeConnection`, and
agents receive stripped `connectionViews` without credential/configuration references.

Panels are exported by `renderer/src/access/index.ts`; their local integration README
defines callbacks. #88 owns navigation and authenticated callback composition. Populate
capability/setup choices from actual gateway discovery/configuration, not typed endpoint
or shell strings. Keep credential entry off agent routes, logs, local storage and errors.

## Execution and recovery

1. `authorizeAndReserve` verifies current agent/session/job, same-project references,
   assignment and catalogue. It atomically creates a request or reserves one immutable
   invocation. Repeated calls reuse its reservation, never a second execution.
2. `beginAttempt` allows one pending attempt. It creates a unique one-use permit.
3. The trusted executor calls `redeem` immediately before dispatch. This is the durable
   admission point; it rechecks current assignment, groups, grants and session. A stored
   reservation or cached tool list is never admission. A repeated redeem is denied.
4. `settle` records the compact gateway receipt and outcome. Accepted work consumes once
   authority, including accepted failures. Uncertain work remains held. Only conclusive
   non-execution permits the same invocation's next attempt; at most four attempts total.
   Verification may resolve an uncertain attempt to accepted or not executed.
5. `releaseNotExecuted` closes a proven unexecuted reservation. It never restores revoked
   or expired authority, never permits changed input, and does not reset the retry count.

Call `closeSession` before native Stop/Restart or unverifiable recovery, without holding
a foundation lock needed by `getAgent/getJob`. It durably denies all later calls for that
logical session, expires its session grants and prevents queued permit execution. A later
failure to stop the native process does not restore authority. Persistent grants survive,
but callers need a new explicit session. Confirmed transport reconnect may keep a verified
live session; do not revive a session after uncertain crash recovery. In-flight results
can settle after closure/revocation without changing those authority decisions.

One trusted controller owns the private JSON store and serializes all policy mutations.
Writes use a private temporary file, fsync and atomic replacement. Requests/grants/attempts,
closure tombstones and compact audit identities survive process restarts. Runtime validation
rejects malformed or foreign state. A commit failure holds further admission. An abandoned
controller lease blocks reopening: owner recovery must first verify that its controller and
executors have exited, preserve the state, and remove only that stale lease. No age-based
lease removal or automatic reset is provided. Close the store only after owned execution is
settled or durably retained. Filesystem permissions protect against other users; they do not
isolate an agent running as the same OS user.

This small implementation bounds state to 8 MiB and validates record counts. Request/input
arguments remain in the private access state for review and exact retry binding; no chat or
service result transcript is copied. There is no retention/archival UI yet. Reaching a bound
holds writes for owner maintenance, never silently drops uncertain work or grant history.

## Vault boundary

Inject `directory`, `projectId`, `ownerUserId` and a `CredentialEncryptionBackend` into
`EncryptedCredentialVault`. The Electron adapter rejects unavailable encryption and Linux
plaintext/unknown backends. It uses OS-backed `safeStorage` encrypted private records;
there is no plaintext file, CLI argument, environment-variable or API-key fallback.

Owner `storeCredential(actor, connectionId, bytes, expectedRevision)` returns a reference
and **vault revision**, distinct from the service connection revision. Owner replacement
rotates the reference; adopt it in the connection with its own revision check. Clear input
buffers in a finally block. A failed connection save can leave a vault credential awaiting
explicit reconciliation; do not replay a secret write or discard another change. Owner
`removeCredential` retains a revision tombstone and makes old handles/references unusable.

Gateway `metadataForReference(ref)` supplies the current vault revision. Under its one
per-connection refresh lock, the gateway performs OAuth protocol work, creates a scoped
`withReplacement(connectionId, bytes, callback)` handle and calls canonical `replace` with
that expected revision. Refresh preserves the credential reference. There is no second
OAuth authority or owner credential store.

`withCredential(ref, callback)` supplies an opaque, non-serializable handle; `handle.use`
delivers bytes only inside trusted executor code. Handles expire and validate the current
stored revision. Binary/handle results are rejected and callback errors are sanitized.
Trusted code must still avoid copying or encoding secrets into results, logs, argv or env;
these checks cannot sandbox arbitrary callback code. Buffer clearing is best effort because
JavaScript/native encryption use immutable strings. Encryption at rest does not prevent
another process with the same OS authority from using the keychain or reading memory.

## Validation boundary

Typecheck/build and focused disposable checks passed, including actual installed-native
configuration, command filesystem/network/environment enforcement, authenticated MCP
discovery, selected skills and idle same-chat resume across a fresh process. Changed
configuration/path evidence and session revocation during skill resolution fail closed.
These command/configuration checks do not establish every model-tool or realtime path.

Actual Electron safeStorage plus the real vault passed synthetic credential
store/read/rotate, second-process reopen, stale-reference rejection and deletion. This
establishes OS storage integration, not installed-app identity or process isolation.
The owner completed Crew browser sign-in, confirmed through native account readback;
no personal authentication was copied. #88 separately recorded a subscription model
call reaching an allowed synthetic MCP operation and a broker-denied forbidden operation.

The integrated signed-in typed walkthrough now covers manager/worker creation, Start,
steering, queued input, an approved disposable project command and reporting; both jobs
completed. Isolated unsigned packaged launch/Quit/reopen preserved the same chats and
sign-in. Real access/broker components separately passed once/session/persistent grant
and revocation checks against synthetic authenticated endpoints, with credentials confined
to trusted executor use. These do not establish live third-party configuration or operation.
Changed-profile compaction and help/private-work/preparation checks remain in progress;
real voice handoff execution still lacks authoritative public-history provenance. See
[the current composition checkpoint](AGENT-UNIFIED-COMPOSITION.md#validation-boundary)
and [native policy evidence](ACCESS-ISOLATION.md) for the exact limits.


## Unified owner settings and provisioning (#89)

`createAccessOwnerApi` in `src/access/owner-api.mts` binds the authenticated project owner once. The production owner IPC authenticates every call before routing its `snapshot`, `command`, and `subscribe` methods. No actor, credential reference, arbitrary endpoint or executable is accepted from the renderer as authority. The access API checks its configured owner against the access store again on every command. `AccessOwnerView` in `owner-contracts.mts` is a browser-safe DTO; it contains credential references but never private material.

The owner commands are `saveGroup`, `saveAssignment`, `saveConnection`, `removeConnection`, `verifyConnection`, `decideAccess`, `revokeGrant`, `savePreset`, and `setDefaultPreset`. Saves carry the revision captured when editing began. Connection choices are supplied by the trusted gateway registry. Token/SSH material is transient owner input and is converted to a buffer only inside this trusted adapter. Connection identity and access revision are validated before a vault mutation. Vault revision checks remain separate from connection revision checks. The store fails closed on an access-file commit failure; credential-only partial success is never reported as a completed settings save. A failed save may require owner reconnect. Removing a connection first prevents future admission, then tombstones its vault credential. Already admitted operations retain their receipts.

OAuth credential paste is deliberately unsupported. A provider's actual supported authorization handshake must be implemented before exposing its reconnect action. `verifyConnection` is an optional trusted callback, and successful metadata save remains separate from observed provider verification.

`OwnerAccessSettings` mounts the connection, group, assignment, creation preset, pending request and grant panels. Its parent supplies `{snapshot, isOwner, onCommand, onNotify}` through authenticated owner IPC and refreshes snapshot props on `access_changed`. Keep the component mounted across refresh. Editor drafts retain captured revisions and report conflicts without overwriting typed text or automatically applying a stale draft. Credentials are cleared on submit even when saving fails.

Access owns persisted `presets`, `creationDefaults` and assignments. The owner can make an enabled preset the creation default or require explicit selection. A preset contains profile/skill/runtime references and group/connection IDs, never credential values. For first-run setup, the production host supplies `runtimeDefaults: {modelAccessId, configRef}` to `createAccessOwnerApi`; the snapshot exposes those validated non-secret references and the UI can save the first preset with no existing agents and no selected skills. If defaults are absent, first-preset creation stays unavailable with an explicit model-setup message. Existing configured agents remain optional profile/runtime/skill templates, and the owner chooses permissions independently. Current references are checked again when applying the preset. Disabling a preset prevents later creation; editing it does not rewrite existing agents.

`ProjectAuthorizationService` implements the canonical `AgentProvisioning` port. `listPresets` returns enabled presets; `defaultPreset` resolves the current enabled default; `accessFor` produces the authoritative `Agent.access` projection. Foundation creates the pending stopped agent under the shared execution gate, then calls `applyPreset({actor, agentId, presetId, expectedPresetRevision})` and marks the agent usable only after success. Failure must leave the agent unavailable and preserve truthful evidence. The method does not acquire the shared gate recursively. It verifies current creation authority and reporting relationship for manager callers, rejects self/existing-agent changes, and persists only the owner-approved assignment. Foundation owns primary-agent designation and creation lifecycle. `AccessIdentitySource` must read raw foundation records, not an access-projected API that would re-enter the access lock.

The first application commits an immutable receipt for the agent, original creator and exact preset revision in the same access transaction as its assignment. If Foundation loses that completion, its owner recovery retries the original identity. A matching receipt returns the current access projection without applying the preset again, even if the preset has since changed or been disabled. Changed retry identities fail. Subsequent assignment edits and revocations remain authoritative; recovery never restores old permissions. Earlier fresh-project journals without receipts remain readable, but an existing assignment without a matching receipt cannot be inferred to be a successful preset application.

Operation discovery runs outside access-store transactions. Every discovered operation is paired with the connection revision observed before discovery and that revision is rechecked during reservation, attempt, admission, approval or group-save transaction. Gateway catalogue callbacks may therefore read the access connection store without a re-entry deadlock. Discovery is descriptive; current membership, session, grants and one-use permit checks still run inside the committing transaction.

These additions use fresh unified access state with explicit preset/default fields. They do not migrate or reset existing installed application state.


The first-run sequence is host runtime configuration → owner connection/group setup → owner preset/profile/default → Foundation primary-agent creation. The access panel does not require that primary agent to exist first and does not designate the primary agent itself. Runtime references in an owner preset must match the trusted host defaults, an existing configured agent or the unchanged runtime of an existing preset; arbitrary renderer references are rejected.


## Owner catalogue projection

`AccessOwnerApiOptions.catalogueSnapshot(connection: ServiceConnection): { state: "available" | "undiscovered" | "failed"; capabilities: ServiceCapability[] }` is required and synchronous. The production host supplies `gateway.catalogue.projection(connection)`. It reads only the trusted local catalogue cache for that current connection; it must never call remote discovery or refresh. The former asynchronous `capabilities(connectionId)` owner option is removed. Opening or refreshing Settings therefore performs no provider discovery and does not wait on a provider network request.

The owner snapshot preserves the three states in `catalogue`. `available` means a completed current catalogue, including a legitimately empty catalogue; `undiscovered` means it has not yet been discovered for this connection; `failed` means discovery failed. A thrown or malformed local projection is shown as failed, and non-available projections contribute no selectable capabilities. The UI identifies the affected connection and distinguishes not-yet-discovered operations from a failed check. Explicit Verify connection invokes the trusted gateway verification/atomic refresh flow. Discovery state is not access authority.
