# TypeScript source and module boundaries

Crew's production source is TypeScript. Node and Electron ESM modules use `.mts`, preloads use `.cts`, and React uses `.tsx` with `.ts` helpers. Relative Node imports keep emitted `.mjs`/`.cjs` extensions; NodeNext resolves them to typed source during checking. No runtime TypeScript loader is shipped.

Run `npm ci` and `npm run build` in a clean source checkout. The build checks both strict TypeScript projects, compiles backend and native source into `runtime/`, builds the React renderer with Vite, and copies only declared static resources into that runtime. Run `npm start`, `npm run init -- ...` or `npm run desktop:dev`. The executable entry points are `runtime/cli.mjs`, `runtime/server.mjs`, and `runtime/desktop/main.mjs`. Electron packaging and child processes use those compiled entry points. `npm test` builds first and tests the emitted backend, including actual spawned supervisors; renderer tests run TypeScript through the development-only tsx loader.

Do not build while tests or an acceptance controller are using the same `runtime/` directory. Builds deliberately remove stale generated modules. Stop the disposable run first, rebuild, then launch it again. Native packaging calls the same build before collecting runtime assets. Signed release prerequisites and deliberate publication remain unchanged.

`npm run typecheck` checks production without emitting. `npm run renderer:build` remains available for isolated renderer design work, but a source controller/native package needs the full build. Generated runtime, renderer assets, packages and screenshots are excluded from Git. Tests, browser fixtures, build/release tooling and the developer-only annotation preview intentionally remain JavaScript; they are not shipped production implementations.

## Responsibility map

| Boundary | Source ownership |
| --- | --- |
| Configuration | `config.mts` owns semantic/path validation and loading; `config/contracts.mts` declares raw/loaded shapes; `config/shape.mts` validates structural JSON before it receives a type. |
| HTTP | `server.mts` owns one project bootstrap, server/SSE lifetime and dispatch; `backend/http-input.mts`, `project-api.mts`, `settings-view.mts`, `update-routes.mts` own validated request projection, project API dispatch, settings projection and update routing. |
| Manager/native protocol | `codex-bridge.mts` owns the native manager lifecycle; `bridge/` separates protocol validation, client request correlation, conversation journals, history hydration, bounded redaction and passive native item/turn/transcript observation. |
| Conversation | `conversation.mts` owns display projection; `conversation-timeline.mts` owns stable timeline identity/order; `shared/conversation.mts` owns the wire contract. |
| MCP | `orchestration-mcp.mts` owns role-bound execution/stdio; `backend/mcp-tools.mts` owns public tool schemas; `mcp-contracts.mts` validates requests and arguments. |
| Worker execution | `controller.mts` reconciles durable tasks and ownership; `execution/` separates state locking, task validation, native approvals, worker protocol, completion evidence, plan integrity, TOML discovery and managed-tool metadata/requirements. |
| Native app | `desktop/main.mts` owns the parent; project host, setup host, setup RPC/account probes, workspace registry, all-project update coordination, update primitives and preloads retain separate interfaces. |
| Update safety | `update-plan.mts` coordinates durable pause/resume; `backend/update-plan-store.mts` validates retained plans; evidence reader/process verdict modules separate bounded disk access from ownership conclusions. |
| CLI | `cli.mts` executes the selected command; `backend/cli-options.mts` parses bounded flags; `backend/source-package.mts` owns the source archive allowlist. |
| Renderer | Settings separates profile/lifecycle/workspace/prompt/toast work; composer drafts/submission, worker panels/exchanges/actions, request retry, attention audio, voice and main SSE/bootstrap ownership have focused components/hooks. Browser API and SSE decoders use a non-evaluating schema interpreter before state updates; synthetic browser fixtures enforce the same strict script policy as production. |

Types do not establish authorization or process liveness. Runtime validators and the existing identity, source-hash, approval, path, origin, ownership and update reservation checks remain essential. Optional/null observations retain their original meaning; successful host execution still does not prove worker permissions, provider readiness or production correctness.

## Rename and parallel PR integration map

All former root `name.mjs` production implementations are now `name.mts`, with emitted `runtime/name.mjs`. Desktop `name.mjs` → `desktop/name.mts`; preload `name.cjs` → `desktop/name.cts`. Renderer production `name.js`/`name.jsx` → `name.ts`/`name.tsx`. Existing public payload keys, event names, file formats and state/profile locations are retained. In a source checkout, default configuration and legacy fixture-state lookup still use the original checkout root; executable/static resources use `runtime/`. Explicit external config paths remain authoritative.

PR #36 scratchpad changes must port manager MCP tools, bridge/lifecycle scheduling, state persistence and read-only renderer UI into the corresponding typed modules. PR #40 (issue #35) manager profiles must port profile storage/settings/API and its supported turn-start/realtime retained-instruction propagation, preserving explicit activation. PR #41 (issue #38) reconciliation must port canonical/partial/final/handoff/history fixes into conversation/bridge modules without a competing text-based dedupe. These changes are not included implicitly by this structural PR. Review each complete change, rebase/port through its actual new boundaries, preserve histories and rerun combined tests before eventual user-directed delivery.

The source archive uses the exact committed `scripts/source-manifest.json`, including after extraction without Git. It never recursively sweeps local JSON/Markdown/evidence files into a package. After staging added or removed source, run `npm run source:manifest`, review the allowlist and commit it with the source change.

Issue #42, retained-worker follow-up assignments, is a separate pending feature. Port its append-only assignment/run semantics through `orchestration-store.mts`, `controller.mts`, `execution/worker-launch.mts`, `execution/worker-lifecycle.mts`, `worker-runner.mts` and the typed MCP/renderer contracts after its own review. This refactor preserves current completion behavior and does not implement that feature.

On macOS, source archive creation disables AppleDouble/xattr sidecar copying for that tar subprocess, so the archive contains exactly its reviewed manifest entries and no machine-local metadata.
