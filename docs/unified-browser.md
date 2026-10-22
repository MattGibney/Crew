# Shared project browser — #56 first pass

This ports the independent PR99 experiment onto the unified-agent platform. One owner-visible local HTTP page can be shared with one explicitly selected, started agent session. Annotations are now included. PR99's prior no-integration pause is historical; this delivery was explicitly resumed for a feature-branch PR. Main composition/integration belongs to the coordinating delivery track.

## Owner flow

Open **Browser**, enter a local app URL, and open the page. Back, forward, reload and close act on that same native page. Selecting an agent does not start it. Explicitly connect the desired started agent to the browser; stopping/restarting the agent invalidates the old binding. The selected agent must also have a project-scoped **browser · control** permission in an owner-approved group. No existing/default group receives it automatically.

Choose **Select element** and click a page element, or **Annotate page**. Feedback is sent on **Send annotation**, through existing owner-attributed agent messaging, to the recipient captured when annotation began. A selection does not run the clicked page action. The message carries URL/title, capture timestamp, optional selector/text/bounds and an opaque screenshot reference. `browser_annotation_image` returns that stored image only to its recorded recipient with current browser permission and binding. Element selection and screenshot have separate timestamps when capture occurs at send time; the screenshot is not a claim of current page state after later navigation.

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

Combine the existing skill extension and `browser.tools(context)` through `combineAgentToolExtensions`. The existing foundation MCP authenticates exact logical sessions; browser tools additionally check owner binding and fresh `browser.control` authorization. Tool discovery uses read-only authorization and never calls execution admission or starts a model turn. Actual dispatch goes through `runAuthorized` and rechecks binding before upstream I/O. Extension `subscribe` refreshes catalogue notifications without granting access. Generic schema-validated `{crewMcpResult}` results preserve image content; durable invocation correlation remains in the normal MCP host.

The minimal optional AgentsApp slot receives `{snapshot,selectedAgent,client,visible}`. DesktopApplication supplies `ProjectBrowser`. The view remains mounted while hidden, hides its native child bounds outside Browser, and preserves other conversation/voice components. Root main wiring is deliberately not implemented in this track's files; it must be applied in combined source before product acceptance.

## Isolation and tooling

The preview has its own ephemeral session, no Crew preload, Node or IPC bridge, denied permissions/downloads/popups, and an origin filter applying to redirects/subresources. Owner navigation can switch to another local HTTP origin by replacing the preview; agent navigation remains on the configured origin. Crew's own origin and loopback-port aliases are rejected.

A scoped browser-level CDP facade exposes only that preview. Raw Electron app-wide debugging is not an agent capability: it exposes Crew's host even when host DevTools are disabled. The independent Chrome DevTools MCP 1.12.0 client attaches to the scoped endpoint; no Chrome/browser launch, personal profile, model auth or service credential inheritance occurs. Its tool process uses a private HOME, explicit environment and disabled config discovery/telemetry. Unknown tool outcomes are never automatically retried. Shutdown closes stdin, then may terminate only that owned tool process; unknown exit is retained as failure, never followed by a force kill.

Browser tools preserve upstream `pageId` schemas. Use `browser_list_pages`, then `browser_take_snapshot`, navigation, fill/click, script evaluation and screenshots. Global browser management, new tabs, file navigation and unsupported domains remain unavailable.

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

Completed bounded fixture checks cover visible fill/click, discovery, MCP screenshot content, element-feedback recipient/provenance, historical image retrieval, permission revocation and stale logical-session rejection. Screenshots and operational records stay outside Git. **Actual signed-in selected-agent discovery/control and annotation consumption remain combined root acceptance**, not a claim made from this fixture. No broad test-suite expansion or release/installation is implied.

First-pass limits: one local HTTP origin/page/client; external API/CDN origins, HTTPS, multitab, arbitrary personal logins, OOPIF/child targets and full Chrome parity are unsupported. Screenshots are private per-project artifacts, not copied into the native model's filesystem; agents inspect them through the permission-checked image tool. Direct model file attachment delivery is not added. This is a scoped browser target, not a hostile-code OS sandbox.
