# REL-0.10.0 — Grouped integration and signed release

Status: In progress.

The user explicitly authorized merging PRs 4, 5, 6 and 7 after combined validation and publishing exactly 0.10.0. Preserve PR-first delivery for future work; this authorization applies only to the named grouped release. No business repository, shared runtime or physical microphone changes.

Integration preserves managed project toolchains and bundled Codex runtime separation, immutable prompt snapshots, explicit per-project manager lifecycle, independent project config/state/chat/ports and global capacity. The update parent must freeze all managed projects and registration, bind canonical project identities and child plans, mark every child installing before stopping any backend, and recover only correlated eligible work after the exact target version starts. Unknown and partial failures retain holds.

Local merge sequence retains complete PR histories: toolchains, prompt settings/lifecycle, cooperative updates, then multi-project architecture. A separate integration PR carries semantic fixes and the version/lockfile change. Required gates: combined full suite, disposable multi-project/process/toolchain/lifecycle/update acceptance, renderer and packaged native smoke, then signed workflow/notarization/Gatekeeper/artifact/feed verification and isolated actual update from a prior signed release. Existing user installation/settings/auth/history remain untouched. Hands-on acoustic and tray acceptance remains with the user after publication.
