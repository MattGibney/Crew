import { BrowserWindow } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The setup page has its own sandboxed partition and no media/download/webview
 * permissions. Its exact main frame is the only privileged setup IPC sender. */
export function createProjectSetupWindow({
  root,
  key,
  isSelected,
  onClosed,
}: {
  root: string;
  key: string;
  isSelected: () => boolean;
  onClosed: () => void;
}) {
  const url = pathToFileURL(join(root, "renderer-dist/setup.html")).href;
  let window: BrowserWindow | undefined;
  return {
    current: () => window,
    acceptsSender: (sender: Electron.WebContents) =>
      Boolean(window && sender === window.webContents),
    accepts(event: Electron.IpcMainInvokeEvent): boolean {
      return Boolean(
        window &&
        event.sender === window.webContents &&
        event.senderFrame === window.webContents.mainFrame &&
        (event.senderFrame?.url || "") === url,
      );
    },
    async open(): Promise<void> {
      if (!isSelected()) return;
      if (window && !window.isDestroyed()) {
        window.show();
        window.focus();
        return;
      }
      const next = new BrowserWindow({
        width: 1000,
        height: 850,
        minWidth: 560,
        minHeight: 550,
        title: "Set up Crew",
        show: false,
        webPreferences: {
          preload: join(root, "desktop/setup-preload.cjs"),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          partition: `setup-${key}`,
        },
      });
      window = next;
      next.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      next.webContents.on("will-navigate", (event, target) => {
        if (target !== url) event.preventDefault();
      });
      next.webContents.on("will-attach-webview", (event) =>
        event.preventDefault(),
      );
      next.webContents.session.setPermissionRequestHandler(
        (_contents, _permission, callback) => callback(false),
      );
      next.webContents.session.setPermissionCheckHandler(() => false);
      next.webContents.session.on("will-download", (event) =>
        event.preventDefault(),
      );
      next.on("closed", () => {
        onClosed();
        if (window === next) window = undefined;
      });
      await next.loadURL(url);
      next.show();
    },
    destroy() {
      if (window && !window.isDestroyed()) window.destroy();
    },
  };
}
