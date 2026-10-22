# Approved project environments (#88)

`ProjectEnvironmentService` owns workspace approvals, attached resources and durable command receipts for the unified agent runtime. The owner approves an exact canonical project folder once. Fresh access-group membership and Crew permissions decide which agents can subsequently attach it, create an approved worktree, execute a command or detach it. No command runs when the owner saves an approval.

The production composition injects `runMacWorkspaceCommand` from the access boundary. This executor runs with a private home, bounded output and duration, and no network or inherited authentication. Environment requests cannot supply readable roots, writable roots, executable search directories, service credentials or native authentication. Provider operations remain gateway operations. A successful command is command evidence; it does not establish application health or business completion.

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

An executor result must include confirmed process settlement before an executed operation stops blocking a lifecycle reservation or another operation on the same environment. Root-process exit alone does not establish descendant settlement. If the executor cannot provide that evidence, the result remains available but settlement stays uncertain. Neither a timeout nor lost response permits blind retry or guessed cleanup. Recovery preserves the journal and any resources; an abandoned writer lock requires confirmed controller ownership recovery before reopening.

The journal is bounded to 10,000 operation receipts and 32 MiB. Reaching either bound requires owner maintenance; receipts are never silently evicted to make a duplicate executable. Closing the service waits for already admitted bounded calls and does not kill resources. Composition must stop new ingress before closing.
