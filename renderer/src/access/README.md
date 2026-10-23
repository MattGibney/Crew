# Access panels — GH-89 integration boundary

#101 also exports `ServiceConnectionWizard` and `ServiceConnectionWizardProps`
from `index.ts` for Settings and project/agent onboarding. Pass the live authenticated
`snapshot`, `isOwner`, `onCommand`, `onNotify`, `onComplete(connectionId)`,
`onCancel`, and optional `onSkip`. Owner command names are `verifyConnectionDraft`,
`discardConnectionDraft` and `saveVerifiedConnection`; the desktop channel prefixes
these with `access.`. The wizard never calls provider endpoints itself. See
[`GUIDED-OWNER-ACCESS.md`](../../../docs/GUIDED-OWNER-ACCESS.md) for exact API,
revision, cancellation and retry semantics and the #100 folder preparation contract.

Import the five contributed React panels from `renderer/src/access/index.ts`.
#88 owns Settings/navigation composition; these panels do not mount themselves, fetch data,
call a controller, start sessions, authenticate a provider, or change model access.
All domain data is imported from `src/agents/contracts.mts`; local types describe form inputs
and callbacks only. The project supplied to each panel must already be selected and scoped.

## Owner transport and data

Every panel accepts `isOwner` and `onNotify`. A false owner flag renders only an owner-required
message and unmounts editors. This is presentation gating, **not authentication**. Mount the
panels only behind the private owner control plane and authenticate every mutation there.
The transport derives the human actor; none of the form callbacks accepts an actor supplied
by an agent. Never register these callbacks as model-facing tools.

Supply current canonical groups, connection records/views, requests, grants and agents.
In particular, compose each `Agent.access` from #89's current assignment record and its
`Agent.runtime.session` from #88's verified native-session observations. The per-agent panel's
`assignmentRevision` is the assignment record revision, not the agent profile revision.
Snapshot changes retain an open editor's captured revision and draft. A successful callback
must refresh the affected canonical snapshot before resolving; concurrent changes must fail
server-side revision checks. Do not use optimistic UI state as authority.

Errors shown by these panels are fixed local messages. Callback exception messages are never
rendered, logged or forwarded: backend errors may include private data. `onNotify` connects to
the existing dismissible Settings toast. Failed forms retain non-secret drafts for correction.
The parent can separately show safe, typed backend status/recovery guidance; never raw errors.

## Callback adaptation

| Panel                     | Inputs and callbacks                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PermissionGroupsPanel`   | `groups`, canonical `connections`, actual discovered `capabilities`, typed `crewCapabilities`, `agents`; `onSave({id, expectedRevision, draft})`. Allocate canonical identity/project/revision metadata in the owner store. Service capability IDs are selected from discovery, not invented. Existing unavailable IDs can only be retained or removed. Approved workspaces are supplied with revision-matched project policy records and human-readable paths/access descriptions. The owner can add/remove these policies; unavailable existing IDs remain retained until explicitly removed. Folder approval stays in Workspace settings. |
| `AgentAccessPanel`        | One canonical `agent`, `assignmentRevision`, available `groups`/`connections`; `onSave({agentId, expectedRevision, permissionGroupIds, serviceConnectionIds})`. Call the assignment store using the authenticated owner actor and captured revision.                                                                                                                                                                                                                        |
| `ServiceConnectionsPanel` | Canonical owner `connections`, trusted gateway `setupChoices`; `onSave({id, expectedRevision, draft, credential})`, `onRemove(id, expectedRevision)`, optional `onReconnect(id, expectedRevision)`. Labels and setup IDs are UI choices; transport/service/authentication fields retain canonical types. Do not accept arbitrary shell commands/configuration paths. Allocate metadata in the owner store; reset verification when identity/authentication changes.         |
| `AccessRequestsPanel`     | `requests`, current `agents`/`connections`, discovered `capabilities`; `onDecide(requestId, decision)` where `decision` is directly derived from `AuthorizationService.decide`. The owner adapter calls `decide` with its authenticated human actor.                                                                                                                                                                                                                        |
| `ApprovalGrantsPanel`     | Current `grants`, `groups`, `agents`, `connections`; `onRevoke(grantId, reason)`, adapted to the protected authorization service with the authenticated owner actor.                                                                                                                                                                                                                                                                                                        |

Private connection credentials are transient owner-entry strings, never a domain DTO or vault
reference input. Convert to bytes only inside #89's private callback. Pass through the vault's
revision-checked storage path; create/update the connection record with the resulting opaque
reference. Treat record plus credential mutation as a coordinated owner operation and resolve
only when its outcome is known. Do not report success after a partial save, emit credential
material in errors/logs, persist it in browser storage, or return it to agents. Clearing the form
is UI lifetime control, not a claim to erase every JavaScript string copy from memory.

The field is cleared immediately on submission (including failures), authentication/adapter
changes, cancellation and unmount. A blank credential retains the existing credential only
when the authentication method is unchanged. `none` means no authentication; switching methods
must be handled explicitly by the owner store. OAuth material is never pasted here: #90 owns
the reconnect handshake and refresh coordination. Omit `onReconnect` when that adapter is
unavailable. Neither saving metadata nor completing a callback proves upstream verification;
the connection's observed state and verification timestamp remain separate.

Existing service, acting identity and transport are immutable: approvals bind the connection ID.
The editor disables those fields and directs the owner to create a new connection for a different
account/executor. Removal retires that ID, revokes its live grants and cancels pending requests in
the owner store; never reuse the ID to rebind old approvals. Name and private credential rotation
remain editable. No private credential value is used to infer or change the acting identity.

## Review semantics

Every pending request shows caller/session/invocation identity, acting service identity, operation,
exact JSON arguments, justification and requested future scope. Exact operation scope and once
duration are defaults. A reviewer may choose session/persistent duration independently. A
broader requested capability scope is available only when all operation IDs exist in the supplied
catalogue; its exact constraints are displayed, including an explicit statement when every
schema-valid argument is allowed. Once always remains exact and bound to the logical invocation.
The form never computes an argument fingerprint and never treats the requested scope as approval.

Approval is disabled in the visible form when current session, project, assignment or catalogue
evidence is missing. This does not replace the authorization service's fresh, atomic validation.
Reject remains available with a reason. Stop/restart expiry, grant reservation/consumption and
revocation are server-owned facts. Grant rows explain matching group permissions from the current
snapshot and whether the connection remains assigned; this is not a claim that a fresh execution
has been admitted. Other grants remain independent; calls already admitted may finish.

No parent Settings wiring or combined native-runtime acceptance is claimed by this contribution.

## Bounded validation

Renderer TypeScript compilation passed. A disposable Vite fixture rendered the actual panels and
theme with fictional canonical records and local callbacks. Browser interaction verified group
creation, additive agent membership, connection create/update/reconnect/remove, once/session/
persistent exact decisions, broad requested-scope presentation and once-scope reset, grant revocation
with the remaining group source visible, and owner gating. A rejected synthetic credential save
cleared its input, retained the non-secret draft and showed no credential in visible errors,
local/session storage or console output. Desktop and 390 CSS-pixel layouts were visually checked;
the narrow approval view had no horizontal overflow. Screenshots and the fixture stay outside Git.
These checks establish the contributed UI/callback behavior only, not transport authorization,
vault persistence, upstream authentication or combined native runtime acceptance.


## Unified mounting adapter

`OwnerAccessSettings` takes an explicit `section`: `connections` shows service connections and discovery status, while `groups` shows permission groups and agent assignments where enabled. The `templates` section has its own Agent templates Settings page for creation presets (the persisted API terminology remains unchanged). The `approvals` section shows access requests and approval grants within Questions and approvals, alongside the existing agent questions and native session approvals. The desktop mounts these as separate Connections and Groups & permissions settings pages. All sections read the same authoritative access snapshot; splitting navigation does not change authorization or duplicate storage. Supply the live `AccessOwnerView` from the authenticated `createAccessOwnerApi` and route its `onCommand` callback to that same owner's IPC command adapter. Subscribe to `access_changed` and refresh props in place. Do not key the component by a snapshot/revision, as that would discard editor drafts. Group, connection and assignment editors retain captured revisions and explicitly show an external-save conflict. The backend independently enforces compare-and-swap.

Presets use canonical `AgentCreationPreset` records. For an empty project the host supplies `runtimeDefaults: {modelAccessId, configRef}` in `AccessOwnerView`; the owner can create the first profile with no pre-existing agent and no selected skills, assign groups/connections and choose the default. When agents exist they are optional profile/skills/runtime templates. Missing runtime defaults produce an explicit model-setup requirement rather than guessed reference IDs. No profile template grants authority by itself. Foundation consumes the canonical provisioning port and remains responsible for publishing a usable agent only after assignment succeeds.


Connection verification uses an independent optional `onVerify(connectionId, expectedRevision)` callback and displays current backend observation after the check. It is not labelled as OAuth reconnect. Owner-only administration actions are excluded from selectable agent Crew capabilities; saving a group must not imply agents can administer grants or credentials.


The owner snapshot consumes a required synchronous `catalogueSnapshot(connection)` host callback and never starts provider discovery. Its `catalogue` rows distinguish `available`, `undiscovered` and `failed`. `OwnerAccessSettings` displays a connection-specific not-yet-discovered or failed-discovery message and offers the separate Verify connection action only when supplied. Empty current catalogues can be available; absent/unverified cache entries cannot.

## Membership capabilities (#124)

Crew permissions are on/off actions in a group. The editor saves `{ action }` only;
assigning a group enables its capabilities for that agent, and multiple groups add
capabilities together. Setup and connection reviews show the enabled actions without
per-action target selectors. One-time and session service approval scopes remain separate.

Workspace choices group only host-provided exact configuration identities. A checked
choice recognizes every equivalent retained policy ID; an unrelated save preserves
those references, and clearing the choice removes all its aliases from that group.
Selecting a new choice adds one canonical policy ID. Different configurations remain
separate and unavailable saved IDs stay visible until explicitly removed. This rendering
never rewrites attachments or historical records.

Permission group deletion uses `removeGroup` with the group ID and expected revision. It requires the project owner and atomically removes the group, removes memberships from assignments and creation templates, recalculates derived selections, increments affected revisions and records `group.removed` in the audit. Existing agents, service connections, other groups and historical approval records are preserved. The UI requires a destructive confirmation before submitting.
