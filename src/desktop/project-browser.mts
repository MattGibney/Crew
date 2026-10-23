// Self-contained GH-56 prototype. No manager, worker or Codex imports/configuration.
import { WebContentsView, session, type BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { createBrowserCdp } from "./browser-cdp.mjs";
import { record } from "./validation.mjs";

export { parseLocalPreviewURL as experimentURL } from "../browser/local-origin.mjs";
import {
  parseLocalPreviewURL as experimentURL,
  requireLoopbackResolution,
  isLocalPreviewRequest,
} from "../browser/local-origin.mjs";

type PreviewSession = ReturnType<typeof session.fromPartition>;
type PreviewTarget = {
  origin: string;
  hostOrigin(): string | undefined;
  verifyHost(): Promise<unknown>;
};
const sessionTargets = new WeakMap<
  PreviewSession,
  Map<number, PreviewTarget>
>();
function targetsFor(partition: PreviewSession) {
  let targets = sessionTargets.get(partition);
  if (targets) return targets;
  targets = new Map<number, PreviewTarget>();
  sessionTargets.set(partition, targets);
  partition.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  partition.setPermissionCheckHandler(() => false);
  partition.on("will-download", (event) => event.preventDefault());
  const current = targets;
  // A session is shared by one agent's tabs. Route each request through its
  // own contents policy; registering another tab must not replace that policy.
  partition.webRequest.onBeforeRequest((details, callback) => {
    const target = current.get(details.webContentsId ?? -1);
    if (
      !target ||
      !isLocalPreviewRequest(
        details.url,
        target.origin,
        target.hostOrigin(),
        details.resourceType,
      )
    ) {
      callback({ cancel: true });
      return;
    }
    void target.verifyHost().then(
      () => callback({ cancel: false }),
      () => callback({ cancel: true }),
    );
  });
  return targets;
}

export function createProjectBrowser(
  window: BrowserWindow,
  initialURL: string,
  hostOrigin: () => string | undefined,
  changed?: () => void,
  options: { partitionKey?: string } = {},
) {
  const initial = experimentURL(initialURL, hostOrigin());
  const partition = session.fromPartition(
    options.partitionKey
      ? `persist:crew-agent-browser-${createHash("sha256").update(options.partitionKey).digest("hex")}`
      : `crew-browser-experiment-${randomUUID()}`,
  );
  const targets = targetsFor(partition);
  let view: WebContentsView | undefined;
  let cdp: Awaited<ReturnType<typeof createBrowserCdp>> | undefined;
  let connected = false,
    error: string | undefined,
    opening: Promise<void> | undefined;
  let endpoint: string | undefined;
  let closing: Promise<void> | undefined;
  const allowed = (value: string) => {
    try {
      const url = experimentURL(value, hostOrigin());
      return url.origin === initial.origin;
    } catch {
      return false;
    }
  };
  // Restrict the whole preview session, including redirects and subresources.
  const verifyHost = () =>
    requireLoopbackResolution(initial.hostname, (name) =>
      partition.resolveHost(name, {
        source: "system",
        cacheUsage: "disallowed",
        secureDnsPolicy: "disable",
      }),
    );
  const state = () => {
    const contents = view?.webContents;
    return {
      open: Boolean(contents && !contents.isDestroyed()),
      url:
        contents && !contents.isDestroyed() ? contents.getURL() : initial.href,
      title:
        contents && !contents.isDestroyed()
          ? contents.getTitle()
          : "Project browser",
      loading:
        contents && !contents.isDestroyed() ? contents.isLoading() : false,
      canGoBack:
        contents && !contents.isDestroyed()
          ? contents.navigationHistory.canGoBack()
          : false,
      canGoForward:
        contents && !contents.isDestroyed()
          ? contents.navigationHistory.canGoForward()
          : false,
      error,
      automation: connected
        ? "Independent MCP client connected"
        : "Independent MCP client disconnected",
    };
  };
  const publish = () => {
    if (!options.partitionKey && !window.isDestroyed())
      window.webContents.send("crew:browser:state", state());
    changed?.();
  };
  async function open() {
    if (closing) await closing;
    if (view) return;
    error = undefined;
    // Local previews must never be sent through an inherited remote proxy.
    // Preserve the selected URL/Host; no redirects or hostname rewrites.
    await partition.setProxy({ mode: "direct" });
    await verifyHost();
    const next = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        session: partition,
        navigateOnDragDrop: false,
      },
    });
    view = next;
    next.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
    next.setVisible(false);
    window.contentView.addChildView(next);
    const contents = next.webContents;
    targets.set(contents.id, {
      origin: initial.origin,
      hostOrigin,
      verifyHost,
    });
    contents.once("destroyed", () => targets.delete(contents.id));
    contents.setBackgroundThrottling(false);
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("will-navigate", (event, url) => {
      if (!allowed(url)) {
        event.preventDefault();
        error =
          "Navigation outside the configured preview origin is unavailable.";
        publish();
      }
    });
    contents.on("will-redirect", (event, url) => {
      if (!allowed(url)) event.preventDefault();
    });
    contents.on("did-start-loading", publish);
    contents.on("did-stop-loading", publish);
    contents.on("did-navigate", publish);
    contents.on("did-navigate-in-page", publish);
    contents.on("page-title-updated", publish);
    contents.on("render-process-gone", () => {
      error =
        "Preview renderer stopped. Close and reopen the browser to reconnect.";
      publish();
    });
    contents.on(
      "did-fail-load",
      (_event, code, description, _url, mainFrame) => {
        if (mainFrame && code !== -3) {
          error = `Preview could not load: ${description}`;
          publish();
        }
      },
    );
    try {
      cdp = await createBrowserCdp(contents, (value) => {
        connected = value;
        publish();
      });
      endpoint = cdp.endpoint;
      // Do not hold Close behind a slow/unresponsive preview navigation.
      void contents.loadURL(initial.href).catch((cause: unknown) => {
        if (view !== next) return;
        error = cause instanceof Error ? cause.message : String(cause);
        publish();
      });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    publish();
  }
  async function close() {
    if (opening) await opening;
    if (closing) return closing;
    closing = (async () => {
      await cdp?.close();
      cdp = undefined;
      endpoint = undefined;
      connected = false;
      if (view) {
        const prior = view;
        view = undefined;
        targets.delete(prior.webContents.id);
        if (!window.isDestroyed()) window.contentView.removeChildView(prior);
        if (!prior.webContents.isDestroyed()) prior.webContents.close();
      }
      publish();
    })();
    try {
      await closing;
    } finally {
      closing = undefined;
    }
  }
  window.once("closed", () => {
    void close();
  });
  return {
    contents: () => view?.webContents,
    state,
    endpoint: () => endpoint,
    close,
    async request(input: unknown) {
      const value = record(input, "Browser request");
      if (value.action === "state") return state();
      if (value.action === "open") {
        if (!opening) opening = open();
        try {
          await opening;
        } finally {
          opening = undefined;
        }
      } else if (value.action === "close") await close();
      else {
        const contents = view?.webContents;
        // A final ResizeObserver message may race the explicit Close response.
        if (value.action === "bounds" && !contents) return state();
        if (!contents || contents.isDestroyed())
          throw Error("Open the project browser first.");
        if (value.action === "bounds") {
          const b = record(value.bounds, "Browser bounds");
          if (
            ![b.x, b.y, b.width, b.height].every(
              (n) =>
                typeof n === "number" &&
                Number.isSafeInteger(n) &&
                n >= 0 &&
                n <= 20000,
            )
          )
            throw Error("Invalid browser bounds.");
          const [width, height] = window.getContentSize();
          if (value.visible === false || b.width === 0 || b.height === 0) {
            view?.setVisible(false);
            return state();
          }
          const x = Math.min(b.x as number, width),
            y = Math.min(b.y as number, height);
          view?.setBounds({
            x,
            y,
            width: Math.min(b.width as number, width - x),
            height: Math.min(b.height as number, height - y),
          });
          view?.setVisible(true);
        } else if (value.action === "navigate") {
          if (
            typeof value.url !== "string" ||
            value.url.length > 8192 ||
            !allowed(value.url)
          )
            throw Error("Use a URL on the configured local preview origin.");
          error = undefined;
          try {
            await contents.loadURL(value.url);
          } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause);
          }
        } else if (value.action === "back") {
          error = undefined;
          if (contents.navigationHistory.canGoBack())
            contents.navigationHistory.goBack();
        } else if (value.action === "forward") {
          error = undefined;
          if (contents.navigationHistory.canGoForward())
            contents.navigationHistory.goForward();
        } else if (value.action === "reload") {
          error = undefined;
          contents.reload();
        } else throw Error("Unknown browser request.");
      }
      publish();
      return state();
    },
  };
}
