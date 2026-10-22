# Persistent agent runtime (Crew #84)

Crew supplies conversations, message transport, records and optional environments. Native Codex configuration and approvals govern execution. Agents choose workflow, testing, triage, escalation and delivery through editable Settings profiles and ordinary native skills/tools. Agent workflow status/progress is independent of observed process state. No multiple-manager hierarchy is implemented.

## Conversations and environments

Omit `repositoryId` from `submit_task` for research or other non-coding work. The native agent uses a private session directory. Supply it for a repository worktree, or call `prepare_worker_environment` later to attach a registered worktree to an existing conversation. Attachment runs no setup or project commands and applies to its next native continuation; the active turn keeps its current directory. Agents read `get_project_environment` and run configured setup, start, stop or cleanup explicitly through native tools.

Directions are durable and reuse the same native conversation after completion, with dirty files, during preparation or when an environment is missing. Missing environments are preserved in resource metadata; communication uses a private session directory. Pending, attempted, acknowledged and uncertain delivery remain distinct; uncertain sends are never blindly replayed. An actual installation reservation temporarily delays execution, with queued directions retained. Capacity limits still bound concurrent native sessions.

## Shared records and notifications

`set_workflow_state` records arbitrary agent status and optional 0–100 progress without review/adoption rules. `read_work_notes` returns the shared Markdown and `updateId`; `update_work_notes` replaces it, accepts empty text to clear, and optionally checks `expectedUpdateId`. Reports do not change workflow, force a question/result transition, or automatically escalate question/completion messages. `notify_manager` creates explicit durable help attention using an idempotent `requestId`; agents choose escalation policy in their saved instructions. Native approvals retain their actual user-response requirements.

Archive changes visibility only, including for active agents and dirty environments. Restore changes visibility without restarting anything. `worker_action` with `dispose` is a separate explicit resource cleanup request, retaining existing ownership/dirty-state safeguards. Permanently deleting records requires resources to have been disposed first. Legacy disposal/restoration history is preserved.

## Update and Quit

Preparation asks agents for explicit readiness and factual continuation, without holding ordinary conversation or automatically pausing/resuming/cleaning environments. Actual restart/Quit briefly reserves new execution and rechecks readiness, pending input and native/controller-owned execution. Independent project environments may remain running and are reported separately. Cancelled/blocked preparation retains evidence while communication remains available. Existing restart journals and notes remain readable; agents decide continuation. Legacy plans can still reconcile their already-issued actions; no state/auth reset occurs.

Saved custom profiles and already-consumed native snapshots remain intact. Exact known shipped defaults migrate through existing prompt provenance; manager instructions activate through the existing explicit restart and worker instructions refresh at the next Crew-owned delivery boundary.

## Validation and limits

Issue #84 requests build/type validation and a brief disposable functional check only, with no new coverage/full suite, packaging, installed app changes or physical microphone. This does not establish live-model or packaged update/Quit acceptance. Environment attachment is intentionally small: a missing retained environment must be explicitly resolved before replacement; a crash between Git creation and record persistence may leave a registered worktree for manual reconciliation. No silent destructive rollback is performed.

Current source passes `npm run typecheck` and `npm run build`. Brief disposable native-peer acceptance passed: one non-coding conversation, shared notes/help tools, live archive/steering, missing session-directory continuation, explicit registered environment attachment and same-thread continuation with dirty files retained. A separate disposable preparation check passed update and Quit readiness/settlement, no automatic lifecycle requests, retained independent runtime, durable continuation and install-only reservation. Native peers were synthetic; no installed app, live user worker, physical microphone, full suite or package was exercised.
