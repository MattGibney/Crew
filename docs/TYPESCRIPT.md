# TypeScript source and responsibility boundaries

Crew's shipped implementations use strict TypeScript: `.mts` for Node/Electron, `.cts` for preloads, and `.ts`/`.tsx` for React. NodeNext imports name emitted `.mjs`/`.cjs` files. No TypeScript loader ships in the application.

Run `npm ci`, `npm run build`, then the ordinary `npm start` or desktop commands. The build checks both strict projects, emits `src/` into `runtime/`, builds the renderer, and copies declared resources. `npm test` builds first and exercises emitted backend modules and real disposable subprocesses with test-file concurrency two. Renderer tests use the development-only tsx loader. `npm run typecheck` checks both projects without emission.

Never rebuild while a controller or test uses the same runtime: builds deliberately remove stale modules. Source controllers, Electron packaging and child supervisors all use compiled files. Supported thin executable entries are `runtime/cli.mjs`, `runtime/server.mjs` and `runtime/orchestration-mcp.mjs`; Electron starts `runtime/desktop/main.mjs`. Internal imports use their domain directories. `src/shared/paths.mts` defines the runtime resource root independently of module depth. Default source-checkout configuration and legacy fixture state still resolve from the checkout root; explicit external configuration stays authoritative.

## Before and after

The earlier production tree mixed roughly a hundred JavaScript implementations across the repository root, native host and renderer. The migration now groups production code by responsibility and splits previously combined process, persistence, protocol, projection and UI concerns.

| Former responsibility | Current source boundary |
| --- | --- |
| Root config loader and embedded environment validation | `src/config/`: structural schemas, semantic environment validation, raw/loaded contracts and loading. MCP context is deliberately less specific than execution-ready configuration. |
| Root CLI and source packaging | `src/cli/`: commands, bounded option parsing and exact source archive manifest handling. Root executable entries only import composition modules. |
| Root server, HTTP/SSE and settings | `src/http/`: project bootstrap, project/update routes, request decoding/bounds, event-stream lifetime, settings projection and serialized saves. |
| Large native manager bridge | `src/manager/bridge/`: process launch/handshake, native requests/startup correlation, RPC transport, protocol decoders, native thread recovery, history hydration, journals, passive observation, voice session, and serialized start/steer/cancel delivery. The index owns one synchronized manager actor. |
| Conversation and manager state | `src/manager/conversation/` owns message projection and stable timeline identities; `instructions/` owns prompt validation, persisted pristine-default provenance and full replacement settings; `reviews/` owns local scheduling and admission. Profile pictures, lifecycle storage and scratchpad presentation feed have separate modules. |
| Task store and MCP | `src/orchestration/`: state locking, persisted validation, history/Markdown projection, assignments, directions/workflow, archive journals, atomic mutation APIs, public MCP catalogs and validated role-bound dispatch. |
| Worker execution | `src/workers/`: controller composition, queued-direction settlement, new/retained native launches, lifecycle requests, archive disposal, process reconciliation, native peer transport, runner controls, approval storage/validation and final evidence. |
| Project lifecycle/discovery and toolchains | `src/projects/`: lifecycle plans, source integrity, retained recovery, supervised commands, environment settings and bounded discovery inventory/proposal/CLI worker. `src/toolchains/` separates requirements/registry schemas from bounded download/archive/cache installation. |
| Native application | `src/desktop/`: parent composition, project backend host, renderer-window security/lifetime, workspace registry, native request boundaries, setup window/RPC/account/discovery application, update primitives and durable all-project participant correlation. |
| Safe updates and process evidence | `src/updates/`: admission, durable pause/resume plan, retained-plan validation, IPC/update bridge and separate disk/process evidence readers. `src/processes/` owns verified process identities/cooperative interruption. |
| Renderer | `renderer/src/`: focused Settings editors, worker evidence/history/actions, composer drafts, one SSE owner, one call owner and setup step components. API/SSE schemas use a non-evaluating validator compatible with strict CSP. |

The remaining larger files are synchronized coordinators, not miscellaneous helper collections. Manager bridge index coordinates its one native actor across await boundaries; runner coordinates native turn bootstrap/correlation and final settlement; task store exposes atomic mutations under the same state lock; update plan owns one durable transition journal. Desktop main wires the parent application; setup host serializes draft/discovery/save cancellation and stale-input checks. Their extracted responsibilities are independently inspectable and tested. Module size alone is not an acceptance criterion, and future changes should continue extracting real responsibilities rather than hiding coupled state behind arbitrary fragments.

## Type and runtime boundaries

Both projects use strict checking, no emission on backend errors, explicit ESM syntax and consistent casing. Untrusted JSON/native/HTTP/process observations begin as `unknown` and pass structural schemas or explicit guards before typed use. Typed contracts never replace runtime source-hash, identity, origin, ownership, approval, state-lock or reservation checks. Partial historical evidence is distinct from a full live process identity. Null/unavailable values remain unavailable.

No blanket `any`, TypeScript suppression or unchecked JSON cast is needed. `as const` declares literal protocols; schema-backed narrowing establishes wire/persisted shapes. Native manager requests remain distinct from client RPC replies even when numeric IDs overlap. MCP command context may contain legacy partial descriptions; it is not proof of an execution-ready project or permission to execute commands.

The intentionally untyped scope is development/build/release tooling and tests. The only renderer source exception is `renderer/src/preview/main.jsx`, the developer-only annotation harness loaded by `scripts/ui-preview/start.mjs`; it is excluded from production typechecking and shipping. Its scenario harness imports the real typed renderer and stubs effects. This is not a claim that every repository executable is TypeScript.

## Integration and distribution

History-preserving merge `ead6e9a` includes released main `eb75439917964a194d98aa74c1ab6309ffb64da7` / 0.15.0: scratchpad, profiles, conversation reconciliation, ongoing workers, archives, environment settings, agent-owned workflow/direction behavior and persisted pristine prompt upgrades. Customized prompt bytes, active snapshots, histories, user settings and normal native approvals remain intact. Version 0.15.0 is inherited metadata; this migration does not authorize publication, a version bump or a merge to main. Presentation/usage/browser feature branches are outside this scope.

The source archive uses committed `scripts/source-manifest.json`, including after extraction without Git. After staging source additions/removals, run `npm run source:manifest`, review the allowlist, and commit it with the change. No recursive sweep may include local settings, credentials, conversations, worker evidence, screenshots or installers. The tar subprocess disables macOS AppleDouble/xattr sidecars. Native packages contain emitted runtime and production dependencies, not source loaders.

Current acceptance evidence belongs to the associated ticket/PR and private artifact directory. Historical pause evidence stays in `docs/TYPESCRIPT-CHECKPOINT.md`; it does not establish final integrated acceptance. Native Quit issue #39 and custom portable-profile automatic-updater relaunch remain separate known boundaries. No physical microphone or user installation/profile is required by automated migration checks.
