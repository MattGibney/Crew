# REL-0.14.0 — Grouped manager and retained-worker release

The user explicitly authorized a production release before continuing TypeScript. This release packages the six-feature integration merged through [PR #48](https://github.com/MattGibney/Crew/pull/48): manager scratchpad #26, manager profile #35, voice handoff presentation #38, repeated worker assignments #42, archive/history restore #43 and environment Settings #45. TypeScript #37 remains paused after publication until a later explicit user decision.

Only package/lock version metadata and release documentation change from the combined tested source. The integration passed 613 tests, five compiled browser suites, packaged scratchpad/environment/archive acceptance and bounded real subscription manager/worker checks. The release workflow reruns the full suite and requires Developer ID signing, notarization, stapling, Gatekeeper and verified update metadata before publication.

## User benefits

- Remember explicit commitments and review useful outstanding work in a project scratchpad.
- Configure the manager's name, picture and personality while retaining explicit instruction activation and voice preferences.
- Keep voice conversations readable, with exact backing work available in expandable details.
- Give retained workers additional authorized assignments without losing their conversation, worktree or completed results.
- Archive finished workers, restore their history without execution, or explicitly delete local archived evidence.
- Correct worker lifecycle commands in Settings; existing workers use them at their next explicit action, with failed setup retry preserving partial data and earlier attempts.

## Release boundaries

Quit issue #39 remains unresolved. The same post-voice native profile-harness timeout reproduced on exact unintegrated PR #40 and combined source; this is preservation relative to that feature baseline, not proof of its original cause. The affected shutdown sequence is excluded from this release's acceptance claim; other native suites passed their documented sequences. Physical microphone/acoustics and real-provider streaming handoff identity remain separate evidence.

The custom CREW_APP_DATA portable-profile automatic updater relaunch limitation remains unchanged. Do not run an installer test that can fall through to the user's real default profile. Verify public artifacts, checksums, update ZIP SHA512, signing/notarization, runtime source parity and isolated explicit-profile launch/recovery; report automatic installation/profile recovery unverified when safe isolation cannot be guaranteed. No user installation, profile, auth or worker changes are authorized for testing.
