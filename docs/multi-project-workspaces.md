# Multiple local project workspaces

Tracking: [Crew issue #2](https://github.com/MattGibney/crew/issues/2).

One locally installed Crew Mac app can manage several isolated local project instances. The main window shows the selected project. The switcher beside its name chooses another project; Add project opens onboarding, and Rename changes the workspace display name. Removing projects is deferred.

Switching projects keeps admitted work running in the background. It releases the previous project's voice connection and microphone, and does not start a call in the destination. A new call still uses the existing one-click Connect behavior and open microphone default. Closing the window releases voice while the parent runtime and project controllers remain available from the menu bar. Explicit Quit is a separate operation.

Each project retains its own manager conversation, workers, questions, results, Git worktrees, environment lifecycle, configuration, instructions, tool/MCP settings, logs and saved state. The human continues to speak to one manager in the selected project; workers do not acquire a separate direct conversation. Existing Codex subscription sign-in and allowance are shared. There is no API-key fallback, hosted backend, project cloud sync or remote project runtime.

The single menu-bar hand indicates attention across projects. Its menu identifies the projects needing attention and opens the relevant workspace. The main window does not add an all-project dashboard, and switching does not introduce spoken notifications.

## Shared worker capacity

Worker capacity is one global setting because every project uses the same machine. The default is two admitted workers, with an integer setting from one to 64. Waiting jobs stay visible in their own workspace. Selecting another project neither changes queue priority nor preempts running work. Reducing the limit must not kill work already admitted; admission waits until usage falls below the new limit.

Admission and recovery must account for all project controllers durably. A controller cannot admit based solely on the selected project's task list or an in-memory counter. Unknown ownership or live-process evidence blocks unsafe recovery or update, rather than being treated as zero activity.

## Registry and retained project identity

The Electron parent owns a private `workspaces.json` in Crew's existing application-support root. Its version-one schema is:

```json
{
  "version": 1,
  "selectedId": "project-<uuid>",
  "workerLimit": 2,
  "projects": [
    {
      "id": "project-<uuid>",
      "configPath": "/absolute/existing/project.json",
      "key": "retained-desktop-partition-key",
      "desktopData": "/absolute/existing/desktop-profile",
      "name": "Project name"
    }
  ]
}
```

Registry registration preserves the initial configuration path, partition key and desktop profile path. It never relocates a config, copies authentication, rewrites prompts, resets conversations, edits worker records or moves Git worktrees. Existing storage migration, when applicable, remains the responsibility of the existing storage service before registry registration. The registry adds the configured project as the first workspace and reads its name when accessible, falling back to “Your project”. New-project onboarding remains responsible for creating a separate valid config and isolated state, port, lock and profile identity.

A normal reopen restores the saved selected workspace. An explicitly supplied configuration selects its existing registration or adds it. Config aliases resolve to the existing registration and retain its original partition identity. Duplicate config paths, desktop profiles, IDs and partition keys are rejected. Corrupt, unsupported or ambiguous registry records fail closed and retain the saved bytes for inspection. Registry recovery must not silently replace the registry with an empty list or new default project.

`desktop/workspace-registry.mjs` exports `openWorkspaceRegistry({ crewRoot, initial, explicitConfig })`. `initial` contains `configPath`, `key` and `desktopData`, with an optional name. `snapshot()` returns a detached copy of the full registry. Async `add`, `select`, `rename` and `setWorkerLimit` return the updated snapshot. Add selects the new workspace. Rename updates the workspace display name in the registry, without rewriting project configuration or project identity.

Mutations queue in the owning parent registry, validate the complete proposed state, then write a private temporary file, sync it, atomically rename it and sync the containing directory. In-memory state advances after persistence succeeds. The native app's single parent process owns registry writes; separate controller processes must use the parent interface rather than open independent writable registries.

`desktop/workspace-isolation.mjs` supplies a read-only preflight for all registered configurations and an optional proposed config. It canonicalizes symlink aliases through the nearest existing parent, including state and instruction files not created yet. Shared ports, shared or nested state folders, shared physical configuration/instruction files, and one project storing its config or instructions inside another project’s state are rejected. Configuration read failures block the change. The parent must run this check before bootstrap and before saving or launching a changed project; checking only during initial registration does not preserve isolation after configuration edits.

## Integration boundaries

- **Parent runtime and renderer:** one Electron installation, window, tray and updater identity; separate controllers, ports, locks and state for every registered workspace. Switching releases previous voice resources before selecting the destination. Restore existing work without duplicate launches or automatic backlog dispatch.
- **Updates:** readiness, reservations, controlled Pause work and update, and Quit inspect every managed instance. No hidden active workspace may bypass the activity gate. The updater owns drain/pause/resume behavior; multi-project integration fans that contract out across controllers and resumes only work paused by that update. Preserved worktrees or failed history alone do not establish live work or prove that work stopped.
- **Settings (issue #3):** full manager/worker prompt replacement and manager lifecycle remain Settings scope. Workspace selection supplies the intended project context; prompt changes must never leak to another project. Registry rename changes only the workspace display name.
- **Toolchains (issue #1):** Crew-managed shared version cache and explicit per-project/worker PATH remain Toolchains scope. Project registration does not alter the user's shell, project development scripts, Codex/Claude instructions or Set1 source.

## Idle-update reservation recovery

The parent keeps a private idle-update reservation journal before pausing global worker admission. It records the owning process, intended installed version and exact registered workspace identities. Every local controller must confirm its idle reservation; a failed partial attempt rolls back only confirmed reservations. An unconfirmed cancellation keeps global admission paused and preserves the journal for recovery.

`createWorkspaceUpdateReservation` in `desktop/workspace-update.mjs` serializes prepare/cancel/recover callbacks. Cancel confirms every project-local barrier is released before unpausing global admission and deleting its journal. Native restart recovery releases that hold only when the journal's previous owner is dead, the registered workspace identities match, the running app is the intended target version, and fresh activity from every project is safe. An old-version restart, malformed journal, live owner, different project set or unavailable activity leaves admission paused for review. No journal means this helper does not change admission, so it cannot release another feature's hold. This helper handles the existing idle-update barrier; it does not implement the separate controlled work drain and resume engine.

## Validation and acceptance

Focused disposable registry tests cover byte-preserving registration, retained desktop identity, selection/reload, explicit config aliases, missing config name, private file permissions, mutation validation, concurrent mutation ordering and corrupt-registry preservation. They do not establish native UI or multi-controller lifecycle correctness.

Full feature acceptance requires disposable projects and synthetic media to verify simultaneous manager/worker isolation, the shared worker cap and recovery, attention routing, switching during active work/voice, retained profile identity, onboarding/config preservation, and all-project pause/update/Quit behavior. Screenshots and operational evidence belong outside the repository. Native/device and human acoustic acceptance must be reported separately from unit or browser checks. Physical microphone activation, real user workers, installed app configuration, and real Set1 provisioning/cleanup are outside autonomous feature-test scope.

## Current validation checkpoint

The final full automated suite passed 275 checks, including real child processes and Git worktrees, concurrent cross-controller admissions, conservative recovery, retained queue start intent, project cwd/MCP path isolation, registry corruption, canonical config collisions and all-project update reservation/recovery.

The compiled desktop/narrow-screen UI passed switcher, rename/retry, shared limit, incoming-update draft retention, independent composer drafts, keyboard dismissal and layout checks. A fresh unsigned packaged candidate passed disposable native Electron acceptance with two isolated controllers and actual synthetic worker processes: cap one queued the second project; cap two admitted both; coincident task IDs retained distinct run/worktree identities; switching preserved both running workers; question attention remained project-correlated; a synthetic voice call disconnected on switch; destination voice remained off; close left both controllers alive; Quit stopped both; reopen retained selection, capacity, drafts and chat identity without new work or voice.

Run the optional native acceptance from a macOS development checkout with a local Electron runtime and `playwright-core` available:

```sh
npm run renderer:build
node scripts/workspace-native-acceptance.mjs
```

`CREW_PLAYWRIGHT_MODULE` may point to an existing external Playwright module. `CREW_ACCEPTANCE_EXECUTABLE` may point to an isolated candidate's executable. The script uses temporary app/config profiles, synthetic Codex/media and disposable Git fixtures; screenshots and private evidence stay in the printed temporary directory. It does not use physical audio, account credentials or business repositories. `CREW_APP_DATA` is an explicit profile-root override for disposable/portable app runs; ordinary launches retain the normal Crew application-support root.

This is branch/candidate acceptance, not a released feature or a signed automatic-install test. Combined integration with the separately developed coordinated pause/update, Settings and managed-toolchain changes remains required before a grouped release. Native tray OS interaction and physical acoustic acceptance are distinct from registry routing, renderer screenshots and synthetic-media evidence.
