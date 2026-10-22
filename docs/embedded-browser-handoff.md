# Paused browser experiment — #56

**Status: preservation-only draft; agent integration is explicitly deferred until a later user request.** Major agent architecture changes are proceeding separately. Do not merge this experiment into that work, wire it into sessions or infer authorization from the earlier feasibility discussion.

Related issue: [Crew #56](https://github.com/MattGibney/Crew/issues/56). This prototype does not close the broader issue. Preserve branch `codex/gh56-embedded-browser-experiment` and its isolated worktree; do not archive/delete it as part of pausing.

## Preserved boundary

- `src/desktop/project-browser.mts`: one native `WebContentsView`, private ephemeral browser session, local-origin navigation and lifecycle.
- `src/desktop/browser-cdp.mts`: single-preview CDP facade for an independent Chrome DevTools MCP client; no manager/worker imports or agent configuration.
- `renderer/src/contracts/browser.ts` and `ProjectBrowser.tsx`: optional `window.crewBrowser.request({action,url?,bounds?})` / `onState(listener)` panel interface. Actions: state, open, close, navigate, back, forward, reload, bounds. The native surface exposes `browserEndpoint()` for the harness; closing/reopening rotates it.
- Native main/preload/project-window glue is experiment-gated by `CREW_BROWSER_EXPERIMENT_URL`, uses existing trusted-main-frame identity checks and saves no settings. There is no agent discovery, prompt injection or tool registration.
- `scripts/embedded-browser-native-acceptance.mjs`: actual compiled Crew window/renderer with synthetic backend and local page, driven by an independent MCP stdio harness. It starts no Crew agent runtime.

Raw Electron debugging exposed the privileged host despite `devTools:false`; it is not the control boundary. The scoped endpoint exposes only the preview. The trusted Playwright test driver separately uses app-wide debugging for host observation, never supplied to the MCP client.

## Recorded validation, 22 October 2026

Electron **44.9.2**, Chromium **152.0.7977.167**, Chrome DevTools MCP **1.12.0**, Playwright Core **1.62.1**, macOS. Prior completed validation: **27/27 native checks**, **15/15 boundary/desktop tests**, **15/15 configuration/source-package tests**, build, typecheck and diff checks. These are historical experiment results, not acceptance of future architecture or a signed packaged release. Documentation/evidence preservation did not rerun the full suite.

Proven: visible MCP navigation/fill/click/screenshots; synthetic native input observed by MCP; target/session/host-origin rejection; reconnect and panel lifecycle; native narrow layout; manager draft/focus and one event stream; no physical microphone or worker actions. Native window screenshots and the MCP page PNG are retained privately outside Git. Bundle identifier: `gh56-embedded-browser/2026-10-22`. The owner-facing chat/private index holds the machine-specific location; do not add it or private artifacts to this repository/PR.

## Exact reproduction after explicit resume

From this branch's checkout, with Node 22+ and a macOS GUI session, run:

```sh
npm ci
npm run build
browser_harness_dir="$(mktemp -d "${TMPDIR:-/tmp}/crew56-harness.XXXXXX")"
npm install --prefix "$browser_harness_dir" --no-save chrome-devtools-mcp@1.12.0 playwright-core@1.62.1
CREW_PLAYWRIGHT_MODULE="$browser_harness_dir/node_modules/playwright-core/index.mjs" \
CREW_CHROME_MCP_BIN="$browser_harness_dir/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js" \
node scripts/embedded-browser-native-acceptance.mjs
```

Keep builds serialized with tests. For interactive inspection add `CREW_BROWSER_INSPECT=1` to the final command; Ctrl+C cleans up its disposable processes. macOS native screenshots require existing screen-capture access; do not bypass a locked screen or substitute renderer-only captures for native visibility. See [experiment details and focused test commands](embedded-browser-experiment.md).

## Resume checklist

1. Obtain an explicit request to resume and confirm whether scope includes agent integration or only browser work.
2. Read current AGENTS, this handoff and the experiment document; inspect branch/PR state and upstream changes without resetting the retained worktree.
3. Refresh the **new** agent architecture, session/tool configuration, ownership and permission model from current source/docs. Do not assume the old manager/worker internals or copy their old integration patterns.
4. Agree a routing design against the stable browser interface. Preserve target isolation, ordinary native permissions, subscription authentication and the separation between the test driver and advertised endpoint. Make agent changes only if newly authorized.
5. Rebuild the chosen combined source and rerun applicable independent/native checks. Add actual agent-session acceptance only when integration is authorized; standalone MCP success is not that evidence.

Remaining scope: one configured local HTTP origin and one client/page only; no OOPIF/child-target support, persistent login acceptance, full Chrome parity, annotations, production multi-project acceptance, signed packaged-release validation or live voice continuity. No release, deployment or merge is authorized by this preservation task.
