# REL-0.15.0 — Agent-owned worker workflow

The user explicitly authorized shipping [PR #51](https://github.com/MattGibney/Crew/pull/51), including the required saved-prompt upgrade correction, through the existing signed/notarized pipeline. [Issue #50](https://github.com/MattGibney/Crew/issues/50) is the implementation scope. Usage/allowance work remains planning-only and TypeScript #37 stays paused. No user installation, profile, physical microphone or Set1/business service changes are authorized for acceptance.

## Behavior and upgrade

Managers and workers decide and initiate work through native tools. Crew keeps the same worker conversation/worktree, durable directions, results and explicit workflow labels without admission gates based on dirtiness, HEAD, hashes, configuration or earlier completion. Native configuration, sandbox and approvals remain authoritative. Dispatch runs no automatic setup/start/readiness. Native connection closure retains agent-owned services and fresh resource evidence. Capacity/update reservations delay execution without refusing directions; busy manager input uses native steering and explicit Stop cancels pending delivery.

Exact pristine shipped 0.14 prompts migrate from persisted settings to the current defaults, with old text/version retained as upgrade history. Custom bytes and explicit custom provenance remain unchanged. The retained manager active snapshot stays in force until explicit Restart in the same conversation. Workers use current saved instructions on their next direction; original run snapshots/results remain immutable.

## Pre-publication evidence

Final implementation passed 638/638 tests with no failures, cancellations or skips, including the renderer build, and 22/22 focused prompt/lifecycle checks. The new upgrade regressions cover per-role pristine migration, custom Unicode preservation, explicit old-text custom saves, unchanged active manager until Restart and unchanged historical worker configs.

Compiled browser suites cover worker directions/history/workflow and environment Settings. Packaged Electron smoke uses a synthetic native peer and the actual packaged MCP tools: same worker thread/worktree across two assignments, explicit workflow separate from execution, retained results/history and typed draft across normal native Quit/relaunch. Two packaged builds passed disposable default/custom manual replacement recovery, retained manager chat and worker state, explicit manager Restart, new tools and exact custom bytes. A genuine subscription sixth continuation after saved-prompt migration preserved all five prior assignments/configs, the same native chat/worktree, marker, HEAD and setup count; durable worker workflow-tool evidence is verified. Environment-context use in that additional probe is worker-reported, not independently traced.

The original five-assignment real subscription check includes an actual worker-owned commit and post-commit continuation. Synthetic native tests separately cover approval, ownership, service retention and update/capacity races. Evidence/screenshots remain outside Git. All primary acceptance jobs exited with fresh owned-process checks. The source archive passes its allowlist; current source and 58 newly reachable text blobs were inspected, with only known synthetic rejection-test canaries among the pattern matches.

## Release boundaries

The production workflow must rerun the full suite and pass Developer ID signing, hardened runtime, notarization, stapling, Gatekeeper, DMG, checksums and exact ZIP update metadata before publication. Verify actual public downloads and the latest stable feed afterward; a workflow dispatch is not a published release.

Automatic portable CREW_APP_DATA profile recovery remains unverified with the existing documented relaunch limitation. Do not invoke an installer test that can enter the user's default profile. Explicit-profile manual replacement/relaunch is separate evidence, not automatic installation. Quit issue #39 and physical microphone/acoustic acceptance remain outside this release's fix claim. An extra immediate startup page reload reproduced a persistent GET /events 409/Reconnecting state on the public 0.14 baseline; the candidate passed two immediate reloads before reproducing the same failure on a third. Normal Quit/relaunch checks passed. This establishes that the observed reload failure predates #50, not universal reload reliability or a root cause.
