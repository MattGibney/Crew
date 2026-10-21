import { Tray, Menu, nativeImage, shell } from "electron";
import { dirname } from "node:path";
import type { createProjectHost } from "./project-host.mjs";
import type { UpdateStatus, PausePlan } from "./update-contracts.mjs";
interface TrayProject {
  id: string;
  name: string;
  pending: number | null;
  active: number | null;
  ready: boolean;
  error: string | null;
}
interface WorkspaceTrayContext {
  snapshot(): { selectedId: string | null; projects: TrayProject[] };
  selected(): ReturnType<typeof createProjectHost>;
  attempt(operation: () => unknown): void;
  selectProject(id: string): Promise<unknown>;
  addProject(): Promise<unknown>;
  resolveUpdateRecovery(): Promise<unknown>;
  quitCrew(): Promise<unknown>;
  readonly updateStatus: UpdateStatus | undefined;
  readonly updateRecoveryError: string | undefined;
  readonly pausePlan: PausePlan | null;
  readonly updateHolding: boolean;
  requestUpdate(action: string): Promise<unknown>;
}
function trayIcon(pending: number | boolean) {
  const width = 22,
    height = 22,
    pixels = Buffer.alloc(width * height * 4);
  const paint = (x: number, y: number) => {
    pixels[(y * width + x) * 4 + 3] = 255;
  };
  for (let y = 3; y < 15; y++) for (let x = 6; x < 16; x++) paint(x, y);
  for (let y = 15; y < 19; y++) for (let x = 9; x < 13; x++) paint(x, y);
  if (pending)
    for (let y = 0; y < 7; y++)
      for (let x = 15; x < 22; x++)
        if ((x - 18) ** 2 + (y - 3) ** 2 <= 9) paint(x, y);
  const icon = nativeImage.createFromBitmap(pixels, {
    width,
    height,
    scaleFactor: 1,
  });
  icon.setTemplateImage(true);
  return icon;
}
/** The menu bar observes project state and dispatches explicit parent actions. */
export function createWorkspaceTray(context: WorkspaceTrayContext) {
  const {
    snapshot,
    selected,
    attempt,
    selectProject,
    addProject,
    resolveUpdateRecovery,
    quitCrew,
  } = context;
  const tray = new Tray(trayIcon(false));
  function refresh() {
    const updater = context.updateStatus;
    const updateRecoveryError = context.updateRecoveryError;
    const view = snapshot(),
      pending = view.projects.reduce((sum, p) => sum + (p.pending || 0), 0);
    tray.setImage(trayIcon(pending));
    tray.setTitle(pending ? `✋ ${pending}` : "");
    tray.setToolTip(
      `Crew — ${pending} pending attention item${pending === 1 ? "" : "s"}`,
    );
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: "Open Crew",
          click: () => attempt(() => selected().openWindow()),
        },
        {
          label: pending
            ? "Projects needing attention"
            : "No pending attention",
          enabled: false,
        },
        ...view.projects
          .filter((p) => p.pending || p.error)
          .map((p) => ({
            label: `${p.name} — ${p.pending ? `${p.pending} need attention` : "Needs setup"}`,
            click: () => attempt(() => selectProject(p.id)),
          })),
        { type: "separator" },
        ...view.projects.map((p) => ({
          label: p.name,
          type: "radio",
          checked: p.id === view.selectedId,
          click: () => attempt(() => selectProject(p.id)),
        })),
        { label: "Add project…", click: () => attempt(addProject) },
        {
          label: "Project setup…",
          click: () => attempt(() => selected().openSetup()),
        },
        {
          label: "Edit project configuration…",
          click: () => attempt(() => shell.openPath(selected().configPath)),
        },
        {
          label: "Open configuration folder",
          click: () =>
            attempt(() => shell.openPath(dirname(selected().configPath))),
        },
        {
          label: "Open logs folder",
          enabled: Boolean(selected()?.logsDirectory()),
          click: () =>
            attempt(() =>
              shell.openPath(
                selected().logsDirectory() || dirname(selected().configPath),
              ),
            ),
        },
        {
          label: "Retry project startup",
          enabled: !selected()?.snapshot().ready && !selected()?.busy(),
          click: () => attempt(() => selected().startup()),
        },
        { type: "separator" },
        {
          label: "Check for updates…",
          enabled: Boolean(updater),
          click: () => attempt(() => context.requestUpdate("check")),
        },
        {
          label: "Download update",
          enabled: updater?.phase === "available",
          click: () => attempt(() => context.requestUpdate("download")),
        },
        {
          label: "Resolve interrupted update…",
          visible: Boolean(updateRecoveryError),
          click: () => attempt(resolveUpdateRecovery),
        },
        {
          label: "Restart to update…",
          enabled: updater?.phase === "downloaded",
          click: () => attempt(() => context.requestUpdate("restart")),
        },
        {
          label: "Pause all projects and update…",
          enabled: updater?.phase === "downloaded" && !context.updateHolding,
          click: () => attempt(() => context.requestUpdate("pause-update")),
        },
        {
          label: "Cancel pause and update",
          enabled: ["draining", "ready", "blocked"].includes(
            context.pausePlan?.phase || "",
          ),
          click: () =>
            attempt(() => context.requestUpdate("cancel-pause-update")),
        },
        {
          label: "Resume paused work",
          enabled: ["canceled", "blocked"].includes(
            context.pausePlan?.phase || "",
          ),
          click: () =>
            attempt(() => context.requestUpdate("resume-paused-work")),
        },
        {
          label: "Return to work",
          enabled: ["canceled", "blocked"].includes(
            context.pausePlan?.phase || "",
          ),
          click: () => attempt(() => context.requestUpdate("return-to-work")),
        },
        { type: "separator" },
        { label: "Quit Crew…", click: () => attempt(quitCrew) },
      ]),
    );
  }
  return { refresh, destroy: () => tray.destroy() };
}
