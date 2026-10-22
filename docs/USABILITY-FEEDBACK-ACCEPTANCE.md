# First-use feedback acceptance (#100–#102)

The three implementation PRs target `codex/unified-agent-platform`:

- #104: guided service accounts and explicit folder grants.
- #105: resumable first-use and later-agent setup, permission selection and existing-agent access repair; depends on #104.
- #103: native chat-history paging and refresh after session changes.

The combined review candidate includes #104 at `0791931`, #105 at `dd90ed5`, and #103 at `fc01a30`. Overlapping changes retain the latest saved-connection lookup, authenticated environment self-target resolution, setup guidance and acceptance records. No PR or tracking-branch merge, installation or release is implied by this local candidate.

## Completed checks

- Combined `npm run typecheck` and `npm run build` passed.
- All 18 focused checks passed in `tests/agent-setup.test.mjs`, `tests/unified-desktop-boundaries.test.mjs` and `tests/unified-quit.test.mjs`.
- The production combined chat view and Foundation ran in a disposable browser fixture. Older loaded messages remained visible after changed-profile Restart. A private/unknown newest page still led to the older public messages, while private/unknown content remained hidden. Separate controller checks covered prior-session attribution, profile changes, stopped/reopened reads and filtered native pages. These browser/controller checks used a synthetic runtime, with no model calls or microphone.
- The onboarding implementation's isolated real Codex/Electron walkthrough proved selected-folder reads with read-only enforcement, then successful file creation/read after owner permission repair in the same running native chat. Parent-folder access stayed denied. Fresh no-agent setup, draft retention, later stopped-agent creation, optional service Skip and normal Stop/Quit were also exercised.
- The service implementation's actual renderer/API/vault/controlled-MCP flow covered corrected-token retry, account edits, stale reviews, lost committed-save response, cancellation, reuse, optional Skip and a narrow layout. Controlled providers observed no service-tool execution or external destinations.

## Remaining acceptance limits

- Earlier voice transcripts still cannot be restored: exact native voice-to-coding-turn linkage is unavailable in the pinned runtime. The UI and history documentation disclose this. Typed-history checks do not establish voice-history recovery.
- Live Linear/GitHub credentials and operations were not exercised. Guided setup uses owner-entered service tokens; no newly registered interactive OAuth client is claimed. Personal and dedicated account choices are explicit.
- Fresh authentication and authenticated creation in a brand-new project were not repeated. Authenticated creation used the previously approved isolated signed-in fixture; the new-project sign-in gate was checked separately.
- Unknown creation/delivery outcomes retain evidence for reconciliation rather than silently creating duplicates.
- The installed app and the owner's live test profile were not changed. Packaged upgrade/release acceptance is outside these fixes.
