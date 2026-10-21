import { clipboardText } from "./clipboard.mjs";
import { record, string } from "./validation.mjs";
import type { createProjectHost } from "./project-host.mjs";

type RequestHost = Pick<
  ReturnType<typeof createProjectHost>,
  "acceptsSetup" | "acceptsWorkspace" | "handleSetup"
>;
interface WorkspaceRequestContext<Snapshot> {
  selected(): RequestHost;
  snapshot(): Snapshot;
  assertSetupAllowed(): void;
  select(id: string): Promise<unknown>;
  add(): Promise<Snapshot>;
  rename(id: string, name: string): Promise<unknown>;
  configureCapacity(limit: number): Promise<unknown>;
  setWorkerLimit(limit: number): Promise<unknown>;
  changed(): void;
  writeClipboard(text: string): void;
}
/** Native surface identity and unknown IPC payload checks precede all mutations.
 * The app owner supplies lifecycle operations; these handlers never run workers. */
export function createWorkspaceRequests<Snapshot>(
  context: WorkspaceRequestContext<Snapshot>,
) {
  return {
    setup(event: Electron.IpcMainInvokeEvent, action: unknown, input: unknown) {
      if (typeof action !== "string") throw Error("Invalid setup request.");
      const host = context.selected();
      if (!host.acceptsSetup(event.sender))
        throw Error("Setup request rejected.");
      return host.handleSetup(event, action, input);
    },
    clipboard(event: Electron.IpcMainInvokeEvent, text: unknown) {
      if (!context.selected().acceptsWorkspace(event))
        throw Error("Clipboard request rejected.");
      context.writeClipboard(clipboardText(text));
    },
    async workspaces(
      event: Electron.IpcMainInvokeEvent,
      action: unknown,
      input: unknown,
    ): Promise<Snapshot> {
      if (!context.selected().acceptsWorkspace(event))
        throw Error("Workspace request rejected.");
      if (action === "snapshot") return context.snapshot();
      if (action === "select") {
        await context.select(string(input, "Project identity"));
        return context.snapshot();
      }
      context.assertSetupAllowed();
      if (action === "add") return context.add();
      if (action === "rename") {
        const value = record(input);
        await context.rename(
          string(value.id, "Project identity"),
          string(value.name, "Project name"),
        );
        context.changed();
        return context.snapshot();
      }
      if (action === "capacity") {
        const limit = typeof input === "number" ? input : NaN;
        await context.configureCapacity(limit);
        await context.setWorkerLimit(limit);
        context.changed();
        return context.snapshot();
      }
      throw Error("Unknown workspace action.");
    },
  };
}
