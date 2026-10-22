# Settings profile refresh and current worker instructions

Local ticket: `crew-settings-profile-refresh-20261022`. This is authorized local project work, not an external issue number. Current review assignment: `settings-review-validation-baseline-20261022`.

## Problem and agreed behavior

Settings API saves updated the saved profile document while an already-open renderer kept bootstrap-cached text. Reopening Settings reused that cache. The scope also includes the clarified worker rule: **saved project-state worker instructions are the single current source whenever Crew prepares the next worker prompt**. Earlier run/configuration copies are historical provenance, not an activation rule for future worker prompts.

Saved manager instructions still require explicit Start/Restart. Saved worker instructions are read for launch, retained continuation/follow-up, and explicitly requested preparation; Crew rereads immediately before native turn delivery. A queued worker uses the profile current at preparation, not its queue-time text. Saving alone starts, steers, restarts and interrupts nothing. Already supplied native input may finish with what it received.

## Implementation

- Successful Settings PUTs publish project-scoped invalidation on the existing single manager SSE stream. Bootstrap, reconnect, Settings opening and retry use a coalesced authoritative loader, with project identity, invalidation generation and controller observation ordering checks. No polling or new listener/connection is added.
- Failed refresh keeps displayed values/drafts with Reload settings. Dirty drafts keep their concurrency base and show a conflict. Save acknowledgements preserve newer edits and their exact write version; delayed PUT responses cannot replace the shared cache.
- The production controller binds worker configs to the canonical saved project profile. The detached runner rereads immediately before `turn/start`, after initialization/thread start or resume/policy observation, and before explicit preparation text on its matching active turn. Native instruction delivery and normal Codex configuration/permissions retain their existing precedence.
- Historical dispatch configs remain immutable. `prompt-consumptions.jsonl` records the exact text/version **prepared** at each boundary, separately from native acknowledgement. A dispatch snapshot can be older when Settings changes during startup; it never overrides the fresh read.
- Legacy/configured instructions seed canonical state once. An identity-only `.initialized` marker prevents silently reseeding stale/default text if the saved document is lost, including after restart. Detached readers never initialize, migrate, repair or substitute cached copies. Missing/malformed/unreadable/foreign-project state prevents new delivery with restore/explicit-retry guidance. Preparation read failure is failed/unsent, not uncertain transport or automatic retry.

## Controlled boundary and scope limits

Crew controls dispatch configuration, native turn input and explicit preparation input. Individual model requests, tool iterations and retries inside a supplied native turn are not observable Crew prompt boundaries. Existing pre-upgrade supervisors retain their loaded implementation until the next explicit run; Crew does not interrupt them to adopt this change. A profile read is the snapshot prepared for one delivery; later overlapping saves apply at the next Crew-owned boundary.

The product HTTP path always binds canonical project state. Standalone synthetic transport fixtures can use their explicit test configuration/callback source. Synthetic native protocol capture verifies actual Crew controller/supervisor delivery, identity and failure handling; it does not prove genuine model obedience, packaged release behavior or invisible per-model-request reloads. Actual native multi-project switching is separate from loader rebind/source-project rejection tests.

Native Quit is explicitly set aside by the user. Earlier observations remain historical evidence; no Quit investigation, acceptance or blocking gate belongs to this review. Native UI-only acceptance stops its exact disposable controller through the existing CLI and then terminates only its owned Electron fixture shell. That cleanup is not production Quit evidence.

## Validation and reproducible commands

Build before running tests; never rebuild the generated runtime while tests are active:

```sh
npm run build
node --import tsx --import ./scripts/settings-profile-refresh-test-environment.mjs --test --test-reporter=tap --test-concurrency=2 tests/*.test.mjs renderer/src/manager/*.test.mjs renderer/src/setup/*.test.mjs
```

The explicit test preload clears inherited controller config/port overrides, creates a fresh private capacity directory **and initializes its valid ledger through `configureGlobalCapacity` before importing tests**. Fixtures do not read or clear the live ledger. `tests/settings-test-environment.test.mjs` verifies private initialization, untouched inherited canary bytes, and continued fail-closed behavior for missing or held ledgers.

```sh
node scripts/settings-profile-refresh-browser-acceptance.mjs
node scripts/settings-profile-refresh-browser-acceptance.mjs --native-ui-only
```

Set `CREW_PLAYWRIGHT_MODULE` and optionally `CREW_BROWSER_EXECUTABLE` for available local tooling. Both commands use compiled renderer/actual disposable controller and a synthetic provider. Each evidence directory includes a screenshot, private protocol record, and `evidence.json` with source/runtime fingerprints. The browser covers refresh, drafts/conflicts, delayed reads/saves/new typing, error retry, wrong-project rejection, reconnect/reopen, one SSE, and a real UI save followed by one explicitly tested synthetic worker launch. The native UI-only mode checks clean manager/worker refresh, dirty conflicts and delayed-save/newer typing without exercising Quit. Screenshots/evidence remain outside Git.

HTTP/detached-supervisor tests cover API edits during bootstrap before delivery, next same-thread/worktree follow-up, queued-before-edit launch, stale worker.md/dispatch-copy exclusion, corrupt profile/no stale native turn with explicit recovery, isolation/custom preservation, no save-triggered steering and refreshed explicit preparation. Focused suites also cover profile loss across restart and failed/unsent preparation reads.

## Review correction: six cancelled scheduling tests

The earlier UI-only run (751 pass/6 cancelled) and combined worker-source run (757 pass/6 cancelled) were **not accepted green validation**. Calling those cancellations an existing scheduler limitation based only on the modified checkout was insufficient.

A fresh `git archive` of clean base `bfd121873d258e8ee4a41e6d0691589759257b7a` was built in a disposable directory using the same Node and dependency installation. Matched clean-base and combined-source runs of the unchanged scheduling/preparation file established:

| Capacity condition | Clean base | Combined source |
| --- | --- | --- |
| Configured but missing ledger | 0 pass, 6 cancelled | 0 pass, 6 cancelled |
| No capacity binding (in-process target file only) | 6 pass | 6 pass |
| Same corrected preload with initialized private ledger | 6 pass | 6 pass |

The old preload created an empty directory without `capacity.json`. Production `globalAdmissionPaused` correctly treated that unknown state as held; scheduled work never reached the mocked bootstrap promise, leaving the first test pending and cancelling the file. This was a test isolation/setup error, not an established scheduler bug or Settings/SSE/loader regression. The corrected preload initializes only its own new ledger. Production admission remains fail-closed; no test was deleted, skipped or weakened, and scheduler behavior is unchanged. The targeted file plus the new preload regression passed **7/7** after this correction.

Current combined-source full-suite and final UI results are recorded below after the review run. Earlier UI-only and combined evidence stays separate; private matrix logs/checksums remain outside the repository.

No commit, push, PR, merge, release, installed app/profile change, physical microphone, credential inspection or external ticket mutation is included.

## Current combined-source review result

- Fresh build and typecheck passed. Full isolated combined-source suite: **764 passed, 0 failed, 0 cancelled, 0 skipped**, exit 0. This includes all six formerly cancelled scheduling/preparation cases and the new preload regression. The scheduler assertions were retained.
- Final compiled Chromium acceptance passed with an actual test-proxy SSE socket cut, an observed disconnected state and reconnect recovery. Chromium's offline-emulation flag had left the existing SSE socket alive in an earlier attempt; that flag-only attempt is not accepted disconnect evidence. Product code was unchanged for this harness correction.
- Final direct source-Electron **UI-only** acceptance passed, exit 0. The native UI-only and browser records have identical base, production-source and runtime fingerprints. The browser also verifies a UI-save followed by one explicit synthetic worker launch; native UI coverage remains profile freshness, draft/conflict/save-race behavior and no unsolicited turn/capture.
- Native Quit remains excluded and is neither investigated nor a blocker. The UI-only fixture records normal disposable-controller CLI shutdown separately from disposal of its own isolated Electron shell. Bounded forced shell disposal may be needed after that controller is stopped; this is fixture cleanup, never a product Quit or graceful shutdown assertion. An earlier UI-only harness cleanup wait timed out; only its exact orphan fixture was subsequently disposed, and no duplicate fixture remained when the final run started.
- `evidence.json` records source/runtime fingerprints; private TAP/matrix/cleanup/protocol records and screenshots remain outside Git. Earlier UI-only and combined runs with six cancellations remain historical attempts, superseded by this current green combined-source run.

Review correction changes are limited to test initialization, acceptance harness/metadata and documentation. Fresh-profile implementation scope is preserved: canonical saved worker instructions at the next Crew-owned prompt boundary, no save-triggered steering, same conversation/worktree, ordinary Codex permissions, and no claim of observable native-internal model/tool reloads.
