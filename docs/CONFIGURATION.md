# One-project instance configuration

`node cli.mjs init --template set1` creates a private local config and editable prompt copies without overwriting existing files. `--config /absolute/path/instance.json` selects another local instance. Relative paths resolve against that JSON file's directory. Use real paths; shell variables and `~` are not expanded.

The complete schema is illustrated by `config/set1.example.json` and `config/fixture.example.json`. Unknown keys, malformed JSON, missing prompt files, invalid ports/sandbox values, unusable runtime paths and missing Node/Git dependencies produce clear startup errors. Structurally valid but incomplete business settings allow conversation/setup, with worker dispatch blocked and explicit readiness issues. `validate` returns nonzero until dispatch configuration is ready.

| Field | Meaning |
|---|---|
| schemaVersion | 1 |
| runtime.port | Unique local port, 1024–65535 |
| runtime.codexBinary | null for discovery, or explicit executable path/command |
| runtime.dataDir | Dedicated durable state folder; never share between instances |
| project.id/name/context | Stable instance project identity and project context |
| project.mode | repository for actual project work; fixture for disposable acceptance tests |
| project.repositories | Configured repo IDs, display names, local Git root paths, starting branch (baseRef internally) and component descriptions |
| project.linear.teamId/teamKey | Actual discovered or explicitly configured Linear scope; required for repository dispatch |
| project.linear.projectId | Confirmed Linear project ID if tasks are limited to a project; null means team scope |
| project.prompts.manager/worker | Editable Markdown paths |
| project.worker.sandbox | Legacy task edit-scope guard: read-only or workspace-write. Native sandbox permissions resolve through Codex configuration. |
| project.worker.maxConcurrent | Executing capacity, 1–8; default 2. Explicit extra tasks queue. |
| project.worker.environment | Optional bootstrap/start/ready/resume/cleanup hooks; see WORKERS.md. No hooks means application readiness is not established. |
| project.worker.timeoutMs | Per-run ceiling, 10000–86400000 ms; questions end a run and resume starts the next |

Repository work starts from the configured committed base ref, not uncommitted source-checkout changes. Fetch refs yourself when appropriate; the application does not invent or silently update a base. Keep task worktrees until reviewed. Worktree edits remain uncommitted; commit/publish/deploy actions require a later supported workflow.

The historical `set1` example filename and CLI template name are retained for compatibility; its contents are a generic incomplete project template. Normal onboarding replaces its provisional context with source-grounded understanding, canonical chosen folder, actual available starting branch and real Linear team/project choices. Unavailable values remain unset; no opaque ID needs to be invented or looked up manually. Add a separate repository entry for each confirmed boundary and describe its components. No business-specific name or domain behavior belongs in the generic application core.

Use **Settings** for full replacement manager and worker instructions. Saved manager edits require explicit **Restart manager** (or Start after Stop); workers capture the saved instructions on their first launch and retain that snapshot. Settings saves live in project state without rewriting the configured Markdown files. Codex/provider system rules, runtime permissions and tool protocol remain separate. See [Settings and manager controls](SETTINGS.md). Do not change sandbox/base/project identity under an active task.

Discovery order: explicit AI_MANAGER_CODEX_BINARY/CODEX_BINARY or runtime.codexBinary, codex on PATH, supported macOS desktop bundle candidates. AI_MANAGER_CONFIG selects a config and AI_MANAGER_PORT (legacy VOICE_PORT) overrides its port. No credential material belongs in config/prompts; configure ChatGPT login and MCP connections using Codex on that Mac.

To use another business, choose Add project in the native workspace switcher; Crew creates another instance directory/config, dataDir and port. An explicit existing --config is also registered/selected in the same native app. Never repoint an existing instance's state at another project. Logs, backing chat history and task files must remain bound to the same configured project.

Worker lifecycle and hook semantics are documented in [WORKERS.md](WORKERS.md). Environment hook commands run directly without a shell, take an explicit args array and timeoutMs of 1000–600000. Only configured scoped resource handling is supported; Crew does not automatically infer service provisioning or clean shared infrastructure.

## Project execution plan

`project.worker.environment.executionPlan` retains version 1 source hashes and optional setup, start, resume, ready, stop and teardown phases. Each phase stores the exact script, its source path/hash and a bounded timeout. Guided discovery reads existing Codex environment setup and Start actions; no project patch or specific lifecycle API is required. Scripts use the worker worktree as cwd. Optional `env.PATH` selects installed tools locally. Generic argv hooks remain supported separately. See [Project execution](PROJECT-ENVIRONMENTS.md).


## Normal Codex configuration

Repository manager and worker sessions use Codex's normal user, applicable trusted-project and managed configuration resolution. Crew does not pass `--ignore-user-config`, force sandbox/approval policies, or overwrite `shell_environment_policy`. The installed Codex version determines supported settings and trust/policy behaviour. Crew supplies the project/worktree cwd, immutable runtime instructions, subscription sign-in requirements and its own orchestration MCP binding. The manager resolves configured developer instructions through `config/read` for that cwd and retains them before its Crew role/runtime instructions in memory; it does not separately save or log configuration contents. Native Codex conversation persistence still applies. A worker's agreed edit scope remains an additional task guard, not a statement of native sandbox permissions.

Managed Node/npm are process launch defaults with inherited discovery paths retained. Explicit Codex environment/PATH/profile settings and ordinary shell startup remain authoritative. Host lifecycle scripts use login zsh and are separately supervised; they are not executed under the worker's Codex permissions or environment policy. They do not prove worker Docker or localhost access. Existing configuration and project scripts are reused in place without copying credentials or making project changes. See [Project execution](PROJECT-ENVIRONMENTS.md).


Configuration resolution is relative to each actual Codex cwd and its trusted project layers. A repository-local ignored `.codex/config.toml` that exists only in the original checkout may not be present or discovered in a linked worker worktree. Crew follows the installed Codex resolver for that worktree; it does not copy the original checkout's ignored configuration, settings or credentials. Confirm effective policy from the worker rather than assuming the original checkout's local policy carried across. User and managed configuration still resolve normally.

## Worker approval requests (GH-13)

Workers use separate supported Codex app-server sessions. Native approval and input requests appear in the manager conversation and worker review cards; they do not create a worker conversation or another turn. The user may choose only the decisions offered by the native request. Session approvals, offered policy amendments, requested permission subsets and connector forms retain their original meaning. A canceled native turn is retained as stopped, without claiming a successful result or automatically resuming it.

Private request records retain project-state, task, run, native thread, turn and request identity. A decision, successful pipe delivery and native acknowledgement are separate evidence. Controller/window reload adopts the surviving supervisor and pending requests; a new run cannot consume an old response. Pending stop/pause blocks positive delivery; explicit denial remains available. Unknown transport or ownership keeps evidence and blocks a clean-success claim. The manager MCP tool relays an explicit human instruction; it cannot independently attest the origin of spoken consent. Direct UI decisions remain available.
