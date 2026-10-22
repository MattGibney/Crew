# Embedded browser experiment — GitHub #56

This is an explicitly authorized local experiment for [Crew #56](https://github.com/MattGibney/Crew/issues/56), not feature delivery. The earlier feasibility conversation did not authorize implementation. Annotations, multiple tabs, Crew agent integration, external ticket changes, release and deployment remain deferred.

## What is independent

`src/desktop/project-browser.mts` owns one native `WebContentsView`, an in-memory browser session, navigation policy and lifecycle. `browser-cdp.mts` presents that view through a small browser-level Chrome DevTools Protocol facade. Neither imports manager/worker code, configures Codex, starts an agent or changes a saved profile. The renderer owns only the surrounding controls and the viewport rectangle. The existing main-frame IPC identity check gates panel requests.

The interface is `request({action, url?, bounds?})`, an observable state snapshot and the native module's `endpoint()` accessor. The independent harness obtains the endpoint from the native surface. There is deliberately no saved MCP configuration, automatic agent discovery or prompt injection. Later integration can consume this endpoint without changing how the browser owns its page, subject to a separately agreed routing design.

Normal Crew has no Browser button. `CREW_BROWSER_EXPERIMENT_URL` explicitly enables the experiment for the process; it must be a local HTTP preview URL, on a different port from Crew. No settings are saved. This environment flag is for disposable development only.

## Why a scoped adapter was necessary

A disposable probe with Electron 44.9.2 showed both the host `BrowserWindow` and embedded preview in `/json/list`, including when the host used `devTools: false`. An application-wide `remote-debugging-port` therefore fails the intended target isolation. The browser module does not enable it. The disposable Playwright acceptance driver does add its own app-wide debugging endpoint for host observation; that test-only endpoint is never supplied to Chrome DevTools MCP. The isolation assertions exercise the advertised preview facade, not the trusted inspection driver. Normal Crew launch does not include those driver flags.

The facade listens on an ephemeral loopback port and unpredictable capability path, accepts one non-browser WebSocket client, and exposes one generated target identity. It implements the small browser discovery/attachment subset expected by Chrome DevTools MCP; page commands run through only the preview's `webContents.debugger`. Foreign targets/sessions, global browser management, target creation, and unapproved protocol domains fail explicitly. Disconnect releases the owned debugger; a new client can reconnect. Close removes the view and endpoint; reopen creates a new endpoint.

The preview has no preload, Node integration or Crew bridges. Its separate session denies permissions, downloads, popups and requests outside its configured preview origin, including redirects. This first version is intentionally limited to a single local origin: applications depending on another API origin, external assets, HTTPS, OAuth popups or downloads need later design. It is target isolation, not a hostile-code operating-system or filesystem sandbox. A local process with the user's existing authority is outside that claim.

## Reproduce

Install checkout dependencies with `npm ci`, then run `npm run build`. Builds and runtime validation must be serialized. Use a local Node installation with Chrome DevTools MCP **1.12.0** and Playwright Core installed; they are harness tools, not Crew runtime dependencies. Set their paths explicitly:

```sh
CREW_PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs \
CREW_CHROME_MCP_BIN=/absolute/path/to/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js \
node scripts/embedded-browser-native-acceptance.mjs
```

Add `CREW_BROWSER_INSPECT=1` to leave the successful disposable native Crew window open for inspection. The command prints its live endpoint; Ctrl+C cleans up that experiment. This uses the actual compiled Crew project window, preload, renderer and browser module with a synthetic backend and synthetic local preview server. It is not a separately implemented browser application, and it never starts Crew's manager/worker runtime. No installed app or user configuration is used.

The independent harness speaks MCP JSON-RPC over stdio, initializes Chrome DevTools MCP, lists tools, discovers the preview and invokes real tools. It asserts visible navigation, form fill/click, screenshots and bidirectional observation of synthetic native input. It also checks panel navigation, narrow layout, preserved manager draft/focus and single manager event stream, host/redirect/request blocking, foreign target/session rejection, client reconnect, endpoint close/reopen and absence of capture/worker actions. Cleanup is registered before the first wait and awaits owned process exit.

Artifacts go to the printed OS temporary directory. On macOS, native `screencapture` captures the complete actual window (including embedded views). The MCP PNG is the page screenshot. A renderer-only Playwright screenshot omits `WebContentsView`; it is insufficient evidence of native visibility. Keep all captures and operational evidence outside Git. Human acoustic or physical device acceptance is not claimed.

Focused regression checks after building:

```sh
node --import tsx --test --test-concurrency=2 \
  tests/browser-cdp.test.mjs tests/desktop.test.mjs \
  tests/desktop-controller-api.test.mjs tests/workspace-requests.test.mjs
```

## Observed compatibility and limits

The experiment was validated with Electron **44.9.2** / Chromium **152.0.7977.167** and Chrome DevTools MCP **1.12.0** on macOS. Navigation, snapshots, filling, clicking, script evaluation, page screenshots and reconnect work through the scoped adapter. The MCP client's page ID is obtained from `list_pages`, not assumed.

Puppeteer's browser-level autoattachment needs target events before the acknowledgement; a facade that replies first can initially report no pages. Extra explicit CDP sessions are mapped to the same preview only. Child targets/OOPIFs, service workers, multiple tabs and multiple clients are not implemented. Advanced requests such as WebMCP, Autofill, Storage, DevTools-target access, performance recording and global browser management are unsupported or deliberately denied; success of the basic tools does not establish full Chrome parity.

The native test uses compiled source and the real Electron window with fixture data. It does not establish signed packaged distribution, production multi-project acceptance, real login persistence, live voice continuity or Crew-agent tool availability. Those remain separate future work. Stop at this independent experiment; do not automatically integrate it into production agent sessions.
