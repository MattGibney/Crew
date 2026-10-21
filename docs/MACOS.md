# macOS installation and operations

Crew is a purely local Electron application. New default state is under Application Support/Crew; [legacy migration and recovery](STORAGE.md) preserve prior state. The bundle identifier is deliberately retained for macOS continuity. Its window is optional; a separate local controller runs while the app remains in the menu bar. Codex and Linear use their external services. No hosted infrastructure, login daemon or database is installed.

## Requirements

- Apple Silicon Mac running macOS 13 Ventura or later for this artifact. Intel and universal artifacts are not included.
- Git, including a committed base ref for each configured repository.
- Compatible Codex CLI with experimental app-server realtime methods. The earlier working voice baseline was `0.163.0-alpha.10.2`; compatibility must be checked on the work Mac.
- Existing ChatGPT/Codex subscription sign-in on that Mac. No API key, private endpoint or credential transfer.
- The intended Linear MCP tools connected in that Mac's Codex configuration. Installing this app does not provision connectors or their authentication.

The Electron package supplies Chromium and Node; Node need not be installed separately for desktop use. Codex CLI and Git remain external dependencies. `runtime.codexBinary` may specify an explicit executable path when discovery cannot find the intended CLI. Configure that path locally, rather than shipping another computer's private installation path.

## Install and configure

1. Open `Crew-0.7.0-arm64.dmg` and drag the app to Applications. ZIP is an alternative distribution of the same app.
2. Launch **Crew**. Public releases are signed and notarized. Local candidate builds remain unsigned; verify their source and checksum and use macOS explicit approval only when intentionally testing a candidate. Do not disable Gatekeeper globally.
3. First launch creates an incomplete project template at `~/Library/Application Support/Crew/instances/default/project.json`, plus editable `prompts/manager.md` and `prompts/worker.md`. Existing files are not overwritten. No worker starts automatically.
4. Follow the guided setup, or use **Set up Crew…** from the app/menu-bar menu. The configuration form, optional project-folder analysis and direct file actions edit those same files. Confirm the project context/components, repository paths, existing committed base refs and Linear identifiers. The historical template name is a compatibility alias, not the configured project identity. See [configuration reference](CONFIGURATION.md).
5. Set a free `runtime.port` and a private, instance-specific `runtime.dataDir`. Relative state and prompt paths resolve against the config file's directory. Another process on 4317 is not stopped or adopted automatically.
6. Guided saves restart an idle owned controller after validation; active work or connecting/active voice blocks apply. Quit and reopen after external configuration/prompt edits. Errors should identify the failed configuration/dependency step. An incomplete template permits setup discussion but cannot dispatch business work.

See [guided onboarding and optional project discovery](ONBOARDING.md) for checks, permission recovery and review/apply semantics.

Preparation must show the configured project, ChatGPT sign-in and an enabled Connect button. A catalog response alone does not prove manager readiness. Choose a voice; end other calls before connecting. macOS may request microphone permission when you explicitly connect. The app does not request a camera. Disconnect before changing voice.

## Window, attention and Quit

Closing the window ends voice and releases its microphone, then leaves the controller and menu-bar icon running. **Open [project]** recreates the window with the same durable task state. Pending worker questions/results appear as raised-hand attention in the app and menu bar. They do not start a call or speak unsolicited.

**Quit this instance…** (also Command-Q) asks for confirmation and displays active-work status. It ends voice and shuts down the controller owned by that instance. Independently dispatched worker supervisors are not canceled; they can finish and write reports while the controller is stopped. Reopen the same instance to process those reports. Quit never guesses which unrelated OS process to stop. Restart the app after a reboot; a sleeping or offline Mac cannot continue active model work.

Do not use CLI `stop` against a controller currently owned by Electron as the normal desktop shutdown workflow. Use the desktop Quit action so the ownership and lifecycle checks run together.

## Another project or business

Run a separate instance of the same app with a separate config file. There is no runtime project switcher. Initialize the files first with the bundled runtime, then edit the project, port and state directory before launching:

```sh
app='/Applications/Crew.app/Contents'
env ELECTRON_RUN_AS_NODE=1 "$app/MacOS/Crew" "$app/Resources/app/cli.mjs" init --template set1 --config "$HOME/Library/Application Support/Crew/instances/another-project/project.json"
# Edit the generated project.json and prompts before starting this instance.
open -n -a '/Applications/Crew.app' --args --config "$HOME/Library/Application Support/Crew/instances/another-project/project.json"
```

An explicit `--config` normally points to an initialized file. If it is missing, guided setup offers deliberate creation at that path; a typo never creates a project silently. Before starting, edit that instance's identity, project context, repository/Linear settings and prompts. Give it a unique port and state directory. The menu bar identifies its configured project. Reusing the exact same config path opens its existing instance instead of launching a second controller. Config path determines desktop-instance identity; keep the path stable when replacing the app.

## Local diagnostics and CLI alternative

The instance's data directory contains private `desktop.log`, `desktop-status.json` and ordinary controller/task state. The menu bar opens its log folder. Inspect the exact failure before changing account login: a saved-chat writer conflict differs from an account failure. A stale or malformed marker/lock needs local inspection. Never kill the Codex desktop service to free a chat. Close a competing browser control tab if it has already claimed the instance's event stream.

With the source distribution and Node.js 22+, the existing CLI remains supported:

```sh
npm ci
npm run renderer:build
node cli.mjs init --template set1 --config ./instance/project.json
node cli.mjs doctor --config ./instance/project.json
node cli.mjs validate --config ./instance/project.json
node cli.mjs start --config ./instance/project.json
node cli.mjs status --config ./instance/project.json
node cli.mjs stop --config ./instance/project.json
```

`doctor` checks Node, Git, Codex and CLI ChatGPT login without starting voice or workers. It does not prove realtime or connector access. `validate` checks configuration/path/ref readiness without launching work. Foreground start is the default; optional `start --background` detaches the same process and writes `server.log`, without installing a service. Use the same `--config` for every command. Stop a CLI-owned instance with its CLI before opening that configuration in Electron.

Advanced packaged diagnostics can use the bundled runtime without installing Node:

```sh
app='/Applications/Crew.app/Contents'
env ELECTRON_RUN_AS_NODE=1 "$app/MacOS/Crew" "$app/Resources/app/cli.mjs" doctor --config "$HOME/Library/Application Support/Crew/instances/default/project.json"
```

`ELECTRON_RUN_AS_NODE=1` is only for this diagnostic command, not normal app launch.

## Updating and acceptance

Signed public releases use the GitHub native update feed: check and download through Updates, then explicitly restart when work is safely stopped. Normal Quit does not install an update. The signed 0.9.0 → 0.9.1 native upgrade is verified; see [release acceptance](RELEASES.md#signed-release-acceptance). Existing unsigned builds need one manual signed installation after stopping work and closing instances. Keep configuration and state outside the app bundle.

Before business edits, verify on the destination Mac: manager preparation; audible greeting, response and interruption; harmless scoped Linear read; bounded read-only worker using an isolated worktree; close-window continuation; pending question and manager-only answer; reopen and review verified completion. User speech and device audio must be checked by a person. Prior browser/Node acceptance does not automatically establish Electron microphone or lifecycle acceptance. Keep screenshots outside the repository.

No installation on the work Mac has been performed by preparing these artifacts. Its exact repository locations, base refs, account access and Linear mapping remain local setup requirements.
