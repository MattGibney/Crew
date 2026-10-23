# Unified-agent delivery and remaining acceptance (#86)

The owner authorised first-pass main integration on 22 October 2026. The target
is useful end-to-end functionality for iteration, rather than polished support
for every tool, account or development stack. This supersedes the earlier
feature-branch-only checkpoint. Installation and signed publication are separate.

## Implemented and checked

- [x] One persistent agent model, agent table/editor and primary-manager selector.
  Name, personality, instructions, picture, voice, skills and access refer to the
  selected agent; editing an old manager cannot restore its former project role.
- [x] Guided subscription, folder permission and service-connection setup, retained
  drafts and revision conflicts. Groups are capability authority; service identities
  remain separate from ChatGPT subscription authentication.
- [x] Real retained manager–worker delegation, file execution, worker review request,
  manager byte-level review/answer and completed progress, without owner intervention.
- [x] Native Codex chat references, typed history restoration, queue/steer delivery,
  durable jobs/progress, notes, help requests and explicit instruction Restart.
  A changed profile can compact native context; unchanged Restart stays idle.
- [x] Project-only skills with UI/MCP editing, isolated native discovery and pinned
  revisions. Skills are instructions, not execution grants.
- [x] Account allowance/reset display without model turns, reset consumption or
  invented token balances. Real signed-in account reads were checked.
- [x] Optional project environment templates, revision-pinned agent assignment,
  owner editor, explicit sandboxed tool inspection and managed background commands.
  Saving does not install, prepare or launch work. Real Node inspection and owner
  create/update UI flows were checked on the combined application.
- [x] Set1's unchanged setup completed migrations/seeds in a disposable worktree.
  Its web app rendered and API health returned HTTP 200. Exact recorded command
  processes stopped; test Compose resources were removed, shared services preserved.
- [x] Scoped embedded browser, local-hostname/HMR support and owner annotations.
  A real subscription-backed retained manager listed/snapshotted the page, filled
  and clicked it, captured a screenshot and read the annotation image. Native
  history confirmed actual completed tool calls; both chats and assignments survived.
- [x] New public voice-call display artifacts retain exact native item/call identity
  separately from native chat context. Generated-audio input/reply survived call
  end, Restart and state reopen. Partial/deduplicated storage and bounded pending
  writes were checked. No physical microphone was used.
- [x] Deliberate abandoned-writer recovery without resetting auth/history, failed-project
  idle Quit, and the native destroyed-Tray Quit regression. Real Electron Quit exits
  normally; forced process cleanup is not counted as a passing Quit test.
- [x] Current type/build and focused changed-area checks. Browser/voice fixture facts
  and actual native model evidence are recorded separately.

## Remaining limits and owner acceptance

- [ ] Human microphone/speaker and packaged voice quality acceptance. Prior calls
  from before artifact capture cannot be reconstructed; native voice-to-coding-turn
  attribution remains unavailable. Artifacts never become replacement model context.
- [ ] Exercise owner-selected real Linear/GitHub/other service accounts and their
  approval/revocation flows. Synthetic authenticated gateway/vault/CLI checks do
  not prove a particular live integration or authorize business mutations.
- [ ] Full hot restart for Set1's API: the tested supported command uses
  `--watch=false --inspect=false` to avoid an unavailable Nx daemon/socket path.
  API edits need manual restart; frontend hot reload remains enabled. No Set1
  source or tooling was changed to hide this limitation.
- [ ] Strict loopback-only server isolation is unsupported by this macOS executor.
  Incoming TCP ports explicitly expose all interfaces. Host Docker is optional,
  broad trusted daemon authority, not project confinement or a managed VM.
- [ ] Environment templates reference existing approved tool installations; there
  is no general binary/package-manager installer. Agents can explicitly execute
  permitted project package/setup commands after preparation.
- [ ] The browser first pass is one owner-selected local origin. It does not provide
  arbitrary internet browsing, cross-origin application testing or browser extensions.
- [ ] External social-preview upload requires the owner's authenticated GitHub
  repository settings. Approved README/assets/description/topics are present.
- [ ] Multi-level management, hundreds of concurrent agents, other runtimes and
  group voice remain future scope. The first-pass loop is deliberately small.

Fixture cleanup retained the disposable worktree, generated local files and
fixture databases/bucket directories on shared services. Broad project cleanup
could have stopped pre-existing shared services, so it was not run blindly.
Private evidence and screenshots remain outside Git. Final candidate provenance
and issue disposition are recorded in the coordinating delivery report.
