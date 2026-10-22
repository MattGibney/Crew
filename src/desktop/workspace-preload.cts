const {
  contextBridge,
  ipcRenderer,
}: typeof import("electron") = require("electron");
export {};
if (process.argv.includes("--crew-browser-experiment"))
  contextBridge.exposeInMainWorld(
    "crewBrowser",
    Object.freeze({
      request: async (input: unknown) => {
        try {
          return await ipcRenderer.invoke("crew:browser", input);
        } catch (error) {
          throw new Error(
            String(error instanceof Error ? error.message : error).replace(
              /^Error invoking remote method '[^']+': Error: /,
              "",
            ),
          );
        }
      },
      onState: (listener: (state: unknown) => void) => {
        if (typeof listener !== "function")
          throw TypeError("A browser listener is required.");
        const changed = (_event: Electron.IpcRendererEvent, state: unknown) =>
          listener(state);
        ipcRenderer.on("crew:browser:state", changed);
        return () => ipcRenderer.removeListener("crew:browser:state", changed);
      },
    }),
  );
contextBridge.exposeInMainWorld(
  "crewWindow",
  Object.freeze({
    integratedTitlebar: process.platform === "darwin",
    copyText: (text: unknown) => {
      if (typeof text !== "string" || text.length > 1000000)
        throw new TypeError(
          "Clipboard text must be a string of at most 1,000,000 characters.",
        );
      return ipcRenderer.invoke("crew:clipboard-write", text);
    },
  }),
);
const id = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim() || value.length > 200)
    throw new TypeError("A valid project identity is required.");
  return value;
};
const call = async (action: string, value?: unknown): Promise<unknown> => {
  try {
    return await ipcRenderer.invoke("crew:workspaces", action, value);
  } catch (error) {
    throw new Error(
      String(error instanceof Error ? error.message : error).replace(
        /^Error invoking remote method '[^']+': Error: /,
        "",
      ),
    );
  }
};
contextBridge.exposeInMainWorld(
  "crewWorkspaces",
  Object.freeze({
    snapshot: () => call("snapshot"),
    select: (value: unknown) => call("select", id(value)),
    add: () => call("add"),
    rename: (value: unknown) => {
      if (
        !value ||
        typeof value !== "object" ||
        !("name" in value) ||
        !("id" in value) ||
        typeof value.name !== "string" ||
        !value.name.trim() ||
        value.name.trim().length > 100
      )
        throw new TypeError("Use a project name between 1 and 100 characters.");
      return call("rename", { id: id(value.id), name: value.name.trim() });
    },
    setWorkerLimit: (value: unknown) => {
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 1 ||
        value > 64
      )
        throw new TypeError("Choose a worker limit between 1 and 64.");
      return call("capacity", value);
    },
    subscribe: (listener: (snapshot: unknown) => void) => {
      if (typeof listener !== "function")
        throw new TypeError("A change listener is required.");
      const changed = (_event: Electron.IpcRendererEvent, snapshot: unknown) =>
        listener(snapshot);
      ipcRenderer.on("crew:workspaces:changed", changed);
      return () =>
        ipcRenderer.removeListener("crew:workspaces:changed", changed);
    },
  }),
);
