<p align="center">
  <img src="docs/brand/social-preview.png" alt="Crew — a local Codex workspace for voice and text." width="960">
</p>

# Crew

**A local macOS workspace for coordinating persistent AI agents through voice and text.**

[Download for Mac](https://github.com/MattGibney/Crew/releases/latest) · [Set up a project](#set-up-a-project) · [Documentation](#documentation) · [Report a bug](https://github.com/MattGibney/Crew/issues/new) · [Contributing](CONTRIBUTING.md)

Talk to your manager, delegate work to agents, and follow their progress without juggling separate chats. Crew uses your existing ChatGPT/Codex subscription for model access. Each registered project has its own agents, native chats, profiles, skills, service connections and execution records.

Crew provides the interface, records and tools. Agents decide how to do their work using the instructions and skills you provide. Permission groups control capabilities, while connected-service credentials stay in Crew's execution gateway.

Release downloads and development source can differ. Consult the release notes for the capabilities in the build you install. Historical manager/worker documentation describes the earlier implementation; the unified application work is tracked in [#86](https://github.com/MattGibney/Crew/issues/86) and [#95](https://github.com/MattGibney/Crew/issues/95).

## Set up a project

Choose a project folder in the desktop, then use Settings to:

1. Sign in with your existing ChatGPT account in **Model access** to use that account's subscription. Crew keeps its native profile and configuration separate from your personal Codex setup; it does not copy personal authentication or use an API-key fallback.
2. Configure **Connections & access**, permission groups and an approved agent preset.
3. Approve a workspace in **Workspace** and assign its policy to the appropriate group when project file/command access is needed.
4. Create and select the primary agent. Use **Start** explicitly when ready.

Opening the app or adding a project does not start an agent, a project command or a microphone. The current workspace executor is local with no network; connected service operations go through the permission-checked gateway. Subscription connectivity alone does not prove an agent can perform project work.

The primary agent and workers retain their native conversations. Profile and selected skill changes apply on the next explicit Start or Restart. A saved profile is separate from the configuration acknowledged by an active session. User messages, delegation, delivery status, native approval and external service access remain distinct records.

## Conversation and background work

Type to the primary agent or select **Connect voice**. Explicit Connect authorizes microphone capture after connection and permission. Mute intent survives reconnection; navigation does not recapture or end an established call. End call, project switching and closing the window release media. Choose the next call's voice in Settings.

Workers remain available through the compact worker panel and worker history. Their workflow labels are separate from native process activity. Profile pictures use the normal choose, preview and remove controls.

Project skills are saved in Crew's private project store and can include bounded text resources. Active native sessions retain immutable selected revisions until Restart. Skill instructions do not grant permissions. See [project skills](docs/PROJECT-SKILLS.md).

Schedules are per agent and are empty in a fresh project. Their delivery contract uses private native turns: public conversation waits across a private turn, and private work waits across public work or connected voice. The scheduler never invents a human message or automatically starts a stopped agent. The runtime rechecks the current schedule at atomic admission; genuine signed-in overlap acceptance remains part of the final walkthrough.

## Native lifecycle

Closing the window keeps the menu-bar host and independent work running. **Quit Crew** requests continuation/readiness from every registered project, then checks current execution and reserves every project before closing any composition. Preparation does not stop communication or authorize shutdown. New work can invalidate readiness.

Updates retain Developer ID verification, native instance checks and an installation lease. Download and installation are separate actions. Installation requires explicit action and fresh reservations; unsigned candidates cannot install automatic updates. No lifecycle action deletes project source or retained work.

New state lives below:

```text
~/Library/Application Support/Crew/unified/
  projects.json
  projects/<project-id>/
```

The replacement does not migrate, reset or merge the older installed app's state. For isolated validation, set `CREW_APP_DATA` to a private disposable directory. Keep evidence, credentials, images, conversations and installers out of Git.

## Develop and package

```sh
npm ci
npm run typecheck
npm run build
npm run desktop:dev
npm run desktop:build:mac
```

Both the package entry and generated runtime package start `desktop/main.mjs`. `npm start` / `crew start` opens that same desktop application. Legacy CLI controller commands explicitly report that they are unsupported; they do not start a second manager backend.

Build on an Apple Silicon Mac. Local builds are unsigned candidates. Deliberate production publication requires the configured Apple signing/notarization workflow and full release acceptance. See [release setup](docs/RELEASES.md) and [updates](docs/UPDATES.md).

Crew uses React TypeScript, shadcn/ui, Lucide and the canonical semantic theme. See [UI foundation](docs/UI-FOUNDATION.md), [unified composition](docs/AGENT-UNIFIED-COMPOSITION.md), [access controls](docs/ACCESS-CONTROLS.md), and [TypeScript workflow](docs/TYPESCRIPT.md).

## Documentation

| I want to… | Read |
| --- | --- |
| Understand agents, native sessions and message delivery | [Unified composition](docs/AGENT-UNIFIED-COMPOSITION.md) |
| Configure reusable project skills | [Project skills](docs/PROJECT-SKILLS.md) |
| Understand permission groups and service access | [Access controls](docs/ACCESS-CONTROLS.md) |
| Recover an interrupted project | [Project recovery](docs/PROJECT-RECOVERY.md) |
| Understand updates and signed publication | [Updates](docs/UPDATES.md), [release setup](docs/RELEASES.md) |
| Contribute code or report an issue | [Contributing](CONTRIBUTING.md), [TypeScript workflow](docs/TYPESCRIPT.md) |
| Maintain the approved logo and social preview | [Brand assets](docs/brand/README.md) |

## Acceptance boundaries

Type/build checks, synthetic UI walkthroughs and unsigned-in native probes are separate from a signed-in agent completing real project work. The current PR records the measured scope and outstanding owner sign-in/native acceptance. Historical microphone, signed-update or installed-app results are not proof for this replacement.
