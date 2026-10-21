# Updating Crew

Signed production builds check GitHub Releases automatically after startup and every six hours. **Downloads and installation are explicit actions.** Open Updates in the workspace header, or Check for updates from the Crew menu. An available release shows its version; choose Download update, then Restart to update when ready. Normal Quit never installs a downloaded update.

The app checks the public release feed without requiring a GitHub login or distributing a GitHub publishing token. Update state distinguishes checking, available, downloading, downloaded, errors and unavailable/unsigned builds. A failed download can be retried; an unverified release is not installed.

Restart is blocked while voice is connected or connecting, the manager is working or waiting for input, workers are queued/active, a worker lifecycle or project environment command is pending, shutdown evidence is uncertain, or a project environment is still running. Disconnect voice and finish or explicitly stop the relevant work; Crew does not stop workers for an update. Resolve any unavailable evidence before retrying. Other live instances and detached runtimes using the same installed bundle also block installation.

At restart, Crew takes an exclusive installation lease and rechecks live activity. It freezes new chat/voice/setup requests before shutting down its owned controller. No detached worker is killed. The native updater verifies and installs the signed release. If installation fails before process exit, Crew releases the reservation and attempts to restore its controller without opening the microphone or starting model work.

Your project JSON, editable prompts, ChatGPT/Codex authentication, conversations, worker records and retained worktrees remain outside the application bundle. They are not replaced by an update. Custom `--config` instances use a bounded private one-time restart handoff so the native installer's relaunch returns to the same instance instead of falling back to the default. If you normally run several instances, close the others before updating and reopen them with their usual configurations afterward.

Unsigned local candidates cannot automatically update: they show a clear explanation and a link to releases. Older builds that did not include an updater, or were unsigned, require one manual installation of a signed updater-enabled release. Finish or explicitly stop active work and close all Crew instances before replacing the application. Keep the existing instance configuration and data.

See [release setup and signing prerequisites](RELEASES.md) and [theme customization](UI-FOUNDATION.md).


The signed 0.9.0 → 0.9.1 production-feed upgrade has been verified in an isolated native installation, including replacement/relaunch, signature/notarization checks and unchanged configuration/prompts/saved chat. See [release acceptance](RELEASES.md#signed-release-acceptance).

## Finished work and retained failures

A finished or interrupted manager turn does not block installation once it has no active turn, pending start or approval. Failed setup commands and retained worktrees also do not block solely because their history says failed. Crew reads matching command exit/ownership records and current process identities before declaring execution stopped. A missing/mismatched terminal record or still-live owned process stays blocked, with the worker and phase identified. Partial external resources and retained data are preserved; update readiness never runs teardown or deletes a worktree.

If an older 0.9.1/0.9.2 build remains blocked after its manager finished and a setup failed, Refresh readiness cannot repair the old classification logic. Do not Resume or Remove a worker simply to install an update. Verify no work is still active, quit Crew normally (closing the window alone leaves its controller running), and manually replace the app with the signed corrected release. Keep the same external configuration/state. Unavailable activity or genuinely live project commands require investigation before replacing the application.
