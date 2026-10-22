# REL-0.16.1 — TypeScript production release

Continues the explicitly authorized PR #57 delivery documented in [REL-0.16.0](REL-0.16.0.md). The first [production run](https://github.com/MattGibney/Crew/actions/runs/39731464344) stopped before signing/publication: 660/661 tests passed, and execution timing compared a resumed native thread with an initial snapshot taken before thread identity arrived. Native process liveness is independent of thread-start delivery. The test now waits for the exact live run and its actual thread before comparing retained identity. Product implementation is unchanged.

Preserve v0.16.0 at 9c26d212 and its failed workflow evidence. No 0.16.0 public release/assets were published. Version 0.16.1 uses a new release PR and exact stable tag, with the ordinary full hosted tests and signed/notarized publication gates. User installation/profile/auth/history and physical microphone remain untouched; the existing Quit #39 and portable-root updater limitations remain separate.

Validation on the corrected release source: full clean-build npm test 661/661, no failures/skips/cancellations (168.4 seconds). Both strict TypeScript projects pass. The production implementation remains byte-identical in source to a4a247c; only test observation, metadata, documentation and manifest differ.
