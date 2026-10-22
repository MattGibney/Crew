# Unified-agent completion checklist (#86)

This is the remaining work after integrating runtime #96, desktop/skills #97 and
access/gateway #98 into the rewrite tracking branch. Integration is authorized as
a work-in-progress testing baseline. Main merge, installation and release remain
separate decisions. Previous isolated acceptance is not an exact-head guarantee.

## Review

- [ ] Review the combined implementation and permission defaults against agent-owned workflows.
- [ ] Review native tool access where public event evidence does not show every attempted operation.
- [ ] Confirm final UI and documentation accurately describe changed-instruction Restart and known limits.

## Development environment

- [ ] Define and expose supported owner-approved network, package-download, server-port and container access as needed by the intended project.
- [ ] Exercise that project's existing setup/run/cleanup commands unchanged. Do not patch project source to accommodate Crew.
- [ ] Verify long-running resource handling and report incomplete cleanup truthfully.

The initial executor currently has no network, development-server or container
access. Local command proof does not establish an ordinary full development setup.

## Voice

- [ ] Perform the owner's manual packaged voice/transcript check, recording device/audio acceptance separately.
- [ ] Verify partial/final updates, interruption, duplication and call-end clearing in the actual desktop.
- [ ] Verify previous-call isolation when native realtime identities are reused.
- [ ] Establish supported retained voice-to-coding-turn attribution or explicitly retain the limitation; never infer it from timing/text.

The previous generated WAV attempt connected but Chromium rejected the input
before speech reached the call. The sandbox stayed enabled. Synthetic transcript
checks passed, but actual packaged live transcript acceptance is pending.

## Real connections

- [ ] Configure one owner-selected real service and perform a small explicitly authorized operation.
- [ ] Verify its user-facing once/session/persistent approval, denial, revocation and retry flow.
- [ ] Verify subsequent admission after permission or credential changes.

Authenticated synthetic MCP/CLI and real vault checks passed. They do not establish
any particular live third-party service integration.

## Final candidate

- [ ] Review the integrated result and run focused checks for changed areas only.
- [ ] Complete affected native acceptance and normal Quit/reopen on the final candidate.
- [ ] Record remaining limits before any separately authorized installation or signed release.

Already demonstrated: real subscription sign-in, idle Start, manager-created worker,
authorized fixture execution, steering and queueing, jobs/progress/scratchpad, help
response by incoming message identity, selected skill use, same-chat changed-profile
Restart, unchanged idle Restart, private scheduled activity, and prepared Quit/reopen.
Do not repeat unaffected completed checks without a concrete reason.

Multiple management levels, large-scale concurrency, other runtimes, group voice
and embedded-browser development remain future scope.
