# Project instructions and manager controls

Tracked by [GitHub issue #3](https://github.com/MattGibney/crew/issues/3).

Open **Settings** in the Crew header. Global → General controls shared worker capacity on this Mac. Project → General renames the selected project; Sessions provides Start/Stop/Restart; Manager profile contains voice and manager instructions; Worker profile contains worker instructions. The floating navigation sits beside the content. Choose Update to edit, Save to persist, or Cancel to discard that editor’s unsaved changes. Save confirmations appear as dismissible toasts; guidance stays below the instruction editor. The two editors contain the complete Crew-authored behavior for this project's manager and workers. A custom save replaces that role's defaults; it is not an extra layer. These editors do not expose or override Codex/provider system instructions, sandbox enforcement or tool schemas. Do not put credentials in instructions.

The default behavior includes communication, delegation, scope, reporting and the voice startup greeting. Crew adds separately identified runtime context: project/task/run identity, sandbox permissions, controller/report bindings, task briefs and relayed answers. Realtime receives the active manager behavior plus the selected voice and a factual connection event. Connection acknowledgement does not append another hidden greeting instruction or start a user turn.

**Save instructions** persists the current editor. **Cancel changes** discards only the unsaved draft. **Reset to default** loads the complete shipped default into that editor; save it to persist the reset. Resetting one role does not affect the other. Drafts survive switching between Settings and Conversation, and failed/stale saves preserve text. A concurrent saved change requires reviewing the latest version rather than overwriting it silently.

Manager saves remain pending until **Restart manager**. Saving never hot-applies a prompt or starts a turn. Settings shows a plain Start/Restart notice when saved instructions are not active; internal version checks remain in place without exposing hash labels. Restart resumes the saved native chat with the saved instructions; it retains conversation history, project tasks and workers. Stop followed by an explicit Start also applies saved instructions. Reloading the window or controller preserves the retained manager instructions and stopped intent; it does not silently activate a newer saved manager prompt.

Worker changes affect the next actual first launch. An already launched worker retains its original text and version on answers, pause/resume and controller recovery. Its retained task detail exposes that snapshot for review. Legacy workers recover their original prompt from the recorded run configuration; if that source is unavailable, resume refuses rather than changing behavior.

## Start, stop and recovery

- **Stop manager** immediately holds new conversation/voice requests, releases voice, waits for pending starts, requests native interruption and waits for terminal turn/approval evidence before confirming process exit. It does not stop the controller, workers, worktrees or environments.
- **Start manager** resumes the retained conversation and saved instructions. It never connects voice, activates a microphone, starts backlog or launches a worker. Use Connect voice explicitly for a new call.
- **Restart manager** uses the same safe stop, then resumes the same retained chat with saved instructions. Repeated matching actions share the transition; conflicting actions wait for its result.
- If native interruption, approval resolution or process exit cannot be confirmed, Settings shows an actionable error and holds new interactions. Pending approvals remain answerable in Conversation; review or decline them, then retry Stop/Restart. No approval is fabricated and no worker is killed to clear the error.

Workers report durable progress, questions and results while the manager is stopped. Their attention remains visible and can be discussed after Start. Stopping a single manager turn remains a separate **Stop current turn** control. Closing the window still releases voice while leaving the manager/controller and independent workers available in the background. Explicit application Quit remains separate.

## Persistence and integration

Settings are stored privately under this project's state directory at `prompt-settings/<projectId>.json`. Atomic replacement, file mode 0600, project identity, content hashes and optimistic version checks protect saved values. The configured Markdown files remain unchanged and provide the initial content when no settings save exists. Exact byte-for-byte untouched pre-settings shipped defaults are recognized by known hashes and upgraded to the complete visible defaults. Customized files, explicit saved settings and retained worker snapshots are never upgraded by this migration.

`manager-lifecycle.json` records project identity, held/running intent and the retained manager text/version. A transition persists held intent before changing the provider session. Only successful native activation advances the retained active version. A damaged or mismatched record fails closed and remains available for recovery. Do not delete state to clear a lifecycle error.

The instance-scoped HTTP contract is:

- `GET /api/settings`: project identity/name, manager voice profile, saved/default prompts, manager active/retained versions and pending changes, plus lifecycle state/error.
- `PUT /api/settings/manager-profile`: `{voice,expectedVersion}`. Saves the project voice for its next call; existing calls are unchanged. Prior project-partition preferences migrate once when no explicit profile exists.
- `PUT /api/settings/prompts`: `{role,text,expectedVersion}`. Same-origin JSON only; invalid, oversized or stale edits leave saved settings unchanged.
- `POST /api/manager/lifecycle`: `{action:"start"|"stop"|"restart"}`. Same-origin JSON only. Update admission prevents new lifecycle work during an installation reservation.
- SSE `manager-lifecycle`: `{state:{state,error,activeVersion,retainedVersion}}` on the existing single event stream.

The separate multi-project change can route these endpoints to a selected project's own backend/config/state/port. This feature adds no registry or global prompt. The separate coordinated updater must use lifecycle transition/error evidence and installation admission; manager stop alone does not pause workers. Combined multi-project/updater integration requires testing after those independent PRs are integrated.

## Validation scope

Automated tests inspect actual instructions sent through a disposable child JSON-RPC bridge and actual detached worker CLI arguments. They cover replacement, persistence/reset, active/saved versions, stopped recovery, start races, active turns, unresolved approvals, interruption failure, voice shutdown, snapshot retention and independent worker survival. Browser acceptance uses the compiled React UI with synthetic media, including desktop and narrow screens; screenshots and private operational evidence stay outside Git.

A disposable check against the installed subscription Codex app-server verified prepare, saved changes pending explicit restart, restart activation, stop hold and Start on the same native chat ID, with no active turn or voice connection. Physical microphone, acoustic greeting quality and combined unmerged-feature behavior are separate acceptance boundaries.
