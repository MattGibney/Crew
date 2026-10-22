# Updating Crew

Signed production builds check GitHub Releases automatically after startup and every six hours. **Downloads and installation are explicit actions.** Open Updates in the workspace header, or Check for updates from the Crew menu. An available release shows its version; choose Download update, then Restart to update when ready. Normal Quit never installs a downloaded update.

The app checks the public release feed without requiring a GitHub login or distributing a GitHub publishing token. Update state distinguishes checking, available, downloading, downloaded, errors and unavailable/unsigned builds. A failed download can be retried; an unverified release is not installed.

Restart is blocked while voice is connected or connecting, the manager is working or waiting for input, workers are queued/active, a worker lifecycle or project environment command is pending, shutdown evidence is uncertain, or a project environment is still running. Finish or explicitly stop the relevant work, or choose Pause work and update to coordinate a safe pause. Resolve any unavailable evidence before retrying. Other live instances and detached runtimes using the same installed bundle also block installation.

At restart, Crew takes an exclusive installation lease and rechecks live activity. It freezes new chat/voice/setup requests before shutting down its owned controller. No detached worker is killed. The native updater verifies and installs the signed release. If installation fails before process exit, Crew releases the reservation and attempts to restore its controller without opening the microphone or starting model work.

Your project JSON, editable prompts, ChatGPT/Codex authentication, conversations, worker records and retained worktrees remain outside the application bundle. They are not replaced by an update. Custom `--config` instances use a bounded private one-time restart handoff so the native installer's relaunch returns to the same instance instead of falling back to the default. If you normally run several instances, close the others before updating and reopen them with their usual configurations afterward.

Unsigned local candidates cannot automatically update: they show a clear explanation and a link to releases. Older builds that did not include an updater, or were unsigned, require one manual installation of a signed updater-enabled release. Finish or explicitly stop active work and close all Crew instances before replacing the application. Keep the existing instance configuration and data.

See [release setup and signing prerequisites](RELEASES.md) and [theme customization](UI-FOUNDATION.md).


The signed 0.9.0 → 0.9.1 production-feed upgrade has been verified in an isolated native installation, including replacement/relaunch, signature/notarization checks and unchanged configuration/prompts/saved chat. See [release acceptance](RELEASES.md#signed-release-acceptance).

## Finished work and retained failures

A finished or interrupted manager turn does not block installation once it has no active turn, pending start or approval. Failed setup commands and retained worktrees also do not block solely because their history says failed. Crew reads matching command exit/ownership records and current process identities before declaring execution stopped. A missing/mismatched terminal record or still-live owned process stays blocked, with the worker and phase identified. Partial external resources and retained data are preserved; update readiness never runs teardown or deletes a worktree.

If an older 0.9.1/0.9.2 build remains blocked after its manager finished and a setup failed, Refresh readiness cannot repair the old classification logic. Do not Resume or Remove a worker simply to install an update. Verify no work is still active, quit Crew normally (closing the window alone leaves its controller running), and manually replace the app with the signed corrected release. Keep the same external configuration/state. Unavailable activity or genuinely live project commands require investigation before replacing the application.

## Pause work and update

When a downloaded update is blocked by active work, choose **Pause work and update**. Crew immediately holds new conversation/voice requests and worker launches, saves a durable plan, disconnects voice and requests targeted cooperative pauses. A running setup phase finishes before the worker launch boundary. A running worker receives a cooperative interrupt; a persistent project environment must have a declared stop command. Crew waits for fresh verified shutdown evidence. The update panel shows each captured worker and specific blockers.

This action does not force-stop processes, delete worktrees, run teardown or answer questions/approvals. If something cannot safely pause, the update remains blocked. Review required questions/approvals through the existing manager flow. The manager turn may be interrupted and remains visibly interrupted; its input is never automatically replayed.

After the exact approved update relaunches, Crew resumes only eligible workers whose pause was confirmed for this plan, using their retained chats/worktrees. Work already paused, failed, blocked or waiting for an unanswered question is not automatically resumed. Voice remains disconnected.

**Cancel update** preserves the plan and admission hold. Choose **Resume paused work** to restore eligible work paused by the plan, or **Return to work** to release the hold while leaving paused workers paused for manual review. Unknown execution ownership and shutdown evidence always remain blockers; cancellation is not a force-cleanup operation.

Implementation is tracked by AI-018. This feature is prepared on a pull request and is not claimed present in the already published 0.9.3 release. Native signed installation acceptance will follow an explicitly requested grouped release.

## Integration contract

The single-instance engine lives in update-plan.mjs. Its callbacks provide fresh task/manager evidence, voice shutdown, correlated manager interruption, ordinary lifecycle requests and aggregate install readiness. The controller's admissionHeld callback freezes queued/pre-spawn work; cooperative:true is accepted only for targeted pause requests. Plan targetVersion, task/run/action IDs and confirmed lifecycle/process evidence determine recovery. Preserve these checks when adapting the engine.

A future multi-project coordinator must enumerate every managed instance, hold all admissions, collect all worker/runtime evidence and keep the native installation lease/other-instance checks global. One project's idle state cannot approve a shared application replacement. A separate manager-lifecycle start/restart endpoint must enter the same update-admission barrier; lifecycle transitions or errors remain unverified until a positively stopped/ready process state is confirmed. Manager stop is not worker pause. No multi-project registry or manager-settings feature is implemented by AI-018.

Retained worker questions/blocked records with freshly confirmed stopped execution can survive an update unanswered. Missing or live execution evidence still blocks. Recovery does not resume those previously waiting workers.

## Crew 0.10.0: all-project update coordination

The native parent now applies Pause work and update to every registered project, including hidden windows. It durably holds shared admission and registration before asking each project to pause. A group journal binds canonical project identities, exact child plans and the target release. All projects must confirm fresh readiness and durable installation markers before any controller stops. Partial or unavailable evidence keeps the global hold; one selected project's idle state cannot approve a shared app replacement.

The existing idle-update reservation journal remains separate. Grouped updates use their own retained plan and confirmed local barriers, so queued recovery work is not mistaken for an unsafe idle-update restart. After the exact version launches, every child confirms eligible recovery before shared admission is released. An interrupted manager request is not replayed, and stopped manager intent stays stopped.

Cancel holds all projects. Resume paused work creates only correlated eligible resumes. Return to work creates no new resumes: paused workers stay paused, while already queued work, including previously admitted resumes, may continue. Switching projects remains available to inspect history and pending approvals; adding projects, changing shared capacity or starting/restarting managers cannot cross the update hold.

## 0.11.0 portable-profile boundary

A genuine signed 0.10.0 to 0.11.0 test passed native application replacement and post-install signature/notarization checks, but failed automatic recovery of an isolated CREW_APP_DATA profile. The native relaunch opened the ordinary default profile and left the custom-root restart handoff unconsumed. Configuration/prompts/chat files in the isolated root remained intact. File preservation does not establish correct profile selection.

CREW_APP_DATA portable/disposable runs must not assume that Squirrel.Mac retains the process environment. Recover an intact portable profile by explicitly launching with its original root and configuration; that is manual recovery, not automatic update acceptance. Do not retry through a user's shared registry or overwrite unknown user state merely to obtain a passing test. This boundary is unresolved in 0.11.0; published artifacts remain unchanged.

## Agent preparation for updates and explicit Quit (GitHub #62)

The proposed #62 flow uses one preparation conversation for **Prepare and update** and explicit **Quit Crew**. Each relevant manager and implementation worker chooses a sensible stopping point, preserves useful continuation/context and explicitly reports preparation progress or readiness through its bound orchestration tools. A commit or clean tree is not required. A project workflow label such as Paused does not acknowledge this request.

The shared panel shows request delivery, the agent's latest explanation/readiness, and execution settlement separately. Ready acknowledgement does not cut off a final reply: Crew continues receiving final messages/results and waits for native turns, pending approvals, persistence and owned execution/resources to settle. A preparation request never substitutes a forced interrupt, automatic environment command or approval response. Completed assignments retain their results and are not automatically repeated after the restart.

Native approval decisions remain accessible in the existing manager and worker request surfaces. If an agent needs a broader decision or new direction, cancel preparation and choose Return to work; already prepared workers stay paused until explicitly resumed. No reply, uncertain execution, unavailable delivery or a remaining live resource keeps the hold with its actual reason. Exact agent acknowledgements can establish receipt even when a transport acknowledgement was lost; Crew retains that distinction and never replays an uncertain delivery blindly.

Explicit Quit opens the same progress surface and only stops owned controllers after every project has confirmed the final barrier. Closing the window still leaves background work running. Reopening after a prepared Quit preserves continuation and holds work for explicit Return to work or Resume paused work; it does not silently replay manager work. This is not OS shutdown integration and does not guarantee handling of forced power loss. The feature remains on a reviewable PR until separately approved for merge/release. See [architecture and protocol](PREPARATION.md).
