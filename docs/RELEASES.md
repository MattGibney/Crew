# Delivery policy

Develop features/fixes on codex/ branches and open pull requests targeting main. Review and merge are separate from release publication; agents must not automatically merge or publish a release for each small change. The user chooses the set of changes and explicitly authorizes the intended grouped release. Existing releases and main history remain intact. The workflow stays manual-dispatch only; creating a branch, PR, merge or tag must not automatically publish.

# Building and publishing Crew

Crew releases are deliberately initiated through **Build or release Crew for macOS** in GitHub Actions. Normal pushes, pull requests and tag creation never publish installers.

## Before the first production release

The repository must have completed its source/history publication review and be public. Making the current tree safe does not remove historical content; retain the original private evidence and obtain the chosen history disposition before changing visibility. No history rewriting is performed by the release workflow.

Production macOS releases require an active Apple Developer account, a **Developer ID Application** certificate and notarization access. This is distribution outside the Mac App Store; no App Store submission is required. The bundle identifier remains `local.voice.manager`.

Add these encrypted repository secrets through GitHub Settings → Secrets and variables → Actions. Do not commit credentials, pass them to the renderer, or copy them into an installed app:

| Secret | Required value |
| --- | --- |
| `CSC_LINK` | Base64-encoded password-protected P12 containing the Developer ID Application certificate and private key |
| `CSC_KEY_PASSWORD` | P12 password |
| `APPLE_API_KEY_BASE64` | Base64-encoded App Store Connect API private-key P8 file |
| `APPLE_API_KEY_ID` | API key identifier |
| `APPLE_API_ISSUER` | API issuer identifier |
| `APPLE_TEAM_ID` | Apple Developer team identifier that must sign the app |

The account owner supplies these credentials. Crew never exports a local signing private key or purchases/enrolls an account. The build writes the notarization key into a private temporary file and removes it afterward; electron-builder manages its temporary signing keychain. Application credentials are available only to the signing/build step, not dependency installation, tests or the renderer build. The publishing job uses GitHub's short-lived workflow token, never an app-embedded token.

## Unsigned CI validation

Run the workflow with `mode: candidate`, `publish: false` and the requested source ref. It runs the full tests and builds Apple Silicon DMG, ZIP, blockmaps and SHA256 checksums as a private/public workflow artifact according to repository visibility. **It emits no `latest-mac.yml` or packaged `app-update.yml`**, and cannot publish a GitHub Release. Unsigned candidates explicitly report that automatic updates require a signed release.

Local equivalent: `npm ci && npm run desktop:build:mac`. Output is `dist/desktop/candidate/VERSION/`. These are test artifacts, not production update builds.

## Signed production release

1. After the user explicitly chooses the grouped release, review/merge its feature PRs through the agreed workflow. Prepare the matching stable `package.json`/lockfile version through a PR targeting `main`, then run the required checks. Do not push implementation directly to `main`.
2. Create and push the matching `vMAJOR.MINOR.PATCH` tag deliberately. Tags do not trigger publishing.
3. Run the workflow from its default branch, selecting that exact tag as `ref`, `mode: release`, and `publish: true`.
4. The workflow validates exact version/tag identity and main ancestry, public repository status and required credentials. It builds with hardened runtime, Developer ID signing and notarization, then checks signatures, team, stapled ticket, Gatekeeper, DMG integrity and ZIP metadata.
5. A separate least-privilege job verifies checksums, creates a draft release, uploads the full artifact set and only then makes it the latest release. Existing versions are never overwritten. An interrupted draft can be inspected before retrying; it is not a live update feed.

The complete public release contains `Crew-VERSION-arm64.dmg`, `Crew-VERSION-arm64.zip`, both `.blockmap` files, `latest-mac.yml` and `SHA256SUMS.txt`. The ZIP and metadata are required for macOS updating; a DMG alone is insufficient. Local signed validation uses `RELEASE_TAG=vVERSION npm run desktop:build:mac -- --release` with the required credentials already configured securely. This local command never publishes.

The workflow pins official GitHub Actions by immutable commit SHA and uses a fixed Node version plus `npm ci`. Build jobs have read-only repository permission; only the publishing job receives `contents: write`. No PR-supplied code receives signing secrets through this workflow.

## Current acceptance limits

A machine without a valid Developer ID identity and configured signing secrets can validate source, tests, candidate artifacts, update coordination, feed/checksum handling and state preservation. It cannot prove signed installation, notarization or the native two-version automatic upgrade. Do not publish placeholder credentials, unsigned candidates or a release described as working around that requirement. Existing unsigned installations need one manual installation of the first signed updater-enabled release.

Primary references: [electron-builder v26 updates](https://www.electron.build/v26/docs/features/auto-update/), [macOS configuration](https://www.electron.build/v26/docs/mac/), [Electron autoUpdater signing requirement](https://www.electronjs.org/docs/latest/api/auto-updater).


## Signed release acceptance

The public [0.9.0](https://github.com/MattGibney/crew/releases/tag/v0.9.0) and [0.9.1](https://github.com/MattGibney/crew/releases/tag/v0.9.1) releases completed signing, notarization and publication. The [0.9.1 workflow](https://github.com/MattGibney/crew/actions/runs/39559911796) passed 200 tests and all production verification gates. Independent local verification accepted the downloaded/installed applications as Notarized Developer ID with bundle identifier `local.voice.manager`.

An isolated signed 0.9.0 installation fetched 0.9.1 from the production feed, downloaded it through electron-updater and completed a native install/relaunch after explicit Restart. It retained the same configured project and byte-identical configuration, editable prompts and saved-chat files. The upgraded application again passed signature, stapled-ticket and Gatekeeper checks. No physical microphone or business worker was started; the test copy was stopped afterward and the existing user installation was preserved.

## Grouped release 0.10.0

The user explicitly selected PRs 4–7 and version 0.10.0 for one grouped signed release. Their complete histories are retained through the integration branch and reviewable integration PR; no squash or history rewrite is required. Combined acceptance covers shared toolchains, prompt/manager lifecycle, multi-project capacity and all-project pause/update recovery. Publication is authorized for this named release only. Later features continue through PRs and wait for another explicit release selection.
