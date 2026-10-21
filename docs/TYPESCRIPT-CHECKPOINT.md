# TypeScript migration checkpoint — paused

The human paused issue #37 on 21 October 2026. Preserve this branch and wait for the five functional changes below to complete, receive human merge approval and reach main. Resume only after an explicit instruction. No ready PR, merge, release or version bump is authorized by this checkpoint.

Baseline: main commit `7425d1b7e1d9b8c87402dbfa8184f5237149bfeb`, version `0.13.1`. Migration branch: `codex/typescript-modularization`. No pending feature history has been merged or cherry-picked into it.

## Preserved implementation

Production implementations have been migrated from 102 JavaScript modules to 182 TypeScript modules, with responsibility-based extractions across native transport/protocol/history, controller launch/lifecycle/verification, execution persistence/recovery/toolchains, desktop hosts/setup/update/tray, HTTP/MCP and renderer views/hooks. This is a checkpoint, not a declaration that the migration is complete.

Node/Electron ESM source uses `.mts`, sandboxed preloads `.cts`, and renderer source `.ts`/`.tsx`. Strict NodeNext compilation emits `.mjs`/`.cjs` into `runtime/`; Vite builds the renderer. Executable/static resource roots use `runtime/`, while source-checkout default configuration and legacy fixture lookup retain their original checkout root. External config/state/profile paths remain authoritative. Tests/build/release tooling and the developer-only annotation harness deliberately remain JavaScript.

`npm run build` checks both strict projects, clears stale generated runtime modules, compiles and copies declared resources. The package entry is `runtime/desktop/main.mjs`; CLI entry is `runtime/cli.mjs`. `npm test` builds first and exercises emitted backend/child-process modules plus renderer TypeScript helpers. Never rebuild that runtime while its disposable tests/controllers use it. See [the workflow and rename map](TYPESCRIPT.md).

Source archives use the exact reviewed `scripts/source-manifest.json`, including after extraction without Git. `npm run source:manifest` refreshes it from staged/tracked source. Archive creation now disables macOS AppleDouble/xattr copying for its tar subprocess. A regression check excludes an untracked synthetic JSON evidence file. Browser validation must work under the existing strict CSP and preserve legitimate null/unavailable states.

## Evidence and limitations at pause

- Strict production typechecking passes. Builds succeed; production has no blanket `any`, suppression directives, `allowJs` or `checkJs` migration shortcut.
- Focused execution checks passed 30/30; three isolated legacy/completion regressions passed. Desktop/evidence checks passed 137 focused cases. Renderer/voice, browser scroll and worker navigation checks passed under production CSP.
- Source native end-to-end acceptance passed with two isolated projects, synthetic voice and worker protocols, capacity changes, project switching/drafts, cooperative stop, close/background operation, Quit and retained-state reopen. No physical microphone was captured.
- A real subscription read-only check confirmed ChatGPT account preparation and 25 available voices; no thread, model turn or voice connection was started.
- A clean source archive with exactly 347 manifest entries installed with `npm ci`, passed strict/Vite build and 34 focused configuration/HTTP/API/voice checks. A final checkpoint archive will contain this additional checkpoint document after manifest refresh; that revised document count is not a new tested archive claim.
- The third complete suite finished 507/510. Its three failures were runtime project-scope validation rejecting legitimate minimal records (two cases), and fixture cleanup racing a pending journal write (`ENOTEMPTY`). Source corrections preserve optional legacy scope fields. The cleanup correction shuts down the owned bridge before removing its directory; four bounded focused runs passed 5/5. Product shutdown semantics/timeouts were unchanged.
- The fourth complete suite was already running when the user paused and was allowed to conclude: **512/512 passed**, no failures, cancellations or skips. This validates its emitted-runtime snapshot, not integration with the five pending features or final updated packaged acceptance. Subsequent small source-archive/type/checkpoint edits are not a new full-suite claim; the archive correction is covered by the clean-source focused checks. Earlier failed-run and diagnostic evidence is retained privately outside Git.
- An earlier unsigned candidate package built successfully, but its native run exposed renderer CSP and nullable-payload regressions. Those were fixed and source-native acceptance passed. A fresh final candidate build and packaged acceptance remain outstanding. No signed release, updater installation, publication or acoustic acceptance is claimed.
- The independently reported ordinary-Quit issue #39 is not diagnosed or fixed here. The fixture cleanup hang had a demonstrated test-specific cause; passing synthetic native Quit does not establish that issue #39 is resolved.

## Required feature dependencies

| Change | Integration boundary |
| --- | --- |
| PR #36, manager scratchpad (#26) | Persistent manager notes/commitments, scheduling and read-only UI; preserve stop semantics and its complete history. |
| PR #40, manager profiles (#35) | Schema-2 identity/voice ownership, partial saves, composed instruction activation and supported `turn/start` additional context plus realtime retained instructions. Port the complete instruction-propagation fix. |
| PR #41, conversation reconciliation (#38) | Exact native thread/item/turn/actor provenance, `origin`, `restoreProvenance` and primary/work-details presentation. Do not invent text-based dedupe. |
| Issue #42, retained-worker follow-up assignments | New assignment/run contracts through store/controller/launch/lifecycle/native protocol. Do not implement them independently in the structural branch. |
| Issue #43, archives | Separate functional work pending its own PR and reviewed merge; inspect its final contracts before integration. |

## Resumption

After explicit human authorization and the five approved main merges, fetch main and merge its complete history into this migration branch. Resolve integration as implementation work: port every feature through the actual typed/module boundaries, extend validators/contracts and preserve histories/data/native behavior. Do not silently omit a feature or copy isolated fragments instead of the agreed history strategy.

Then finish current-source regression validation, clean source archive/build/package checks and fresh isolated packaged Electron end-to-end acceptance. Reconcile only owned disposable test processes using actual identity evidence. Keep installed/user profiles, business repositories/services, physical microphones, published artifacts and unrelated work untouched. Open a reviewable PR into main only when the resumed work is ready; merging and releasing remain separate human decisions.
