# Agent-owned project browsers

Each stable agent owns its browser workspace and tabs. The owner chooses which workspace and tab to display; tool callers always control their own active tab, regardless of the workspace visible in the owner UI. The earlier #56 single-page prototype remains the basis of the scoped per-tab CDP boundary.

## Owner flow

Open **Browser**, enter a local app URL, and open the page. You may use an explicit development hostname when its system DNS results contain only loopback addresses; the URL and HTTP Host routing stay unchanged. Back, forward and reload act on the selected tab. New tab may start blank until a local URL is entered. Closing a tab leaves the other tabs; closing the selected agent browser leaves other agents' browsers running. Selecting an agent does not start it. Browser ownership survives stopping/restarting its native session; each actual tool call must still come from the exact current started session. The selected agent must also have a project-scoped **browser · control** permission in an owner-approved group. No existing/default group receives it automatically.

Choose **Select element** and click a page element, or **Annotate page**. Feedback is sent on **Send annotation**, through existing owner-attributed agent messaging, to the recipient captured when annotation began. A selection does not run the clicked page action. The message carries URL/title, capture timestamp, optional selector/text/bounds and an opaque screenshot reference. `browser_annotation_image` returns that stored image only to its recorded recipient with current browser permission and current session. Annotations must target the tab's owner, and metadata records the stable owner agent and tab IDs. Element selection and screenshot have separate timestamps when capture occurs at send time; the screenshot is not a claim of current page state after later navigation.

## Composition contract

`createUnifiedProjectBrowser` in `src/browser/unified-browser.mts` takes:

```ts
{
  projectId, stateDirectory,
  getWindow: () => BrowserWindow | undefined,
  getHostOrigin: () => string,
  getAgent: (agentId) => Agent | null,
  publish: (event: { type: 'browser', projectId, state }) => void
}
```

It exposes `state()`, owner-authenticated `request({projectId,action,...})`, `close()` and `tools({authorization,runAuthorized})`. Read-only inactive state needs no native agent/session. Main must authenticate the selected owner/project before `request`, forward state through the existing desktop event bridge, and close the old browser before project/window shutdown. Route the allowed preload method `browser` to this service; do not add a new unauthenticated renderer API.

Combine the existing skill extension and `browser.tools(context)` through `combineAgentToolExtensions`. The existing foundation MCP authenticates exact logical sessions; browser execution additionally checks stable agent ownership, the exact current started session and fresh `browser.control` authorization. Tool discovery uses `canDiscoverBrowser`: it verifies the exact current starting/started session and current project-scoped group permission, without requiring an open page or owner selection. It never calls execution admission or starts a model turn. The stable catalogue is generated from pinned `chrome-devtools-mcp@1.12.0` tools/list, allowing native sessions that cache tools at startup to discover schemas before a browser is shared. Regenerate after a serialized build with `node scripts/update-browser-catalogue.mjs`; generation asserts zero browser connections. Actual dispatch goes through `runAuthorized` and rechecks the caller before upstream I/O. The outer workspace dispatcher holds one execution-admission gate; the inner tab dispatch rechecks ownership/session without reacquiring that gate. Extension `subscribe` refreshes catalogue notifications without granting access. Generic schema-validated `{crewMcpResult}` results preserve image content; durable invocation correlation remains in the normal MCP host.

The minimal optional AgentsApp slot receives `{snapshot,selectedAgent,client,visible}`. DesktopApplication supplies `ProjectBrowser`. The view remains mounted while hidden, hides its native child bounds outside Browser, and preserves other conversation/voice components. State events always describe the owner-selected workspace. Hidden tabs retain a 1280×800 viewport for background tool screenshots; changing UI selection hides the previous native view without destroying it.

## Isolation and tooling

Each agent has a private persistent Electron session, shared by its tabs but isolated from other agents and Crew. Cookies and local storage can survive native-session restart and app relaunch; the tab registry and active selection currently live only for the desktop process lifetime. No personal browser cookies or credentials are imported. Every tab has no Crew preload, Node or IPC bridge, denied permissions/downloads/popups, and an origin filter applying to redirects/subresources. Explicit owner or agent URL navigation can switch a tab to another allowed local HTTP origin by replacing its scoped preview. Each tab permits one origin at a time. Different tabs may use different explicitly selected local origins. Request filtering is registered once per agent session and selects the tab policy by WebContents identity; opening another tab must never overwrite an earlier tab's filter. Crew's own origin and loopback-port aliases are rejected. The generic policy has no application-specific hostname rules. Direct networking is set only on the preview session to avoid inherited remote proxies; Chromium's system resolver is checked before opening and before each permitted request, rejecting unavailable, empty or mixed loopback/non-loopback results. This trusts the local development resolver configuration; it is not an OS-level hostile-DNS/network sandbox.

Same-host/same-port `ws://` transport is allowed for the explicitly selected HTTP preview, so normal dev HMR can operate. It does not permit WebSocket navigation, another loopback hostname/port, a Crew port, secure/remote WebSockets, or a second origin. Other API/CDN origins remain blocked. Owner-selected local naming does not authorize editing the preview application's tooling, source or DNS setup.

A scoped browser-level CDP facade exposes only one tab. Raw Electron app-wide debugging is not an agent capability: it exposes Crew's host even when host DevTools are disabled. The independent Chrome DevTools MCP 1.12.0 client attaches to the scoped endpoint; no Chrome/browser launch, personal profile, model auth or service credential inheritance occurs. Its tool process uses a private HOME, explicit environment and disabled config discovery/telemetry. Unknown tool outcomes are never automatically retried. Shutdown closes stdin, then may terminate only that owned tool process; unknown exit is retained as failure, never followed by a force kill.

Browser tools preserve upstream `pageId` schemas. Use `browser_list_pages`, then `browser_take_snapshot`, navigation, fill/click, script evaluation and screenshots. Use `browser_tabs` for stable tab IDs, `browser_new_tab` to create a blank/local tab, `browser_select_tab` to choose your own tab, and `browser_close_tab` to close it. These four schemas are available alongside the original 15 schemas before any browser is opened. `browser_list_pages` enumerates the active tab's scoped CDP target rather than the workspace. Global browser management, file navigation and unsupported domains remain unavailable.

## Bounded reproduction and acceptance

From the checkout, serialize build and validation:

```sh
npm ci
npm run typecheck
npm run build
CREW_PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs \
  node scripts/unified-browser-native-acceptance.mjs
```

Playwright Core 1.62.1 was used as the external native test driver. Electron 44.9.2/Chromium 152 and the pinned Chrome DevTools MCP 1.12.0 are the validated combination. The native harness uses the actual unified window, renderer, browser, independent tool subprocess and authenticated foundation MCP host, with a **synthetic agent/session/authorization source and synthetic owner-message receipt**. It starts no signed-in model, touches no installed profile, and captures no physical microphone. Its trusted Playwright driver separately has app-wide host-observation access; this is not supplied to the browser tools.

Completed bounded fixture checks cover startup discovery before opening/binding, denied execution while starting or unbound, visible fill/click, discovery, MCP screenshot content, element-feedback recipient/provenance, historical image retrieval, permission revocation and stale logical-session rejection. The optional `CREW_BROWSER_TEST_HOST` runs that same synthetic server under an existing owner-configured local hostname; the fixture verifies the unchanged Host header plus positive same-origin and negative alternate-host WebSocket behavior. It never changes system DNS or another project. Screenshots and operational records stay outside Git. **Actual signed-in selected-agent discovery/control and annotation consumption remain combined root acceptance**, not a claim made from this fixture. No broad test-suite expansion or release/installation is implied.

Current limits: one local HTTP origin per tab; external API/CDN origins, HTTPS, imported personal logins, OOPIF/child targets and full Chrome parity are unsupported. Tabs themselves are not restored after app exit. Screenshots are private per-project artifacts, not copied into the native model's filesystem; agents inspect them through the permission-checked image tool. Direct model file attachment delivery is not added. This is a scoped browser target, not a hostile-code OS sandbox.

The stable-catalogue follow-up passes 19 native fixture checks plus the real permission-service fixture (`node scripts/browser-discovery-acceptance.mjs`). The latest run explicitly used `CREW_BROWSER_SKIP_NATIVE_SCREENSHOTS=1` after macOS window capture failed; this skips only window capture and records that limit in `checks.json`. MCP page and annotation image checks still pass. It does not establish fresh native-window screenshot or signed-in-model acceptance.


## Agent workspace acceptance

Run `scripts/agent-browser-tabs-native-acceptance.mjs` with the same external `CREW_PLAYWRIGHT_MODULE` after building. This disposable fixture creates two synthetic agents with two real native tabs each and drives actual scoped CDP/MCP subprocesses. It uses a non-reentrant authorization gate, checks cookie sharing within one agent and isolation across agents, background screenshots, foreign-tab rejection, blank-tab navigation, annotation-recipient rejection, stable ownership after session replacement, stale-session and revoked-permission rejection, selected-agent close and global teardown. It does not start a signed-in model or read the installed user profile. Native renderer UX acceptance is separate from these backend checks.

The owner projection adds `ownerAgentId`, `activeTabId` and `tabs` while retaining the original fields. Requests add optional `agentId`/`tabId` and actions `select_agent`, `new_tab`, `select_tab`, `close_tab`. `recipientAgentId` remains a legacy owner alias for opening; annotations require it to match the selected tab owner. A stale resize/hide request carrying another agent or tab identity is ignored.

Signed-in combined acceptance for #121 also passed against a disposable retained profile using the actual desktop renderer, authenticated foundation MCP and subscription-backed manager. The manager discovered the new tab tools, created its own second tab, filled/clicked the exact local test page, took a screenshot and consumed an owner annotation in the same retained native chat. Exact native Stop, original group-assignment restoration and normal Quit were confirmed. This is text/model acceptance; no physical microphone, personal browser profile, installed-app update or packaged-build acceptance was performed for #121.

A separate real Chromium interaction check of the actual React browser panel with a simulated desktop bridge verified agent selection (including stopped agents), multiple-tab navigation/select/close, exact owner/tab request identity, draft retention across tab and agent switches, and hide/reopen without tab closure. This isolates renderer behavior; it is separate from the real Electron/CDP/MCP and signed-in model checks above.
