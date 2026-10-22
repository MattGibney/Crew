# Unified desktop integration (#95)

The package entry, development entry and `crew start` open `src/desktop/main.mts`. That host starts the canonical `startUnifiedApplication` composition for each registered project. It does not start the legacy manager controller. The renderer reuses Crew's existing conversation, workers, scratchpad, profile controls, settings layout and semantic theme.

## Ownership and boundaries

- The desktop registry owns project selection, canonical source folders, the presentation port and the selected voice. Each project composition owns agents, conversations, approvals, access, environment execution and native sessions. The saved primary agent is explicit; an empty primary selection never falls back to the first agent.
- The static loopback server serves only pinned renderer assets. Owner commands use the bounded Electron preload and must originate from the current main frame and exact origin. Credentials and native authentication do not cross that bridge. Images are validated private project files read through owner IPC, never an HTTP state route.
- Skills are project-owned native `SKILL.md` bundles with immutable selected revisions. The composition's authorization/admission wrapper governs their agent tools. See [Project skills](PROJECT-SKILLS.md).
- Voice uses the composition-owned primary voice service. The desktop adapts validated owner commands; it does not create another handoff, turn or settlement authority. One mounted renderer hook owns media while controls move between presentation modes. Explicit Connect is required; automated validation uses synthetic media.
- Per-agent schedules reuse the existing cadence/checkpoint engine and have no default occurrence. The desktop passes the scheduler's current-state check into foundation admission, where it runs before persisting private delivery intent. A disabled or changed schedule is rejected there without leaving a queued message.
- Project setup uses subscription status, access-owner operations and the environment-owner API. Approve a folder in Workspace settings, then select that folder in a permission group and assign the group to the agent. The group editor displays paths and read/write access from current project workspace records. Approval of a path alone does not grant an agent access or prove actual project execution.

## Native lifecycle

Closing the window releases voice/media and keeps the menu-bar host and independent work alive. Explicit Quit prepares all projects and observes the same readiness request while conversation remains available. Final reservations are acquired for every project before any project is closed. If closing begins but cannot be confirmed, retain reservations and report recovery required; releasing a partially disposed composition is not a safe Return to work.

Updates adapt the existing signed-update coordinator. A shared installation lease covers startup and installation, and other native instances are checked. Explicit installation requires fresh all-project reservations. Unsigned candidates cannot establish a stable update feed or install automatically. This track does not install or replace the user's existing Crew app.

The renderer retains submitted and newly typed drafts across async acknowledgements. Settings editors remain mounted across navigation, and revision conflicts preserve the user's draft. A rebuilt pinned renderer requires a controller restart before native validation; a successful build does not update an already open editor.

## Acceptance record: 22 October 2026 checkpoint

Verified on this track:

- TypeScript checks and the complete typed runtime/renderer build.
- A real isolated Electron launch, native source-folder picker, project creation and the actual native `sign_in_required` result displayed in Model access. No agent or microphone started. A real form-submit defect was found and fixed by this walkthrough.
- After the native system CA and sign-in lifecycle fixes, a normal Quit/rebuild/reopen preserved the exact project registry and presentation port. The actual app received a device code and official verification link. Issuance is verified; completed owner authentication and model work remain separate acceptance steps. Action errors survive status refresh, and bounded native failure status replaces stale codes and misleading waits.
- Workspace group selection, save and reopening were checked through the real access-owner API and durable access store in a disposable UI fixture. An unavailable existing grant survived an unrelated save; explicit removals persisted. This proves the grant editor, not actual agent execution.
- Bounded synthetic desktop/narrow renderer checks covering layout, draft retention, explicit primary selection, profile conflict, image handling and voice control lifetime. These do not prove a model or physical microphone worked.
- Private skills storage/renderer checks, image validation and project isolation, and synthetic all-project update reservation/rollback/recovery checks. No updater installation occurred.

Still required before claiming complete replacement acceptance: completion of the owner's supported native sign-in, real project-capable primary/worker work, retained-chat restart, real schedule overlap checks, current packaged launch and native lifecycle with active/retained agents. The installed native runtime's resumed environment selection is also a separately documented runtime limitation. See [access isolation](ACCESS-ISOLATION.md) and [unified composition](AGENT-UNIFIED-COMPOSITION.md).

Private screenshots, fixture state, native logs and authentication remain outside Git. Historical installed-app and microphone evidence does not establish acceptance of this source.
