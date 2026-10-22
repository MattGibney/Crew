# REL-0.17.2 — Correlated native evidence and grouped release

The human authorized PRs 67–69, combined fixes/testing, merge and one signed stable release. Feature histories merged through PR70; PR71 corrected shared-controller cleanup, and PR72 corrected native conversation observations. PR54 remains open and excluded. Public stable 0.16.2 is the preceding release.

## Preserved failed attempts

Unpublished v0.17.0 remains at 122d76e. Workflow 39749947913 attempt 1 passed tests, signing and notarization but lost its Apple CloudKit connection during final stapler validation. Attempt 2 exposed a shared-controller fixture deletion race and was canceled after its failed cleanup left another polling fixture alive. Every shared controller now drains before any registered state root is removed; all cleanup is attempted and failures remain visible.

Unpublished v0.17.1 remains at f4c244d. Workflow 39755188666 completed 749/751 before signing/publication: two continuity tests captured process liveness before native thread identity arrived. A controlled delayed startup proves this boundary. Continuity snapshots now require nonempty thread identity, matching execution run and current-run progress. Exact identity assertions, timeouts and application source remain unchanged. No tag, failed-run history or published artifact was rewritten.

## Validation and publication

Exact CI Node 24.22.0 passes strict TypeScript, a fresh build and all 752 tests. The final controller file passes 22/22 and 15 controlled targeted repetitions pass 45/45, with fixture exits confirmed. Hosted unsigned candidate [39756532957](https://github.com/MattGibney/Crew/actions/runs/39756532957) checks out b8a29eb, passes 752/752 and packages successfully before the release tag is created. PR72 merges that exact tree at a6302234293db8b087ce86f571b385c002366865.

[Crew 0.17.2](https://github.com/MattGibney/Crew/releases/tag/v0.17.2) is public/latest from immutable v0.17.2 at a630223. [Signed workflow 39757381433](https://github.com/MattGibney/Crew/actions/runs/39757381433) passes 752/752, Developer ID signing, notarization, final staple/Gatekeeper/DMG/feed verification and publication. Published 22 October 2026 at 09:50:54 UTC. All six public assets download anonymously; SHA256 manifest, ZIP SHA512 and latest feed match. Independent strict signature, expected public certificate identity, hardened runtime, staple, Gatekeeper and DMG integrity pass. All 386 packaged runtime/renderer files match the tagged build; TypeScript source/compiler is absent. All 488 source files and 178 newly reachable blobs were reviewed without actual secrets; unchanged invalid negative-test key markers are dispositioned.

## Signed native upgrade acceptance

Disposable signed 0.16.2 → signed public 0.17.2 manual replacement passes default and custom projects. Pristine defaults migrate; custom prompt bytes remain intact. The active manager snapshot stays unchanged until explicit Restart; manager conversation, worker thread/worktree, prior run configuration/results and assignment history survive. The continued worker uses the new saved worker instructions. Actual bound preparation tools acknowledge readiness and naturally settle Quit. The retained Quit hold positively returns HTTP 409 before explicit Return to work releases the exact owned plan. Final native Quit exits normally; both backend ports and all fixture processes are absent afterward. Screenshots were visually reviewed and remain outside Git.

This uses synthetic native provider peers with zero voice/realtime starts and no physical microphone. It proves explicit-profile manual replacement continuity, not automatic updater installation, live provider behavior or human acoustic acceptance. The known portable-root automatic-relaunch and issue #39 limits remain separate and unresolved. The installed app, user profiles/auth/live workers and business services remain untouched. Signing credentials remain owner-managed encrypted GitHub secrets; verification identity comes from the public baseline certificate.

The grouped features and five compiled UI suites remain documented in [REL-0.17.0](REL-0.17.0.md) and [REL-0.17.1](REL-0.17.1.md) at their stated versions. This evidence follow-up changes documentation only and does not create another release.
