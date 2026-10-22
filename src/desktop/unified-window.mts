import { BrowserWindow, Menu, session } from "electron";
import { join } from "node:path";
import { projectWindowChrome } from "./window-chrome.mjs";
import { isAppURL, permitsAudio } from "./lifecycle.mjs";
import { webLink } from "../shared/web-links.mjs";
import { openWebLink } from "./external-links.mjs";

/** The window owns only presentation and media. Closing it leaves the unified
 * production services and native agents running under the menu-bar host. */
export function createUnifiedWindow(options: {
  root: string;
  desktopDirectory: string;
  origin: string;
  isQuitting(): boolean;
  disconnectVoice(): Promise<void>;
  closed(): void;
}) {
  const partition = session.fromPath(join(options.desktopDirectory, "window"));
  let window: BrowserWindow | undefined;
  let closing: Promise<void> | null = null;
  const accepts = (event: Electron.IpcMainInvokeEvent) =>
    Boolean(
      window &&
      !window.isDestroyed() &&
      event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame &&
      isAppURL(event.senderFrame?.url ?? "", options.origin),
    );
  partition.setPermissionRequestHandler(
    (contents, permission, callback, details) => {
      callback(
        contents === window?.webContents &&
          permitsAudio(permission, details, options.origin),
      );
    },
  );
  partition.setPermissionCheckHandler(
    (contents, permission, requestingOrigin, details) =>
      contents === window?.webContents &&
      permitsAudio(
        permission,
        { ...details, securityOrigin: requestingOrigin },
        options.origin,
      ),
  );
  partition.on("will-download", (event) => event.preventDefault());

  async function closeSurface() {
    if (closing) return closing;
    closing = (async () => {
      const current = window;
      // Even when provider disconnect is unavailable, destroying Chromium releases
      // all local microphone tracks and transport objects.
      try {
        await options.disconnectVoice();
      } finally {
        if (current && !current.isDestroyed()) current.destroy();
        if (window === current) window = undefined;
        options.closed();
      }
    })().finally(() => {
      closing = null;
    });
    return closing;
  }
  return {
    accepts,
    partition,
    async open() {
      if (closing) await closing.catch(() => {});
      if (window && !window.isDestroyed()) {
        window.show();
        window.focus();
        return;
      }
      const current = new BrowserWindow({
        ...projectWindowChrome(),
        width: 1120,
        height: 850,
        minWidth: 390,
        minHeight: 500,
        title: "Crew",
        show: false,
        webPreferences: {
          preload: join(options.root, "desktop/unified-preload.cjs"),
          session: partition,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
        },
      });
      window = current;
      current.webContents.setWindowOpenHandler(({ url }) => {
        if (
          isAppURL(current.webContents.getURL(), options.origin) &&
          webLink(url)
        )
          void openWebLink(url).catch(() => {});
        return { action: "deny" };
      });
      current.webContents.on("will-navigate", (event, url) => {
        if (!isAppURL(url, options.origin)) {
          event.preventDefault();
          if (
            isAppURL(current.webContents.getURL(), options.origin) &&
            webLink(url)
          )
            void openWebLink(url).catch(() => {});
        }
      });
      current.webContents.on("will-attach-webview", (event) =>
        event.preventDefault(),
      );
      current.webContents.on("context-menu", (_event, params) => {
        if (!isAppURL(current.webContents.getURL(), options.origin)) return;
        const template: Electron.MenuItemConstructorOptions[] =
          params.isEditable
            ? [
                { role: "undo" },
                { role: "redo" },
                { type: "separator" },
                { role: "cut", enabled: params.editFlags.canCut },
                { role: "copy", enabled: params.editFlags.canCopy },
                { role: "paste", enabled: params.editFlags.canPaste },
                { role: "selectAll" },
              ]
            : [
                { role: "copy", enabled: Boolean(params.selectionText) },
                { role: "selectAll" },
              ];
        Menu.buildFromTemplate(template).popup({ window: current });
      });
      current.on("close", (event) => {
        if (options.isQuitting()) return;
        event.preventDefault();
        void closeSurface().catch(() => {});
      });
      current.on("closed", () => {
        if (window === current) window = undefined;
      });
      await current.loadURL(options.origin);
      current.show();
    },
    notify(event: unknown) {
      if (window && !window.isDestroyed())
        window.webContents.send("crew:unified:event", event);
    },
    close: closeSurface,
    destroy() {
      if (window && !window.isDestroyed()) window.destroy();
      window = undefined;
    },
    native: () => window,
  };
}
