# Crew

A local macOS application for discussing project work by voice and coordinating independent Codex workers. One installed app manages multiple isolated project workspaces. The switcher beside the project name selects the visible workspace; Add project opens onboarding. Each project retains its own controller, manager chat, configuration, instructions, state, port and worktrees. Worker capacity is shared across projects. See [multiple workspaces](docs/multi-project-workspaces.md). There is no hosted deployment or cloud sync.

The Electron desktop window uses the existing web voice interface. Its separate local controller watches durable files, so closing the window or disconnecting voice does not stop background work. A menu-bar icon lets you reopen the window and shows pending attention. Codex and Linear still require their external services; local does not mean offline.

## Install on your Mac

The desktop build is **Apple Silicon, macOS 13 or later**. Open the versioned DMG from `dist/desktop`, drag **Crew.app** into Applications, and launch it. Public GitHub releases are Developer ID signed and notarized. Local candidate builds are unsigned and are kept separate from production update feeds.

Electron includes Chromium and the Node runtime. The Mac still needs **Git**, a compatible **Codex CLI**, ChatGPT sign-in and the intended Linear MCP connection. The realtime baseline tested in the earlier local application was Codex CLI `0.163.0-alpha.10.2`; experimental methods may change. Do not copy credentials from another machine or configure API-key fallback.

First launch creates editable files under:

```text
~/Library/Application Support/Crew/instances/default/
  project.json
  prompts/manager.md
  prompts/worker.md
  .data/
```

First-run setup guides local tools, ChatGPT sign-in, automatic project-folder setup, permissions and readiness. Use **Project setup…** in the app or menu-bar menu to return. Existing configured chats continue normally. **Edit project configuration…** and **Open configuration folder** retain direct file access. Choose your project folder and select Set up this project. Crew saves the actual folder, an available starting branch and source-grounded context, then offers real Linear team/project names. Technical settings stay optional under Advanced. New projects receive separate ports; existing configured ports are retained. Guided saves restart only an idle controller; external file edits need Quit and reopen. Active tasks and connecting/active voice block guided apply. See [Mac installation and operations](docs/MACOS.md) and [configuration](docs/CONFIGURATION.md).

Type to your manager or choose **Connect voice**. Open microphone is the default: Connect starts the call and microphone once connected and permission allows. Input stays active when switching apps until you mute or end the call. Explicit mute is preserved on reconnect. The compact composer defaults to Voice; switch to Text to type without ending an established call or losing your draft. Configure the next call’s voice in Settings → Project settings → Manager profile; there is no separate push-to-talk mode. End call releases the complete voice session. End other calls first. Closing the window also ends voice while leaving the controller running. **Quit Crew…** is separate: its confirmation accounts for every registered project, stops owned controllers, and leaves already dispatched worker supervisors alone. Reopen Crew to collect their reports. Switching projects ends the departing voice call and opens the destination with voice off. The app neither launches at login nor keeps a sleeping Mac awake.

Typed messages and spoken transcripts share one conversation. Live transcripts update in place; unfinished speech is labelled partial. Reconnecting retains recent conversation history, and Connect never clears it.

Open **Settings** in the header for Global settings (shared worker capacity) and Project settings (project name, manager session, manager profile and worker instructions). Use Update to edit a value; successful saves show a toast. Saved manager changes apply only after explicit **Restart manager**; worker changes apply on the next worker direction or launch, with earlier run instructions retained in history. **Stop manager** releases voice and holds manager interaction while independent workers continue. **Start manager** resumes the saved conversation without starting a task or microphone. See [Settings and manager controls](docs/SETTINGS.md).

## First work session

Open **Scratchpad** to inspect the manager’s saved commitments, notes, decisions and open questions without a call. Request corrections through the conversation. The default manager instructions track explicit requests and promises, distinguish brainstorming, and keep delegated work open for evidence review. Local ten-minute reviews consider changed saved work or due follow-ups only while the manager is enabled, idle and voice is disconnected. An explicitly stopped manager stays stopped. Existing saved/custom instructions remain full replacements and require an explicit guidance update and Restart to adopt the new default behavior. See [Manager scratchpad and follow-up](docs/MANAGER-SCRATCHPAD.md).

Tell the manager the intended work and relevant project. The manager decides whether to reuse a worker or create another, delegates through tools, supervises progress and reports findings. Ticket requirements follow the project's instructions; Crew does not impose a ticket-system workflow. External ticket status remains separate from local execution evidence.

Workers keep their native Codex conversation, worktree, notes and history across repeated directions. Use **Send direction** in worker detail to continue through the manager. Dirty files, commits, changed configuration and ended/paused turns require no Crew review or adoption. Active workers receive directions through native steering as soon as their turn is ready. Idle workers continue the retained conversation. Explicit Stop and update reservations hold new execution while preserving accepted messages. Disposal still protects dirty worktrees and unresolved resources.

The worker's project workflow label is explicitly set by an agent. Crew displays it separately from native execution, connectivity and approvals; a **Turn ended** label does not mean the project work is done. Ask the manager to have the worker correct a stale workflow label.

Native Codex configuration, tools, sandbox and approvals govern execution. Agents can implement, test, commit, open PRs, review and use existing project environment commands according to their instructions and the user's request. Add capabilities through ordinary native MCP/CLI configuration, authentication/access and agent guidance rather than Crew-specific integrations. Arbitrary custom native tool UI is not implemented or universally validated.

Environment configuration supplies commands and instructions as agent context. Crew does not automatically run setup, start, resume or readiness before dispatch. Natural turn closure does not send teardown signals to captured service descendants; known live-resource evidence remains available for archive and update checks. Agents own project-specific service checks and cleanup. Native execution evidence does not independently prove semantic correctness or production acceptance. See [Worker lifecycle](docs/WORKERS.md) and [Project execution](docs/PROJECT-ENVIRONMENTS.md).

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

Build on an Apple Silicon Mac. Output is a versioned `.app`, DMG, ZIP and `SHA256SUMS.txt` under `dist/desktop`. The deliberate GitHub workflow builds signed/notarized public releases with a complete native update feed. Local builds default to unsigned candidates. See [release setup](docs/RELEASES.md) and [updates](docs/UPDATES.md); existing unsigned installations need one manual installation of a signed release.

The source-only command-line workflow remains available with Node.js 22+:

```sh
node runtime/cli.mjs init --template set1
node runtime/cli.mjs doctor
node runtime/cli.mjs validate
node runtime/cli.mjs start
node runtime/cli.mjs status
node runtime/cli.mjs stop
node runtime/cli.mjs package
```

Use `--config path` consistently for independent instances. Foreground start is the default; `start --background` detaches the local controller without installing a daemon. Desktop startup never takes over an existing CLI-owned controller: stop that instance with its original CLI command first. Packages exclude local configuration, account credentials, conversations, worker state/worktrees and Git metadata.

[Mac operations](docs/MACOS.md) · [Architecture](docs/ARCHITECTURE.md) · [Configuration](docs/CONFIGURATION.md) · [Onboarding](docs/ONBOARDING.md) · [Storage migration](docs/STORAGE.md) · [Worker lifecycle](docs/WORKERS.md) · [Project execution](docs/PROJECT-ENVIRONMENTS.md) · [AI-012](tickets/AI-012.md) · [AI-010](tickets/AI-010.md) · [AI-011](tickets/AI-011.md) · [Historical validation](docs/VALIDATION-HISTORY.md)

The installed Electron lifecycle/fixture loop passed automated acceptance; live Electron microphone and agent conversation passed by user report. Fresh onboarding permission/denied recovery and sign-in need human confirmation when those states are present; consult the current ticket for measured results. The destination Mac's repository mapping, connector access and first business task still require validation.

## Renderer development

Crew uses React TypeScript with official shadcn/ui and Lucide. Run `npm ci` then `npm run build` before a source controller launch. Desktop dev/release commands build automatically. See [UI foundation and one-file theme workflow](docs/UI-FOUNDATION.md) and [manager workspace and voice controls](docs/MANAGER-WORKSPACE.md).

## Releases and updates

See [release setup](docs/RELEASES.md) for deliberate GitHub builds, required Apple signing credentials and the complete update asset set. [Updating Crew](docs/UPDATES.md) explains explicit download/restart, active-work deferral and retained local configuration. Unsigned candidates do not enable automatic installation.

Developer source/build and responsibility map: [TypeScript workflow](docs/TYPESCRIPT.md).
