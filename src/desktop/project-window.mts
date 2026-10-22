import { BrowserWindow, Menu, session } from "electron";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { isAppURL, permitsAudio } from "./lifecycle.mjs";
import { webLink } from "../shared/web-links.mjs";
import { openWebLink } from "./external-links.mjs";
import { projectWindowChrome } from "./window-chrome.mjs";
import { createProjectBrowser } from "./project-browser.mjs";

/** Owns one disposable renderer and its project partition. Controller ownership
 * and process lifecycle stay with the project host; closing only releases voice. */
export function createProjectWindow({
  root,
  desktopData,
  key,
  configPath,
  isSelected,
  ready,
  projectName,
  getOrigin,
  getError,
  isQuitting,
  disconnect,
  openSetup,
  statusChanged,
  safe,
}: {
  root: string;
  desktopData: string;
  key: string;
  configPath: string;
  isSelected: () => boolean;
  ready: () => boolean;
  projectName: () => string | undefined;
  getOrigin: () => string | undefined;
  getError: () => string | null;
  isQuitting: () => boolean;
  disconnect: () => Promise<unknown>;
  openSetup: () => Promise<void>;
  statusChanged: () => Promise<void>;
  safe: (error: unknown) => string;
}) {
  mkdirSync(join(desktopData, "Partitions", `instance-${key}`), {
    recursive: true,
    mode: 0o700,
  });
  let window: BrowserWindow | undefined,
    closing = false;
  let browser: ReturnType<typeof createProjectBrowser> | undefined;
  const escape = (text: unknown) =>
    String(text).replace(
      /[&<>"']/g,
      (char) =>
        new Map([
          ["&", "&amp;"],
          ["<", "&lt;"],
          [">", "&gt;"],
          ['"', "&quot;"],
          ["'", "&#39;"],
        ]).get(char) || char,
    );
  async function openWindow() {
    if (!isSelected()) return;
    if (!ready()) return openSetup();
    if (window && !window.isDestroyed()) {
      window.show();
      window.focus();
      return;
    }
    const next = new BrowserWindow({
      ...projectWindowChrome(),
      width: 1050,
      height: 850,
      minWidth: 540,
      minHeight: 500,
      title: `${projectName() || "Setup"} — Crew`,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        preload: join(root, "desktop/workspace-preload.cjs"),
        additionalArguments: process.env.CREW_BROWSER_EXPERIMENT_URL ? ["--crew-browser-experiment"] : [],
        session: session.fromPath(
          join(desktopData, "Partitions", `instance-${key}`),
        ),
      },
    });
    window = next;
    if (process.env.CREW_BROWSER_EXPERIMENT_URL)
      browser = createProjectBrowser(next, process.env.CREW_BROWSER_EXPERIMENT_URL, getOrigin);
    next.webContents.setWindowOpenHandler((details) => {
      // Only the trusted project UI may send a validated web link to the external browser.
      if (
        getOrigin() &&
        isAppURL(next.webContents.getURL(), getOrigin()) &&
        webLink(details.url)
      )
        void openWebLink(details.url).catch((error) =>
          console.error(safe(error)),
        );
      return { action: "deny" };
    });
    next.webContents.on("will-navigate", (event, url) => {
      if (!getOrigin() || !isAppURL(url, getOrigin())) {
        event.preventDefault();
        if (isAppURL(next.webContents.getURL(), getOrigin()) && webLink(url))
          void openWebLink(url).catch((error) => console.error(safe(error)));
      }
    });
    // Chromium in Electron supplies no default edit context menu. Keep native
    // editing roles so undo/cut/paste/shortcuts target the focused field normally.
    next.webContents.on("context-menu", (_event, params) => {
      if (
        !isAppURL(next.webContents.getURL(), getOrigin()) ||
        !params.isEditable
      )
        return;
      Menu.buildFromTemplate([
        { role: "undo", enabled: params.editFlags.canUndo },
        { role: "redo", enabled: params.editFlags.canRedo },
        { type: "separator" },
        { role: "cut", enabled: params.editFlags.canCut },
        { role: "copy", enabled: params.editFlags.canCopy },
        { role: "paste", enabled: params.editFlags.canPaste },
        { role: "selectAll", enabled: params.editFlags.canSelectAll },
      ]).popup({ window: next });
    });
    next.webContents.on("will-attach-webview", (event) =>
      event.preventDefault(),
    );
    next.on("close", (event) => {
      if (isQuitting() || closing) return;
      event.preventDefault();
      closing = true;
      void (async () => {
        // Stop server voice before destroying Chromium, which releases mic tracks/SSE.
        if (ready()) await disconnect().catch(() => {});
        if (!next.isDestroyed()) next.destroy();
        if (window === next) window = undefined;
        closing = false;
        await statusChanged().catch(() => {});
      })();
    });
    next.on("closed", () => {
      if (window === next) window = undefined;
      void statusChanged().catch(() => {});
    });
    if (ready()) await next.loadURL(getOrigin() || "");
    else
      await next.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>Crew setup</title><style>body{font:17px system-ui;max-width:760px;margin:72px auto;padding:24px;line-height:1.6;background:#f7f8fc;color:#182033}code{overflow-wrap:anywhere}</style><h1>${getError() ? "Setup needs attention" : "Starting Crew"}</h1><p>${escape(getError() || "Starting the local controller. Microphone is off.")}</p><p>Configuration: <code>${escape(configPath)}</code></p><p>Use the menu-bar icon to edit configuration, open logs, or retry startup. Each workspace handles one project. No work starts automatically.</p>`)}`,
      );
    next.show();
    await statusChanged().catch(() => {});
  }
  return {
    browserRequest(input: unknown) {
      if (!browser) throw Error("Browser experiment is unavailable.");
      return browser.request(input);
    },
    browserEndpoint: () => browser?.endpoint(),
    open: openWindow,
    configurePermissions() {
      const partition = session.fromPath(
        join(desktopData, "Partitions", `instance-${key}`),
      );
      partition.setPermissionRequestHandler(
        (contents, permission, callback, details) =>
          callback(
            contents === window?.webContents &&
              permitsAudio(permission, details, getOrigin()),
          ),
      );
      partition.setPermissionCheckHandler(
        (contents, permission, requestingOrigin, details) =>
          contents === window?.webContents &&
          permitsAudio(
            permission,
            { ...details, securityOrigin: requestingOrigin },
            getOrigin(),
          ),
      );
      partition.on("will-download", (event) => event.preventDefault());
    },
    isOpen: () => Boolean(window && !window.isDestroyed()),
    busy: () => closing,
    accepts(event: Electron.IpcMainInvokeEvent) {
      return Boolean(
        window &&
        event.sender === window.webContents &&
        event.senderFrame === window.webContents.mainFrame &&
        isAppURL(event.senderFrame?.url || "", getOrigin()),
      );
    },
    async reload() {
      if (window && !window.isDestroyed())
        await window.loadURL(getOrigin() || "");
    },
    notify(value: unknown) {
      if (window && !window.isDestroyed())
        window.webContents.send("crew:workspaces:changed", value);
    },
    destroy() {
      if (window && !window.isDestroyed()) window.destroy();
      window = undefined;
    },
    hide() {
      if (window && !window.isDestroyed()) {
        closing = true;
        window.destroy();
        window = undefined;
        closing = false;
      }
    },
  };
}
