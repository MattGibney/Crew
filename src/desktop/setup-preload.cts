const {
  contextBridge,
  ipcRenderer,
}: typeof import("electron") = require("electron");
export {};
const call = async (action: string, value?: unknown): Promise<unknown> => {
  try {
    return await ipcRenderer.invoke("crew:setup", action, value);
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
  "crewSetup",
  Object.freeze({
    storageRetry: () => call("storage-retry"),
    storageUse: (index: number) => call("storage-use", index),
    storageFolder: () => call("storage-folder"),
    snapshot: () => call("snapshot"),
    initialize: () => call("initialize"),
    runtime: () => call("runtime"),
    account: () => call("account"),
    login: () => call("login"),
    save: (value: unknown) => call("save", value),
    paths: () => call("paths"),
    chooseDiscovery: () => call("choose-discovery"),
    discover: () => call("discover"),
    cancelDiscovery: () => call("cancel-discovery"),
    linearOptions: (teamId: string | null) => call("linear-options", teamId),
    repositoryOptions: (path: string) => call("repository-options", path),
    chooseRepository: () => call("choose-repository"),
    chooseCodex: () => call("choose-codex"),
    microphone: () => call("microphone"),
    settings: (name: string) => call("settings", name),
    openConfig: () => call("open-config"),
    openPrompts: () => call("open-prompts"),
    launch: () => call("launch"),
    help: () => call("help"),
  }),
);
