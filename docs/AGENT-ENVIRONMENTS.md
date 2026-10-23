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

`ProjectEnvironmentTemplateCatalogue` stores reusable named definitions and agent assignments in private project state. Templates describe existing tool installations and explicit nonsecret configuration. Permission groups still decide whether an agent may read or execute in an approved workspace. No template creates a group, assigns a permission, installs tools, starts a turn or runs project setup.

The typed owner surface is `environmentOwnerApi.templates`:

- `snapshot()` returns current templates and assignments.
- `save({id,expectedRevision,draft})` creates or revises a definition with revision checking.
- `assign({agentId,expectedRevision,templateId,templateRevision})` pins a particular immutable revision, or clears the assignment with null template fields.
- `inspect({templateId,templateRevision})` explicitly checks optional Node/npm requirements through bounded sandboxed version commands. It distinguishes missing, inaccessible, incompatible and unavailable evidence. It never installs anything or reads shell profiles/npm credentials.

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
