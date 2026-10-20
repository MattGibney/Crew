# Crew

A local macOS application for discussing one project's work by voice and coordinating independent Codex workers. Each running instance has **one project**, configured in local JSON and Markdown files. Another project uses a separate configuration, state directory and port. There is no project switcher, hosted deployment or database.

The Electron desktop window uses the existing web voice interface. Its separate local controller watches durable files, so closing the window or disconnecting voice does not stop background work. A menu-bar icon lets you reopen the window and shows pending attention. Codex and Linear still require their external services; local does not mean offline.

## Install on your Mac

The desktop build is **Apple Silicon, macOS 13 or later**. Open the versioned DMG from `dist/desktop`, drag **Crew.app** into Applications, and launch it. This development release is unsigned and unnotarized; macOS may require explicit approval in Privacy & Security. It is not a signed public release.

Electron includes Chromium and the Node runtime. The Mac still needs **Git**, a compatible **Codex CLI**, ChatGPT sign-in and the intended Linear MCP connection. The realtime baseline tested in the earlier local application was Codex CLI `0.163.0-alpha.10.2`; experimental methods may change. Do not copy credentials from another machine or configure API-key fallback.

First launch creates editable files under:

```text
~/Library/Application Support/Crew/instances/default/
  project.json
  prompts/manager.md
  prompts/worker.md
  .data/
```

First-run setup guides local tools, ChatGPT sign-in, automatic project-folder setup, permissions and readiness. Use **Set up Crew…** in the app or menu-bar menu to return. Existing configured chats continue normally. **Edit project configuration…** and **Open configuration folder** retain direct file access. Choose your project folder and select Set up this project. Crew saves the actual folder, an available starting branch and source-grounded context, then offers real Linear team/project names. Technical settings stay optional under Advanced. Choose an unused port if another instance already uses 4317. Guided saves restart only an idle controller; external file edits need Quit and reopen. Active tasks and connecting/active voice block guided apply. See [Mac installation and operations](docs/MACOS.md) and [configuration](docs/CONFIGURATION.md).

**Connect voice** is always your choice. End other calls first. Disconnect releases the microphone. Closing the window also ends voice while leaving the controller running. **Quit this instance…** is separate: its confirmation shows active work, stops that controller, and leaves already dispatched worker supervisors alone. Reopen the instance to collect their reports. The app neither launches at login nor keeps a sleeping Mac awake.

## First work session

Agree a bounded task with the manager, naming an existing ticket in the configured Linear scope and the relevant project folder. The manager verifies the ticket through connected tools before dispatch. Missing ticket or connector evidence must be explained, never invented. Linear remains ticket truth; local JSON and readable notes record execution.

Multiple explicitly assigned workers can run concurrently (default capacity two); additional assignments queue. The manager can stop, pause, resume or dispose a specific worker while retaining work/evidence. Disposal refuses dirty worktrees. Each worker uses its own Codex session and a genuine worktree from the configured committed base ref. It reports meaningful progress and yields questions to the manager. The window and menu bar raise attention; they never activate voice or force spoken interruptions. You answer only through the manager, which resumes the same worker session and worktree. Startup never selects backlog or launches a model task automatically.

Repository workers default to **read-only**. Set `project.worker.sandbox` to `workspace-write` only for explicitly requested local worktree edits and tests. This version does not automate commits, pushes, pull requests, merges, ticket changes or deployment. Worktrees and results remain available for review.

Completed repository tasks mean the controller checked harness success, durable evidence, isolation, baseline and changed-file state. They do not establish code correctness or production behavior independently. Review test evidence and acceptance criteria with the manager.

Crew reads existing project execution instructions and can run their setup and Start action unchanged in each worker’s worktree. It retains command provenance and runtime ownership across questions, resume and controller restarts. See [Project execution](docs/PROJECT-ENVIRONMENTS.md).

## Editable behavior

- JSON defines the single project's context, components, repositories, Linear scope, permissions, port and state directory.
- Manager Markdown defines personality, role and communication.
- Worker Markdown defines behavior and responsibilities.

The subscription-only, explicit-task, manager-only, worktree isolation and no-backlog rules remain enforced regardless of prompt text. Each instance retains its own state and conversation. The guided setup edits these same authoritative files; it does not introduce a separate configuration store. See [onboarding and project discovery](docs/ONBOARDING.md).

## Develop and package

```sh
npm ci
npm test
npm run desktop:dev
npm run desktop:build:mac
```

Build on an Apple Silicon Mac. Output is a versioned `.app`, DMG, ZIP and `SHA256SUMS.txt` under `dist/desktop`. The reproducible lockfile and stable app identifier prepare future releases; no automatic update feed, updater or signing/notarization credentials are configured. Updates currently mean quitting the instance, replacing the app, and reopening with the same external configuration and state.

The source-only command-line workflow remains available with Node.js 22+:

```sh
node cli.mjs init --template set1
node cli.mjs doctor
node cli.mjs validate
node cli.mjs start
node cli.mjs status
node cli.mjs stop
node cli.mjs package
```

Use `--config path` consistently for independent instances. Foreground start is the default; `start --background` detaches the local controller without installing a daemon. Desktop startup never takes over an existing CLI-owned controller: stop that instance with its original CLI command first. Packages exclude local configuration, account credentials, conversations, worker state/worktrees and Git metadata.

[Mac operations](docs/MACOS.md) · [Architecture](docs/ARCHITECTURE.md) · [Configuration](docs/CONFIGURATION.md) · [Onboarding](docs/ONBOARDING.md) · [Storage migration](docs/STORAGE.md) · [Worker lifecycle](docs/WORKERS.md) · [Project execution](docs/PROJECT-ENVIRONMENTS.md) · [AI-012](tickets/AI-012.md) · [AI-010](tickets/AI-010.md) · [AI-011](tickets/AI-011.md) · [Historical validation](docs/VALIDATION-HISTORY.md)

The installed Electron lifecycle/fixture loop passed automated acceptance; live Electron microphone and agent conversation passed by user report. Fresh onboarding permission/denied recovery and sign-in need human confirmation when those states are present; consult the current ticket for measured results. The destination Mac's repository mapping, connector access and first business task still require validation. [Private Notion architecture/setup draft](https://app.notion.com/p/3ff2bdd9911181bfbac2c0495628fde8?pvs=204).
