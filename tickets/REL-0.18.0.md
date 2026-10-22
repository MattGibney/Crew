# REL-0.18.0 — Four-feature integration and release preparation

## Scope

Prepare 0.18.0 from verified main `bfd121873d258e8ee4a41e6d0691589759257b7a`, preserving the full original histories through separate merge commits:

- [PR #79](https://github.com/MattGibney/crew/pull/79): optional tracking and GitHub issue cards, `56ef87b9adbf361d98b6e7805f91ed52be6356ba`.
- [PR #80](https://github.com/MattGibney/crew/pull/80): live steering, `761491e03ba3f2de38996007d6f495243a271a49`.
- [PR #81](https://github.com/MattGibney/crew/pull/81): Settings freshness/current saved worker profile, `38cffe9ad08858a3b7bc31ddf8bb7f4e3d25dfa5`.
- [PR #82](https://github.com/MattGibney/crew/pull/82): text context menus and Safari links, `cec0d2f4c336c44cdafc10be159ab3998bd937b4`.

The worker prepares and pushes an integration PR only. Manager review/main merge/tag/manual signed publication are subsequent stages. PR54 and unrelated backlog are excluded. No installed app, user profile, live capacity ledger, physical microphone or business services are touched.

## Combined behavior

Projects can use no external tracker, Linear, GitHub or both; task linkage retains canonical identity and explicit local intent. GitHub cards put #number first with repository context. Active workers receive ordered explicit manager steering in their existing native turn; Settings changes refresh through the existing event stream and the next Crew-owned prompt boundary consumes the saved project worker profile. Read-only text offers Copy and validated web links open Safari on macOS while normal input editing remains available.

The integration adds the fresh saved profile read to ordinary live steering and includes each direction’s actual optional issue-link metadata. Profile read failures send no stale native input and retain explicit recovery guidance. Saves alone send nothing; earlier assignment/run snapshots remain provenance. Native acknowledgement, model consumption, workflow status and owned execution remain separate.

## Validation

Combined-source evidence at integration head `7276e269c6ef25c89203b5885f9ee6aaa60e10db`, before the post-integration review correction below (individual PR results are historical):

- Strict TypeScript/renderer typecheck and clean runtime/renderer build passed.
- Final isolated full regression: **790 passed, 0 failed, 0 cancelled, 0 skipped**, exit 0. Runtime stayed frozen and no browser/native/subscription acceptance overlapped this final suite. Initialized disposable global capacity through the production API; live registry/claims were not used. The accompanying scheduling/preparation focus passed 6/6.
- Source fingerprints for all 433 files captured by the final-suite driver remained identical after the run. Production source and package metadata are unchanged by this evidence update.
- Compiled browser acceptance passed nine legacy/canonical/local worker-reference cases at 1400px/390px with immutable JSON/Markdown and no overflow/capture; delayed tracking saves; and actual-controller Settings refresh, reconnect, wrong-project rejection, dirty drafts, delayed save/new typing and one SSE consumer. One explicitly requested synthetic worker consumed the profile saved in the UI.
- Real detached subscription acceptance passed using normal Codex CLI 0.163.0-alpha.11. Two ordered corrections had native acknowledgements and separate model-consumption reports before the initial result; the current saved profile marker was consumed. Run/thread/native-turn/worktree/current assignment stayed the same, followed by natural completion and confirmed owned exit. Saves alone created no direction; no physical media was used.
- Unsigned candidate built through unchanged `npm run desktop:build:mac` tooling. Artifact checksums passed and all **188** packaged executable/renderer runtime files matched the validated runtime. No update feed or app-update metadata was emitted.
- Actual candidate Settings passed clean profile refresh, dirty conflict, save/edit races, one retained SSE connection and zero unsolicited turns/capture. Actual candidate tracking passed none/Linear/GitHub/both with synthetic connected discovery, real save/reload/relaunch and mapping preservation, no renderer errors/capture.
- Actual candidate clipboard/link acceptance passed selected-text Copy, Copy link, observed Safari requests from click/context Open in Safari, retained Crew origin and zero capture. Broader compiled native project-window acceptance also passed editor shortcuts, read-only menus, manager/user/worker Markdown/plain links, unsafe/foreign navigation rejection and responsive menu bounds.
- Manifest refreshed after staging: **523** allowlisted source files. Export included integrated modules/tests/docs/ticket and built successfully after extraction without Git using the existing installed dependencies. Private operational logs, profiles, task evidence and screenshots remain outside Git. Candidate Settings and narrow worker-reference screenshots were visually reviewed.
- Changed-source privacy pattern review found no actual credentials; the only key-header match was an unchanged negative-test sentinel. No signing credentials were read. `npm ci` reported 15 dependency advisories (8 moderate/7 high); dependency upgrades are outside this integration.

## Preserved failed attempts and corrections

- First full regression: **789 passed / 1 failed**, no cancellations/skips. The crash-recovery test `native worker survives controller SIGKILL and is adopted once without automatic environment commands` failed closed while reacquiring `.schedule.lock` because observer ownership was unknown/overdue. No production lock code changed. The isolated concurrency/state-lock rerun passed **28/28**, including that case; the final full suite passed 790/790. The first failure's precise cause remains unproven and is not claimed fixed or unrelated.
- The first focused test assumed a legacy implicit current assignment ID was already explicit; normalized the test comparison to `initial` without modifying retained records. A subsequent focused rerun overlapped an accidental rebuild and encountered fixture ENOENT; that run is invalidated, and the final serialized full run supersedes it.
- The first subscription acceptance assumed an assignment array existed before the first direction. Corrected only that fixture assumption; its worker was cooperatively paused with confirmed exit. The corrected real subscription run passed.
- Initial local native launch lacked the exact Electron binary after dependency install; installed that worktree dependency and reran. A temporary candidate-link provider initially lacked the native history fallback; corrected the disposable provider and reran successfully. No production behavior was changed for either harness correction.
- Product Quit is excluded per user direction. Test controllers stopped normally through the ordinary CLI; the exact isolated native shells required bounded forced disposal (one Settings, two tracking launches, and link fixtures), recorded only as fixture cleanup. This is not graceful product Quit evidence, and historical shutdown behavior was not investigated.

## Review handoff

The integration branch is `codex/release-0.18.0-integration`, targeting `main`. All four exact original heads above are ancestors through real merge commits. Version 0.18.0 is prepared; no main merge, release tag, release workflow dispatch or publication has occurred. Manager review and the established signed/notarized publication gates remain subsequent stages.

## Boundaries

Unsigned candidate acceptance is separate from signing/notarization/publication. Known portable-root automatic updater relaunch remains unresolved; explicit-profile manual launch is not automatic update proof. Historical native shutdown observation is set aside by user direction and is not investigated or used as a blocker. Physical sound/microphone acceptance remains outside autonomous checks.


## Post-integration review — profile-read admission race

Manager review identified an integration gap: ordinary steering awaited async saved-profile preparation after its durable attempted claim and guard checks. A hold or identity change during that read could still reach native steering. Deterministic gated tests against unchanged integration runtime reproduced incorrect steer-callback invocations in all ten scenarios: capacity, update, preparation, archive request, archived task, ending/changed/unacknowledged native turn, changed task run and changed task thread. The after-native-send hold control passed and retained acknowledgement without replay.

The scoped correction completes profile preparation before the existing durable claim. Hold/task/snapshot guards therefore revalidate after that read. Newly held unsent directions remain pending without fabricated attempted evidence; release uses the same ordered direction and rereads the current profile. Local profile-read failures keep the existing failure evidence when admission remains valid. Sent/accepted/uncertain delivery semantics are unchanged; no rollback or replay is added.

Validation of the reviewed correction:

- Strict build/typecheck passed.
- Corrected focused suite: **46/46 passed**, covering the twelve runner boundary/control cases plus actual HTTP/detached-supervisor profile delivery, native peer, saved-profile and preparation regressions. The initial broader command omitted `--import tsx` and failed to load one TypeScript-importing test file; the corrected normal-loader command passed without a product change for that harness error.
- All ten gated races now suppress the steer callback and preserve pending directions without attempted history. Clearing the disposable condition delivers the same two queued directions in order with a fresh profile read. Two concurrent profile preparers produce exactly one attempted/acknowledged history. A hold after send preserves acknowledgement without replay; existing ambiguous/rejected native outcomes remain covered. These deterministic callback assertions are not model-consumption evidence.
- Final isolated full regression: **802 passed, 0 failed, 0 cancelled, 0 skipped**, exit 0. The initialized-capacity scheduling/preparation focus also passed **6/6**. Build and suite ran serially with no overlapping acceptance/rebuild; all 433 driver-captured source hashes stayed unchanged.

The manager independently reproduced the preparation-hold failure before the fix and confirmed zero native sends after the fix. Final corrected-source real subscription acceptance also passed: two ordered acknowledgements and separate model-consumption reports before any result, current saved profile consumed, same run/thread/native turn/worktree and natural confirmed exit, with no physical microphone. Earlier packaged/native UI evidence above remains prior-head evidence; the correction changes only the ordinary steering/profile boundary. Four existing tracked files changed with no source-manifest additions/removals. The manager reviewed this correction for the authorized integration PR; signed publication remains a subsequent stage.
