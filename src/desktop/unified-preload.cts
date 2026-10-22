const {
  contextBridge,
  ipcRenderer,
}: typeof import("electron") = require("electron");
export {};

const allowed = new Set([
  "snapshot",
  "chooseProjectDirectory",
  "createProject",
  "selectProject",
  "renameProject",
  "ownerSnapshot",
  "ownerCommand",
  "prepareQuit",
  "cancelQuit",
  "quit",
  "copyText",
  "openWebLink",
  "updates",
  "browser",
]);
contextBridge.exposeInMainWorld(
  "crewDesktop",
  Object.freeze({
    integratedTitlebar: process.platform === "darwin",
    async request(method: unknown, value?: unknown) {
      if (typeof method !== "string" || !allowed.has(method))
        throw new TypeError("Unsupported Crew desktop action.");
      const serialized = JSON.stringify(value ?? null);
      if (serialized.length > 2_000_000)
        throw new TypeError("The request is too large.");
      let result: {
        ok: boolean;
        value?: unknown;
        error?: { code: string; message: string };
      };
      try {
        result = await ipcRenderer.invoke(
          "crew:unified",
          method,
          value ?? null,
        );
      } catch {
        // Native/OS/provider failures can include credential or filesystem details.
        throw new Error(
          "Crew could not complete this action. Your saved state has been retained.",
        );
      }
      if (result?.ok === true) return result.value;
      const error = new Error(
        result?.error?.message ?? "Crew could not complete this action.",
      );
      Object.assign(error, { code: result?.error?.code ?? "failed" });
      throw error;
    },
    subscribe(listener: (event: unknown) => void) {
      if (typeof listener !== "function")
        throw new TypeError("A listener is required.");
      const receive = (_event: Electron.IpcRendererEvent, value: unknown) =>
        listener(value);
      ipcRenderer.on("crew:unified:event", receive);
      return () => ipcRenderer.removeListener("crew:unified:event", receive);
    },
  }),
);
// Existing pure Crew message/header components use this bounded presentation
// capability. It carries no controller, filesystem or clipboard-read authority.
contextBridge.exposeInMainWorld(
  "crewWindow",
  Object.freeze({
    integratedTitlebar: process.platform === "darwin",
    copyText: async (text: unknown) => {
      if (typeof text !== "string" || text.length > 1_000_000)
        throw new TypeError("Clipboard text is too large.");
      const result = await ipcRenderer.invoke("crew:unified", "copyText", text);
      if (result?.ok !== true) throw new Error("The text could not be copied.");
    },
  }),
);
