# Approved project environments (#88)

`ProjectEnvironmentService` owns workspace approvals, attached resources and durable command receipts for the unified agent runtime. The owner approves an exact canonical project folder once. Fresh access-group membership and Crew permissions decide which agents can subsequently attach it, create an approved worktree, execute a command or detach it. No command runs when the owner saves an approval.

The production composition injects `runMacWorkspaceCommand` from the access boundary. This executor runs with a private home, bounded output and duration, and no inherited authentication. Network access defaults to denied; a prepared owner template can explicitly enable outbound TCP and DNS. Environment requests cannot supply readable roots, writable roots, executable search directories, service credentials or native authentication. Provider operations remain gateway operations. A successful command is command evidence; it does not establish application health or business completion.

## Owner setup and publication

Open the service with a dedicated canonical private state directory, the project and owner identities, the shared `ExecutionAdmissionGate`, fresh authorization/session callbacks, and the actual trusted executor. Required `protectedDirectories` come from trusted composition and cover the whole private controller root, including native authentication, vaults and sibling journals. Workspace, managed-worktree and executable-directory approvals cannot overlap those roots or approve an ancestor containing them. Agent requests and owner workspace forms cannot override this exclusion. `approveWorkspace(owner, approval, expectedRevision)` accepts:

- `policyId`: the access environment-policy identity.
- `workspaceDirectory`: an existing project folder. The canonical path and directory identity are retained and checked before admission.
- `writable`: whether sandboxed commands may write the workspace.
- `executableDirectories`: exact owner-approved tool directories. No model-selected search paths are accepted.
- `managedWorktreeRoot`, optionally: an existing private root for newly created registered worktrees, separate from the source repository and controller state.

Publish the returned `ApprovedWorkspace.policy` through the owner-only access API, preserving its exact `id`, `revision` and `enforcementConfigRef`. Access remains the authority for assignments and group `environmentPolicyIds`. The admission callback must verify that the current access policy matches that exact reference. A partially published approval remains denied until the owner publishes the matching policy. Retrying identical normalized approval content with the original expected revision returns the same approval; changed content conflicts. There is no rollback that silently broadens access.

`ownerSnapshot(owner)` exposes approvals, resources and bounded operation evidence. `subscribe(listener)` reports committed changes. `resources(agentId)` projects existing resources for trusted foundation composition; it is not a model-facing authorization boundary. Model discovery uses `list(caller, agentId)`, which checks `environments.read` and policy membership before returning a policy or its resources.

## Explicit agent operations

The foundation binds `caller` from the authenticated native session. `agentId` is the exact resource owner and is checked by the fresh Crew permission callback; it does not replace the authenticated actor. Every request has a stable `requestId` within that caller's logical session.

| Action    | Arguments                                                                                                                      | Result                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `attach`  | `{ "policyId": "approved-policy" }`                                                                                            | Attaches the saved workspace to the target agent. Repeated attachment reuses that agent's existing attached resource.     |
| `create`  | `{ "policyId": "approved-policy", "ref": "HEAD" }`                                                                             | Creates a uniquely named, detached, registered Git worktree only under an owner-approved managed root. `ref` is optional. |
| `execute` | `{ "environmentId": "resource-id", "command": ["/usr/bin/git", "status", "--short"], "relativeCwd": ".", "timeoutMs": 30000 }` | Runs exact argv through the enforced callback and returns bounded stdout, stderr and exit evidence.                       |
| `dispose` | `{ "environmentId": "resource-id" }`                                                                                           | Detaches the resource after all its operations settle. Files and Git registration are explicitly retained.                |

Commands are argv arrays, safely quoted for the executor's shell transport. A shell script is possible through explicit argv such as `["/bin/sh", "-c", "project-command"]`, within the same sandbox. Working directories must remain inside the resource; the executor resolves them canonically. The maximum command duration is 120 seconds, with at most 32 KiB retained for each output stream. There is no guessed setup, build, readiness, teardown, branch workflow or automatic replay.

The first managed creator supports ordinary source repositories with an actual local `.git` directory. It does not infer a creation base from an existing worktree's `.git` indirection. Existing worktrees can still be attached. Worktree creation disables Git hooks and filesystem-monitor hooks, keeps the generated directory after any partial failure, and verifies the resulting Git common-directory identity. Disposal never runs `git worktree remove`, filesystem deletion, process termination or project cleanup.

## Delivery and lifecycle evidence

The journal commits the environment identity, request fingerprint, caller, exact policy revision and a running operation marker before invoking an external command. Duplicate delivery of the same request returns its existing operation and result. Reusing the identity with changed arguments is rejected. An interrupted running record becomes uncertain when the journal is reopened; it is never dispatched again. The original command body is not stored, but its fingerprint and bounded output are retained in owner-private state.

Fresh policy checks, session/execution admission, preparation-readiness invalidation and receipt persistence run under the same short gate used by the final lifecycle reservation. The command itself runs after that gate is released. `settlement(caller)` reports operations belonging to that exact submitting session for Stop; `settlement()` includes the whole project for Quit/Restart/Update. Resource disposal checks every operation on that resource, regardless of who submitted it.

An executor result must include confirmed process settlement before an executed operation stops blocking a lifecycle reservation or another operation on the same environment. Root-process exit alone does not establish descendant settlement. The real helper records the launched process group and observed descendants privately; its settlement check confirms their absence. Sampling does not establish arbitrary unobserved daemonization, service health or resource cleanup.

`reconcileOperation(owner, operationId)` uses the injected read-only `observeExecution(privateDirectory, processEvidenceRef)` helper for every receipt returned by that operation. Managed creation journals both its creation and registration-check receipts. A still-live background command remains unsettled. After natural exit, fresh absence proof can set `executionSettled` while retaining the original result, request fingerprint and any `state: "uncertain"` outcome. This clears only local process activity for lifecycle admission; it never declares an unknown command successful, cleans files, replays a command, or changes an uncertain managed resource into an attached one. Native-message and external gateway uncertainty retain their own rules.

The helper currently returns its evidence reference after launch. A crash before that reference is durably received can therefore leave an operation without complete evidence. Such records stay uncertain and block lifecycle admission even if unrelated process evidence exists: reconciliation never scans directories to guess a reference or treats missing evidence as proof of absence. Earlier journals remain readable, with missing process evidence explicitly unavailable. Neither a timeout nor lost response permits blind retry or guessed cleanup. Recovery preserves the journal and any resources; an abandoned writer lock requires confirmed controller ownership recovery before reopening.

The journal is bounded to 10,000 operation receipts and 32 MiB. Reaching either bound requires owner maintenance; receipts are never silently evicted to make a duplicate executable. Closing the service waits for already admitted bounded calls and does not kill resources. Composition must stop new ingress before closing.

## Optional project templates (#108)

`ProjectEnvironmentTemplateCatalogue` stores reusable named definitions and agent assignments in private project state. Templates describe existing tool installations and explicit nonsecret configuration. Permission groups still decide whether an agent may read or execute in an approved workspace. No template creates a group, assigns a permission, installs tools or runs project setup. Template updates can queue a durable internal notice through the agent's ordinary message path.

The typed owner surface is `environmentOwnerApi.templates`:

- `snapshot()` returns current templates and assignments.
- `save({id,expectedRevision,draft})` creates or revises a definition with revision checking.
- `assign({agentId,expectedRevision,templateId,templateRevision})` pins a particular immutable revision, or clears the assignment with null template fields.
- `inspect({templateId,templateRevision})` explicitly checks optional executable requirements through bounded sandboxed version commands. It distinguishes missing, inaccessible, incompatible and unavailable evidence. It never installs anything or reads shell profiles/npm credentials.

Drafts contain a name/description, optional `tools` requirements, exact `executableDirectories` and `readableDirectories`, an explicit nonsecret `environment` map, optional capabilities, and preparation instructions/argv examples. Existing Node/npm installations may need both their executable directory and the package directory containing npm's JavaScript files. There is no inherited login PATH, host npm cache or credential configuration. A minimal template can leave all these fields empty.

Prepared environments also retain an isolated private HOME across commands. Docker uses its `.docker` directory and the explicitly pinned endpoint, with no imported personal configuration. Private npm/Nx caches remain separate from workspace write access. For Nx projects, an owner may explicitly select supported `NX_DAEMON=false` and `NX_ISOLATE_PLUGINS=false` configuration to avoid daemon/plugin socket requirements; the executor does not silently add a general Unix-socket grant. Environment choices remain visible in the saved template and require explicit preparation to take effect.

An agent explicitly invokes `prepare` with `{environmentId,expectedAssignmentRevision}` after attaching an authorized workspace. Preparation verifies the pinned template and tool evidence and allocates private runtime caches; it executes none of the suggested preparation commands. The agent then decides which documented commands to invoke through `execute` or `start`. Editing a template or assignment never rewrites an already prepared environment or a running command; a new explicit preparation is required. Repreparation and disposal wait for live/uncertain work to settle.

Owner-approved creation presets may contain `environmentTemplate: {id, revision}`. `agent_create` still selects an exact preset revision, with no template-administration capability. Trusted provisioning resolves and assigns the pinned template alongside the preset's access, before allowing Start. Missing-only assignment is idempotent: a lost response never overwrites an owner-changed or cleared assignment. A metadata failure retains the stopped agent for explicit provisioning recovery. Legacy presets without a template remain unchanged. Creation does not inspect tools, prepare a workspace, install anything or start a turn.

`start` accepts the same argv/cwd shape as `execute` and returns a retained operation identity with process evidence. `status` and `stop` take `{operationId}` for that exact start, never host PIDs. Start/prepare/stop use existing `environments.execute` authority; status uses `environments.read`. Foreground commands can run alongside a recorded managed background start. Stop requests TERM only against freshly matched recorded PID/start/group/command identities, then reports whether exit was confirmed; it does not force-kill, adopt arbitrary processes or claim service/resource cleanup.

`environmentOwnerApi.inspectOperation(operationId)` is a read-only fresh inspection of retained process receipts. It remains usable for a failed project's Quit diagnostics without session execution admission, launching commands, replaying work or sending signals. Missing evidence remains unknown. Persisting settlement is a separate `reconcileOperation` call.

### Current execution limits

- `capabilities.network` explicitly enables outbound TCP/DNS. Package downloads require this capability; availability does not imply a package install occurred.
- `localhostPorts` is reserved but currently fails closed when nonempty. Real macOS tests showed that Seatbelt's localhost bind rule also permits wildcard/LAN listening. Crew cannot present that as a loopback-only boundary; strict loopback-only service requires a separate enforceable transport.
- Optional `capabilities.inboundPorts` explicitly approves incoming TCP on exact high ports across all interfaces. It defaults to absent/empty, is never inferred from outbound access, and cannot be supplied by agent command arguments. This separate owner choice supports real dev servers without claiming a loopback-only boundary. Review the exposed port list before assigning such a template.
- Unix sockets default to denied. An optional `hostDocker` template setting requires an explicit socket and `hostAccessAcknowledged: true`: this is broad trusted host authority, including daemon-wide operations and host mounts beyond workspace restrictions. It is never inferred from Node/npm, network access or assignment. Commands use a clean private Docker configuration, without personal Docker credential inheritance. Preserve unrelated containers/volumes and inspect existing services before invoking setup or teardown.
- Existing project instructions and setup/start/teardown scripts remain authoritative and unchanged. A successful version check or disposable package task does not prove a customer application's setup, network readiness, cleanup, native manager delegation or human acceptance.

## Agent-owned template lifecycle (#127)

A project template is a reusable definition. Each persistent agent owns its preparation decisions and private working context; shared folder/repository grants remain separate. A marketing agent can select a media-tool template and inspect or prepare its private context without attaching a code repository. Crew does not assign development workflow, install a template, run suggested setup, or automatically rebuild an environment.

Three revisions have distinct meanings:

- **Desired definition:** the latest saved revision of the agent's selected template. Every update retains immutable definition bytes and creates a durable notice for each currently assigned agent.
- **Selected assignment:** the exact revision chosen for the agent's next preparation. Owner assignment and the authenticated agent's explicit reconciliation update this metadata through revision checks.
- **Applied preparation:** the exact template/assignment revision, tool directory identities, runtime home and configuration retained on an attached environment. Template edits and reconciliation never replace this snapshot. Explicit `environment_action` preparation verifies the selection and applies it only after the existing live/uncertain execution checks settle.

`environment_template_read {}` is authenticated to the current caller alone. It returns both complete selected/desired definitions, current assignment, preparation-required status, private context records, agent-reported preparation notes and applied environment revisions. Metadata inspection needs no shared-folder permission. It neither grants access to another agent nor bypasses folder/policy authorization. A stale or stopped native session cannot use the lifecycle tools.

The agent can then choose among these explicit operations:

| Tool                             | Input                                           | Effect                                                                                                                                                                                 |
| -------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment_context_prepare`    | `{expectedAssignmentRevision}`                  | Creates/reuses the caller's private context and empty HOME for the exact selected template revision. No shared-folder grant, installation or command execution.                        |
| `environment_template_reconcile` | `{expectedAssignmentRevision,templateRevision}` | Selects the inspected revision for later preparation. Existing contexts, applied configurations, services and chat remain intact.                                                      |
| `environment_preparation_report` | `{expectedAssignmentRevision,state,summary}`    | Retains the caller's bounded nonsecret assessment: `preparation_required`, `prepared` or `blocked`. This is agent testimony, not independently verified setup or executable readiness. |

`preparationRequired` is a communication signal: it stays true until a current-assignment `prepared` report exists, and becomes true again when a newer desired definition exists. It never blocks agent communication or determines task workflow. Independently verified version probes and actual applied revisions remain separate fields. Agents can use existing tools for their own preparation/rebuild plan, report blockers, preserve partial work and choose to retain an older context while work continues.

Private contexts live under the trusted per-project runtime-cache root, keyed by agent identity and template revision. Explicit workspace preparation reuses that agent/revision context across its attachments; a new template revision creates a separate home/cache context. Legacy prepared runtime roots remain retained and valid. Controller authentication, credential vaults, shared folders and optional Git worktrees remain separate. These directories are private working data on the same host, not a VM or a claim of hostile-agent isolation.

**Current command boundary:** private-context creation and preparation reports work for agents without an approved shared folder. Shell/file execution within that private context alone is not yet exposed as a separate executor target. Actual shell commands still require an owner-approved workspace policy and ordinary environment permissions, through `environment_action`. Private context creation does not silently publish a folder policy. Service-only agents can use their permitted service tools and retain a private preparation report without a repository. Do not claim a full package installation or unrestricted private working filesystem from the existence of a context directory.

### Template change notification evidence

Template save commits all affected-agent notices in the same private catalogue transaction as the new revision. A trusted outbox sends them through `AgentFoundation.sendInternal` with stable message IDs and `source: preparation`. Lost enqueue responses reuse those IDs; startup replays pending outbox records and the foundation deduplicates the durable intent. `enqueuedAt` means accepted into that durable internal inbox, not native receipt or execution. Foundation message delivery retains its own queued/acknowledged/uncertain state. A stopped agent retains its queued notice until its normal session starts; notices wait behind active work and private-input restrictions. There is no scheduled worker or generated owner assignment.

No command runs during save, assignment, reconciliation or notice delivery. An idle running agent may receive the internal notice through its ordinary native message path and decide how to act. Delivery failure does not roll back a successfully saved definition; the outbox remains inspectable and pending notices are retried on the next save/startup or explicit trusted `deliverNotifications()` call. Notices and old contexts are bounded retained evidence, with no automatic eviction or destructive cleanup.

### General executable requirements

Templates accept up to 32 unique bare executable names, beyond Node/npm. Requirements resolve through approved executable directories plus the executor's existing system-tool paths; arbitrary executable paths, inherited login PATH and credentials remain excluded. Example:

```json
[
  { "name": "git", "versionRequirement": ">=2" },
  {
    "name": "ffmpeg",
    "versionRequirement": ">=7",
    "versionArguments": ["-version"]
  }
]
```

`versionArguments` is an optional bounded owner-approved argv list; it defaults to `["--version"]`. The explicit inspector runs the probe through the same bounded read-only sandbox and private execution receipts. Numeric two/three-part versions in ordinary output are normalized for the existing supported numeric range grammar. Missing/inaccessible tools, failed probes, incompatible versions and unavailable numeric compatibility stay distinct. A successful probe with no requested range establishes only that the executable answered its configured probe. No host installation, personal configuration or shared-service access is inferred.

Guidance for first use and responding to updates belongs in editable agent instructions/skills and the tool descriptions. The bundled manager/worker prompts include an optional workflow example; saved owner profiles and retained native instructions are not silently rewritten by template saves.
