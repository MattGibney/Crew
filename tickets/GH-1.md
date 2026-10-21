# GH-1 — Crew-managed project Node/npm environment

Issue: [crew#1](https://github.com/MattGibney/crew/issues/1)

Status: Implemented; awaiting pull request review. This change is to be submitted in its own pull request into `main`; no merge, tag or release is authorized by this ticket.

## Problem and evidence boundary

A reported worker on another Mac created its worktree, then failed during environment setup with `node: command not found`. A subsequent unbound database variable was downstream of the setup failure. `harnessStarted: false` means the Codex worker had not launched; it does not mean setup created no application resources. The precise original remote PATH/tool-version cause and current remote resource state have not been independently verified.

The existing desktop environment inherited GUI/system locations, while login-shell hooks did not load interactive shell configuration. Project PATH choices also needed consistent propagation into worker execution. Merely finding any Node is insufficient when the project requires a different major or a specific npm version.

## Authorized behavior

Crew owns a shared version cache (`~/Library/Application Support/Crew/toolchains` on macOS; `~/.crew/toolchains` on Linux) and resolves compatible exact Node/npm versions from existing committed project instructions/configuration. Inputs include package engines, npm `packageManager`, Volta pins, `.nvmrc`, `.node-version`, `.tool-versions`, and explicit numeric instructions in applicable AGENTS/CLAUDE/discovered `.claude` SKILL files. Unsupported aliases and other package managers fail with guidance. Preflight only inspects requirements; the first authorized worker preparation installs missing tools. Downloads and cache completion are verified, concurrent installation is coordinated, and one resolved environment supplies setup, Start/resume, readiness, teardown and worker execution. Controlled `ZDOTDIR` preserves that PATH in login zsh commands. Projects keep their existing commands unchanged. Personal shell profiles, global PATH/toolchains, user installations and runtimes are not modified.

Missing required Node declarations, incompatible requirements and unsupported syntax fail with actionable guidance. There is no arbitrary newest fallback, personal version-manager path discovery or generic package-manager platform. A compatible cached pair is reused; otherwise resolution stays within declared constraints, using bundled npm when npm is unspecified. Tool installation is authorized within this feature; paid APIs, credential extraction and private endpoint access are excluded. Worktree dependencies/builds stay separate, without implying filesystem/container sandboxing.

## Retained failure and validation

Preserve earlier failed tasks, worktrees and partial resources. Ordinary resume must not replay incomplete setup. Any cleanup/reseed/removal requires a concrete project-defined recovery and explicit authorization scoped to affected resources; do not operate on another Mac or shared services by assumption.

Focused validation passed ten managed-toolchain tests and six disposable end-to-end tests covering minimal GUI PATH, Node/npm compatibility, cache reuse/concurrency, launch environments, failures and retained-state safety. A separate real download verified official Node 22.23.3/npm 11.11.1 integrity, concurrent shared-cache preparation and actual login-shell execution. These checks used disposable resources; they do not establish another project's readiness, production correctness or acceptance on the affected remote Mac. No physical microphone capture. Full regression passed 247 tests with zero failures; the renderer build and source packaging passed. Remaining native/remote acceptance is recorded with the pull request.


Real managed-tool lifecycle acceptance also ran setup, foreground Start, readiness, stop, retained resume, worker login-shell commands and teardown with official Node 22.23.3/npm 11.11.1. All nine recorded phases used the same PATH and versions; setup ran once. The worker protocol was synthetic, so actual subscription-model execution is not claimed. The built readiness summary displayed missing-cache guidance using the synthetic browser fixture; screenshots remain outside Git. Native packaged launch and the affected remote task remain separate acceptance.


## Follow-up packaged and real subscription acceptance

The unsigned candidate built successfully from implementation commit `bcc3949`, with no update feed or publication. Native setup verified the existing Codex CLI/ChatGPT Pro session, then opened the isolated manager: Ready, controller connected, zero tasks and Microphone off. First launch correctly opened setup until that disposable configuration was reviewed. Eight changed runtime modules matched the packaged bytes. Normal native Quit stopped only that instance's app/backend and listener; process exit was independently confirmed.

Using the candidate's bundled Node runtime and packaged controller/runner/MCP modules with minimal GUI PATH, an actual subscription-backed Codex worker completed a read-only disposable Node fixture audit. Packaged preflight verified managed Node 22.23.3/npm 11.11.1; setup and actual worker login-shell commands used the same managed paths/versions, with setupCount 1. The worker supplied durable progress and result reports, concrete successful command output, a clean isolated worktree and a matching completed turn/exit code 0/confirmed descendant shutdown. This closes the previous synthetic-worker and packaged-launch acceptance gaps without altering a business repository or user installation. The completed-task resume request was correctly rejected as already finished; no completed status was rewritten to manufacture resume acceptance. The confirmed natural worker shutdown satisfies this bounded test. Synthetic retained-resume coverage remains separate.

No physical microphone, voice call, business project/shared Docker operation, original remote task, merge, tag or release was started. The existing account was used normally; no credential values were read or copied. Native screenshot and detailed process/task/command evidence remain outside Git. The affected original Mac remains user acceptance; signed release/update acceptance is outside this PR.
