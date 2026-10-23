# Agent folders and project index (#133)

Each agent has its own stable filesystem folder and a core `agent.json` record. Every agent folder is a peer, whether its role is engineering manager, marketing specialist or implementation worker. `reportsTo` stores the relationship; it never determines the directory path.

A project’s private storage has this logical layout:

```text
project-state/
  foundation/
    foundation.json              # project settings, coordination data and agent references
    foundation.lock              # exclusive writer ownership
    agents/
      <agent-id-or-safe-key>/
        agent.json               # that agent’s core record
        assets/                  # private agent-owned assets
      <another-agent-id>/
        agent.json
        assets/
  access/                        # canonical shared groups and connections
  vault/                         # encrypted credentials, never agent-visible
  environment-templates/         # shared definitions and agent assignments
  native/                        # runtime-owned chats and retained runtime state
  voice-artifacts/               # retained voice text referenced by agent/thread
```

Ordinary generated IDs can be used directly as folder names. Other identifiers use a deterministic safe key; stored references are validated rather than interpreted as arbitrary filesystem paths. An agent ID, its folder and native thread references remain stable when its manager changes. Archiving an agent retains its folder, notes and history.

New agents receive immutable UUIDs. Renaming an agent changes its profile only. Existing IDs are retained. Each `agent.json` has its own `schemaVersion: 1`, independent of the project index version. Previous unversioned core files are version zero and are upgraded through the same recoverable transaction; unsupported future versions stop loading without rewriting the file. Runtime API snapshots do not include disk-format metadata.

## What belongs where

`agent.json` stores the existing core agent data: stable identity, profile/instructions/personality/voice references, scratchpad, runtime/session/thread references, reporting relationship and resource references. Group-derived access remains authoritative in the shared access store; retained projections in agent records do not become another permission authority.

Project-wide settings, jobs, delivery receipts and coordination state remain in the project index. Its agent entries contain exact ID/directory/file references and integrity hashes instead of duplicated inline core objects. The in-memory FoundationStore snapshot and owner API still assemble normal agent records, so product callers do not implement a second loader or manage filesystem paths.

The asset directory provides an agent-owned location. Existing immutable project image references remain valid in the current image catalogue; this change does not duplicate shared images or claim that old assets were moved. Environment working directories and browser/native runtime state remain independent resources. Codex chat history, reusable skills, shared service connections and encrypted credentials are referenced from their canonical stores, not copied into agent folders.

Crew must not put credential values, authentication tokens or gateway secret payloads in agent records. These files reference central connections and permission groups. User-provided instructions, scratchpad text and assets can contain private business information; keep the folder private rather than treating credential separation as a guarantee that its contents are public.

## Archive, restore and permanent deletion

Archive is the default removal action, available for every agent in Settings as well as worker controls. Crew confirms Stop before archiving. Archived agents disappear from normal contact, worker and agent-management choices. Settings → Archived agents lists their names, immutable IDs and last-used dates with Restore and Permanently delete actions. Last use records actual session start, message acknowledgement and native turn activity; rename, archive and restore do not make an agent appear recently used. Unknown legacy dates remain unknown, and newly created unused agents show Never used.

Restore is owner-only, keeps the same UUID, profile, scratchpad and native thread, and leaves the session stopped. Permanent deletion is owner-only, requires an archived confirmed-stopped agent, and has a separate confirmation. Uncertain in-flight delivery must be reconciled first. It removes the core record and owned agent folder; a prepared journal completes interrupted folder removal before normal loading resumes. It never follows asset symlinks to delete external targets.

Surviving children report to the owner and current jobs become unassigned. Minimal deleted-ID markers preserve historical job, delivery and attribution references without retaining an active agent. Shared resources, service accounts, credentials, native runtime history and existing recovery snapshots are not deleted by this operation; it is agent removal, not a secure erasure of every historical reference.

Keep agent-owned files together, but export/import and dependency packaging are explicitly deferred. No archive download or import flow is added here.

## Committing a change

The project has one exclusive writer, as before. A save prepares a durable recovery journal before changing agent core files. It writes changed cores atomically, publishes the project index only after those cores are durable, then clears the journal. The normal committed layout has no pending transaction file.

On reopening after interruption, the loader validates and completes a prepared transaction before exposing state. It accepts only the expected previous index or the exact prepared committed index. Unknown state, unsafe paths, ownership changes, symlinks, missing records, duplicate IDs, invalid core data and integrity mismatches fail closed; they do not reset a project or silently omit agents.

A write whose acknowledgement was lost may have committed. Retain operation identity and use ordinary state reconciliation; do not assume failure proves that a mutation never happened. External readers should use the owner API or open a safely stopped project rather than treating an in-progress filesystem write as a consistent snapshot. Direct file editing while Crew runs is unsupported.

## Migration

The loader accepts the existing inline foundation format, validates the whole project, and retains a private exact legacy snapshot before committing peer agent files and the new index. It preserves IDs, native thread references, profiles, notes, relationships and project coordination records. The legacy snapshot is recovery provenance, not a second current authority.

The disk index uses schema 2; assembled runtime snapshots still use schema 1. Older builds cannot read the new disk index. The legacy snapshot covers the migration point only, so restoring it later would discard subsequent changes and must be an explicit recovery decision.

No live owner-state migration, installation or replacement is authorized merely by changing this source. Acceptance must use disposable state. Existing native chats, sign-in, credential files and project source must not be moved, copied or rewritten as part of this storage conversion.
