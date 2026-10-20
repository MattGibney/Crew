# One-project instance configuration

`node cli.mjs init --template set1` creates a private local config and editable prompt copies without overwriting existing files. `--config /absolute/path/instance.json` selects another local instance. Relative paths resolve against that JSON file's directory. Use real paths; shell variables and `~` are not expanded.

The complete schema is illustrated by `config/set1.example.json` and `config/fixture.example.json`. Unknown keys, malformed JSON, missing prompt files, invalid ports/sandbox values, unusable runtime paths and missing Node/Git dependencies produce clear startup errors. Structurally valid but incomplete business settings allow conversation/setup, with worker dispatch blocked and explicit readiness issues. `validate` returns nonzero until dispatch configuration is ready.

| Field | Meaning |
|---|---|
| schemaVersion | 1 |
| runtime.port | Unique local port, 1024–65535 |
| runtime.codexBinary | null for discovery, or explicit executable path/command |
| runtime.dataDir | Dedicated durable state folder; never share between instances |
| project.id/name/context | Stable instance project identity and reviewed business context |
| project.mode | repository for actual project work; fixture for disposable acceptance tests |
| project.repositories | Configured repo IDs, display names, local Git root paths, explicit committed baseRef and component descriptions |
| project.linear.teamId/teamKey | Confirmed Linear scope; required for repository dispatch |
| project.linear.projectId | Confirmed Linear project ID if tasks are limited to a project; null means team scope |
| project.prompts.manager/worker | Editable Markdown paths |
| project.worker.sandbox | read-only (default) or workspace-write for explicitly agreed local edits |
| project.worker.timeoutMs | Per-run ceiling, 10000–86400000 ms; questions end a run and resume starts the next |

Repository work starts from the configured committed base ref, not uncommitted source-checkout changes. Fetch refs yourself when appropriate; the application does not invent or silently update a base. Keep task worktrees until reviewed. Worktree edits remain uncommitted; commit/publish/deploy actions require a later supported workflow.

The first Set1 template describes marketing performance, traffic quality, ingestion, reporting and product interfaces as **draft context to confirm**, not verified repository ownership. Its repo path/baseRef and Linear values are null. Do not replace them with guessed IDs or a personal machine's paths. Add a separate repository entry for each confirmed boundary and describe its components. No Set1 name or domain behavior belongs in the generic application core.

Manager prompt edits tune role, personality and communication. Worker prompt edits tune execution behavior and reporting. They do not change immutable authentication, consent, project isolation or evidence boundaries. Restart to apply changes; do not change sandbox/base/project identity under an active task.

Discovery order: explicit AI_MANAGER_CODEX_BINARY/CODEX_BINARY or runtime.codexBinary, codex on PATH, supported macOS desktop bundle candidates. AI_MANAGER_CONFIG selects a config and AI_MANAGER_PORT (legacy VOICE_PORT) overrides its port. No credential material belongs in config/prompts; configure ChatGPT login and MCP connections using Codex on that Mac.

To use another business, create another instance directory/config, dataDir and port. Never repoint an existing instance's state at another project. Logs, backing chat history and task files must remain bound to the same configured project.
