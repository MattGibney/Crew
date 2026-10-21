# Contributing to Crew

Crew is a small, actively developed project. Start with an [issue](https://github.com/MattGibney/Crew/issues) describing the problem, expected behavior and scope before taking on a substantial change.

## Report a bug

Include your Crew, macOS and Codex CLI versions, the steps to reproduce, and what you expected versus what happened. Share only the smallest useful sanitized diagnostic excerpt. Never upload credentials, signing material, private conversations, project configuration or worker data. Repository screenshots should use disposable mock data; do not commit screenshots unless explicitly requested.

For a suspected security problem, do not include exploit details or secrets in a public issue. Use GitHub's **Report a vulnerability** option if it is available; otherwise start with a public request for a private reporting channel containing no sensitive details. This repository does not claim a separate monitored security inbox.

## Work on a change

1. Agree a ticket and scope. Read [AGENTS.md](AGENTS.md) and the relevant [architecture documentation](docs/ARCHITECTURE.md).
2. Create a separate branch, normally `codex/<short-description>`. Keep runtime settings, credentials, conversations, worker state, installers and screenshots out of Git.
3. Keep the change focused. Reuse project tooling and native Codex capabilities rather than adding service-specific behavior to Crew unnecessarily.
4. Validate the actual user flow. Application changes need appropriate tests and end-to-end verification; state what you checked and what remains unverified. Documentation-only work needs link and rendering checks rather than unrelated application tests.
5. Open a pull request targeting `main`, link its issue and explain the resulting behavior and validation. A PR is not authorization to merge or publish a release.

## Local development

Use Node.js 22+ and install the lockfile dependencies with `npm ci`. `npm test` builds the renderer and runs automated checks. `npm run desktop:dev` builds and opens the desktop app. A compatible Codex CLI and ChatGPT/Codex subscription sign-in are needed for real agent and voice flows. Do not use a physical microphone during automated acceptance.

See [UI foundation](docs/UI-FOUNDATION.md), [configuration](docs/CONFIGURATION.md) and [Mac operations](docs/MACOS.md) for the relevant workflow. Use disposable configuration for testing rather than your working project state.

## Releases and public assets

Releases are deliberately selected and published through the [release process](docs/RELEASES.md). Do not bump a version or publish installers as a side effect of an unrelated change.

Reuse the [approved Crew brand assets](docs/brand/README.md). The repository currently has no project license file; public visibility does not itself grant a general reuse license. Do not describe the project as permissively licensed or add a license badge without the owner's decision.
