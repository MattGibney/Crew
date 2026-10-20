# Crew storage, identity and migration (AI-009)

Crew is the final product name, replacing Relay and Local Voice Manager. The selected Four bold shapes artwork is the app icon and interface mark; no redesign was applied. New desktop and default CLI configuration is:

```text
~/Library/Application Support/Crew/
  instances/default/project.json
  instances/default/prompts/manager.md
  instances/default/prompts/worker.md
  instances/default/.data/                 controller logs, chat reference, tasks, worktrees
  desktop/<instance-key>/                  Chromium preferences/session data
  desktop/<instance-key>/logs/             Electron logs
  desktop/<instance-key>/crash-dumps/       Electron crash path
```

The exact configuration controls prompt/state paths. `--config` takes priority over `AI_MANAGER_CONFIG`; either selects an explicit configuration and keeps its configured external storage paths. A separate project requires a separate config/state/port. CLI `init`/`start` without an override use the Crew default and run storage checks. Direct `node server.mjs` remains a developer/legacy prototype entry point; normal desktop startup always passes its explicit resolved instance config. Source archives are named crew-<version>-source.tar.gz. Discovery/fixture temporary folders use Crew prefixes.

## Safe legacy handling

Before the desktop opens a controller, it detects previous defaults under Application Support/Relay and Application Support/Local Voice Manager. If exactly one previous default exists and Crew has no competing default, migration can move a closed, quiescent instance directory and its corresponding Chromium profile into Crew. Chat references, prompt bytes and saved next-call voice are retained. Known absolute config paths inside the moved directory are rewritten by path boundary, not broad text replacement. The previous JSON is backed up as project.json.before-crew-migration.json.

A durable journal and staged configuration precede the moves. Source/config/proposed-content fingerprints and directory/profile provenance prevent retry from overwriting changes made during an interruption. Recovery resumes either move and cannot be bypassed by supplying the partially moved config explicitly. The original Chromium partition key is retained in crew-storage.json, avoiding a fresh voice-preference partition.

Compatibility symlinks at previous instance/profile locations point to the new Crew storage. Actual migrated files and new writes live under Crew; the links let old absolute references resolve and help prevent a previous app from silently initializing another default. Do not delete these links as routine cleanup. Old app binaries remain old versions; use Crew going forward.

Migration is deliberately blocked for a live controller/profile, competing defaults/profiles, unreadable ownership, saved task/run/worktree/archive evidence or a repository nested inside the storage being moved. Git worktrees can contain absolute references, so these cases are not blindly relocated. The recovery screen explains the issue and offers retry, storage-folder inspection and explicit selection of an existing Crew/previous config. Selecting previous configuration preserves its old location as an explicit override for recovery; it does not claim that all old task storage moved. It may recover already-authorized queued work through the existing controller lifecycle. Nothing is reset, deleted, merged or force-stopped. Resolve collisions/edited journals through inspection rather than deleting evidence.

Custom configurations are not moved. A closed legacy desktop profile for that exact config may move under Crew with a compatibility link and unchanged partition key. An active legacy owner blocks that migration until its own app is quit. Different project instances can keep running.

## Deliberately retained compatibility identities

- Bundle ID `local.voice.manager` remains stable; changing it would create a different macOS application identity. Permission behavior still depends on macOS/signing; retained ID is not a promise of pregranted permission.
- `ai-manager` remains a CLI alias; `crew` is the primary command.
- Saved `relay.voice.v3` / `ai-manager.voice.v3` preferences are read as legacy fallbacks and promoted to `crew.voice.v3`. No old preference is deleted.
- Codex manages its own shared sign-in and conversation storage. Crew does not move, copy or reset authentication credentials or shared Codex history. Instance files retain only their normal manager-chat reference.

The release remains unsigned/unnotarized arm64/macOS13+ with manual updates. Quit the relevant previous instance before replacement; preserve configuration and state. No microphone, voice conversation, account reset or new business task starts for naming/migration.
