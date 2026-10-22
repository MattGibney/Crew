import { createWorkspaceRequests } from "./workspace-requests.mjs";
import {
  createApplicationUpdates,
  type DesktopUpdater,
} from "./application-updates.mjs";
import { createWorkspaceTray } from "./workspace-tray.mjs";
// Issue #2: one native identity, one selected surface, isolated project controllers.
import { app, Menu, dialog, ipcMain, clipboard } from "electron";
import { mkdir, readFile, writeFile, access, realpath } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { prepareCrewStorage } from "./storage.mjs";
import { instanceKey, childEnvironment } from "./lifecycle.mjs";
import { createProjectHost } from "./project-host.mjs";
import type { createWorkspaceUpdateReservation } from "./workspace-update.mjs";
import { assertWorkspaceIsolation } from "./workspace-isolation.mjs";
import { openWorkspaceRegistry } from "./workspace-registry.mjs";
import { configureGlobalCapacity } from "../orchestration/capacity.mjs";
import { loadAppConfig } from "../config/index.mjs";
import type { createWorkspacePauseUpdate } from "./workspace-pause-update.mjs";
import {
  createNativeUpdateGate,
  createInstallLease,
  createRestartHandoff,
} from "./updater.mjs";
import { errorCode, errorMessage, record } from "./validation.mjs";
import { parseConfig } from "../config/shape.mjs";
import type { WorkspaceProject } from "./workspace-registry.mjs";
import type {
  IsolationCandidate,
  IsolationProject,
} from "./workspace-isolation.mjs";

type ProjectHost = ReturnType<typeof createProjectHost>;
type Registry = Awaited<ReturnType<typeof openWorkspaceRegistry>>;
const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(app.isPackaged ? 1 : 2),
  flag = args.indexOf("--config");
if (flag >= 0 && (!args[flag + 1] || args[flag + 1].startsWith("--")))
  throw Error("--config requires a config path.");
// Isolated acceptance/portable profiles opt in explicitly; no user files are copied.
const appData = process.env.CREW_APP_DATA || app.getPath("appData");
const crewRoot = join(appData, "Crew"),
  updatesDirectory = join(crewRoot, "updates");
const restartHandoff = createRestartHandoff({ directory: updatesDirectory });
const explicit =
  args[flag + 1] && flag >= 0
    ? args[flag + 1]
    : process.env.AI_MANAGER_CONFIG || null;
const restarted = await restartHandoff.consume(app.getVersion(), explicit);
const storage = await prepareCrewStorage({
  appData,
  configOverride: explicit || restarted,
});
// The common private root also lets Chromium's network sandbox access each
// explicitly retained project partition beneath desktop/<identity>.
const nativeData = crewRoot;
await mkdir(nativeData, { recursive: true, mode: 0o700 });
app.setPath("userData", nativeData);
app.setPath("sessionData", nativeData);
app.setName("Crew");
const locked = app.requestSingleInstanceLock({
  configPath: explicit || restarted ? storage.configPath : null,
});
let registry: Registry,
  tray: ReturnType<typeof createWorkspaceTray> | undefined,
  updater: DesktopUpdater,
  quitPreparation: Awaited<
    ReturnType<typeof createApplicationUpdates>
  >["quitPreparation"],
  workspacePause: ReturnType<typeof createWorkspacePauseUpdate>,
  quitting = false,
  transition = false,
  changedTimer: NodeJS.Timeout | undefined;
const hosts = new Map<string, ProjectHost>(),
  capacityDirectory = join(crewRoot, "capacity");
const safe = (error: unknown) =>
  errorMessage(error)
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/sk-[\w-]+/g, "[redacted]")
    .slice(0, 1400);
const requiredHost = (id: string): ProjectHost => {
  const host = hosts.get(id);
  if (!host) throw new Error("Project controller is unavailable.");
  return host;
};
const selected = (): ProjectHost =>
  requiredHost(registry.snapshot().selectedId || "");
const nativeGate = createNativeUpdateGate({
  busy: () =>
    Boolean(
      transition || quitting || [...hosts.values()].some((h) => h.busy()),
    ),
});
const gate = {
  ...nativeGate,
  assertSetupAllowed() {
    nativeGate.assertSetupAllowed();
    if (workspacePause?.isHolding())
      throw Error(
        "Crew is coordinating an update across all projects. Resume paused work or Return to work before changing project setup.",
      );
  },
};
const lease = createInstallLease({ directory: updatesDirectory });
let updateReservation: ReturnType<typeof createWorkspaceUpdateReservation>,
  updateRecoveryError: string | undefined;
const reservationPath = join(updatesDirectory, "workspace-reservation.json");
async function reservationPending() {
  try {
    await access(reservationPath);
    return true;
  } catch (error) {
    return errorCode(error) !== "ENOENT";
  }
}
async function assertRegistrationAllowed() {
  if (
    workspacePause?.isHolding() ||
    updateRecoveryError ||
    (await reservationPending())
  )
    throw Error(
      "Resolve the interrupted update before adding another project. Existing project setup remains available.",
    );
}
async function recordReservationFailure(error: unknown) {
  if (await reservationPending()) {
    updateRecoveryError = safe(error);
    changed();
  }
}
async function configuredProjects() {
  const projects: IsolationProject[] = [];
  for (const p of registry.snapshot().projects) {
    try {
      await access(p.configPath);
      projects.push(p);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  return projects;
}
async function validateWorkspaces(candidate?: IsolationCandidate) {
  const projects = await configuredProjects();
  if (candidate && !projects.some((p) => p.id === candidate.id))
    projects.push({ id: candidate.id, configPath: candidate.configPath });
  return projects.length
    ? assertWorkspaceIsolation({ projects, candidate })
    : [];
}
const projectHosts = () =>
  registry.snapshot().projects.map((p) => ({ ...p, host: requiredHost(p.id) }));
function snapshot() {
  const value = registry.snapshot();
  return {
    ...value,
    projects: value.projects.map((project) => {
      const state = hosts.get(project.id)?.snapshot();
      return {
        id: project.id,
        name: project.name,
        pending: state?.pending ?? null,
        active: state?.active ?? null,
        ready: Boolean(state?.ready),
        error: state?.error || null,
      };
    }),
  };
}
function changed() {
  if (!registry) return;
  // Polls from multiple controllers coalesce into one native/UI notification.
  if (changedTimer) return;
  changedTimer = setTimeout(() => {
    changedTimer = undefined;
    updateTray();
    for (const host of hosts.values()) host.notify(snapshot());
  }, 30);
}
const attempt = (fn: () => unknown) =>
  void Promise.resolve()
    .then(fn)
    .catch((error) =>
      dialog.showMessageBox({
        type: "warning",
        message: "Crew needs attention",
        detail: safe(error),
      }),
    );
function updateTray() {
  tray?.refresh();
}
function register(project: WorkspaceProject) {
  const runtime = createProjectHost({
    root,
    storage: {
      ...storage,
      ...project,
      issue: project.configPath === storage.configPath ? storage.issue : null,
    },
    host: {
      capacityDirectory,
      gate,
      assertControllerStartAllowed: () => {
        nativeGate.assertSetupAllowed();
        if (quitting)
          throw Error(
            "Crew is shutting down or installing an update. Wait before restarting a project controller.",
          );
      },
      configured: async (id, previousName, name) => {
        const project = registry.snapshot().projects.find((p) => p.id === id);
        if (
          project &&
          (project.name === previousName || project.name === "Your project") &&
          project.name !== name
        ) {
          await registry.rename(id, name);
          changed();
        }
      },
      validateAll: () => configureCapacity(),
      validateCandidate: (id, configPath, config) =>
        validateWorkspaces({ id, configPath, config }),
      relaunch: async (launchArgs) => {
        quitting = true;
        for (const h of hosts.values()) await h.quit();
        app.relaunch({ args: launchArgs });
        app.exit(0);
      },
      get updater() {
        return updater;
      },
      changed,
      isSelected: (id) => registry.snapshot().selectedId === id,
    },
  });
  hosts.set(project.id, runtime);
  return runtime;
}
async function configureCapacity(limit = registry.snapshot().workerLimit) {
  await validateWorkspaces();
  const stateDirs = [];
  const identities = new Map<string | number, string>(),
    ports = new Map<string | number, string>();
  for (const project of registry.snapshot().projects) {
    try {
      const env = childEnvironment(project.configPath);
      delete env.AI_MANAGER_PORT;
      delete env.VOICE_PORT;
      const config = await loadAppConfig({
        root,
        configPath: project.configPath,
        env,
        checkRuntime: false,
      });
      for (const [map, key, label] of [
        [identities, config.projectStateDir, "state folder"],
        [ports, config.port, "port"],
      ] as const) {
        if (map.has(key))
          throw Error(
            `Projects ${map.get(key)} and ${project.name} share a ${label}. Correct configuration before starting Crew.`,
          );
        map.set(key, project.name);
      }
      stateDirs.push(config.projectStateDir);
    } catch (error) {
      if (!String(errorMessage(error)).startsWith("Configuration:"))
        throw error;
    }
  }
  return configureGlobalCapacity({ dir: capacityDirectory, limit, stateDirs });
}
async function selectProject(id: string) {
  nativeGate.assertSetupAllowed();
  if (transition) throw Error("Another project change is still running.");
  const next = hosts.get(id);
  if (!next) throw Error("Unknown project.");
  if (id === registry.snapshot().selectedId) return next.openWindow();
  transition = true;
  try {
    await selected()?.hide();
    await registry.select(id);
    await next.bootstrap();
    changed();
  } finally {
    transition = false;
  }
}
async function initializeConfig(configPath: string) {
  await new Promise<void>((done, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(root, "cli.mjs"),
        "init",
        "--template",
        "set1",
        "--config",
        configPath,
      ],
      { cwd: root, env: childEnvironment(configPath), stdio: "ignore" },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? done()
        : reject(
            Error(
              "Could not create the new project configuration. No existing file was overwritten.",
            ),
          ),
    );
  });
}
async function addProject() {
  gate.assertSetupAllowed();
  await assertRegistrationAllowed();
  if (transition) throw Error("Another project change is still running.");
  transition = true;
  try {
    const id = `p-${randomUUID()}`,
      configPath = join(crewRoot, "instances", id, "project.json"),
      key = instanceKey(configPath);
    await initializeConfig(configPath);
    const raw = parseConfig(await readFile(configPath, "utf8"));
    const used = new Set();
    for (const p of registry.snapshot().projects) {
      try {
        used.add(
          parseConfig(await readFile(p.configPath, "utf8")).runtime.port,
        );
      } catch {}
    }
    let port = 4320;
    while (used.has(port) && port < 65535) port++;
    if (port === 65535) throw Error("No project port is available.");
    raw.runtime.port = port;
    raw.project.id = id;
    raw.project.name = "New project";
    await writeFile(configPath, JSON.stringify(raw, null, 2) + "\n", {
      mode: 0o600,
    });
    await selected()?.hide();
    await registry.add({
      configPath,
      key,
      desktopData: join(crewRoot, "desktop", key),
      name: "New project",
    });
    registerProjectPath(configPath);
    await configureCapacity();
    await selected().openSetup();
    changed();
    return snapshot();
  } finally {
    transition = false;
  }
}
async function quitCrew() {
  if (quitting) return;
  if (!quitPreparation)
    throw Error(
      "Crew is still initializing its shared preparation coordinator. Wait, then retry Quit.",
    );
  const existing = workspacePause.status();
  if (existing?.purpose === "quit" && existing.phase !== "complete")
    return quitPreparation.begin();
  if (gate.isReserved())
    throw Error("An update is preparing. Wait for it to finish.");
  const result = await dialog.showMessageBox({
    type: "question",
    message: "Prepare all projects and quit Crew?",
    detail:
      "Crew asks each active manager and worker to reach a sensible checkpoint, save continuation notes and confirm readiness. The control window stays available for progress and approvals. Controllers close only after every project is ready. Closing a window alone keeps Crew running.",
    buttons: ["Keep running", "Prepare and quit"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (result.response !== 1) return;
  await quitPreparation.begin();
}
async function resolveUpdateRecovery() {
  const result = await dialog.showMessageBox({
    type: "warning",
    message: "Cancel the interrupted idle-update reservation?",
    detail: `${updateRecoveryError}\n\nCrew will confirm cancellation with every project before releasing worker admissions. Paused workers and retained worktrees stay in place.`,
    buttons: ["Keep paused", "Return to work"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (result.response !== 1) return;
  await updateReservation.cancel();
  gate.cancel();
  updateRecoveryError = undefined;
  changed();
}
async function initializeUpdates() {
  const controls = await createApplicationUpdates({
    capacityDirectory,
    updatesDirectory,
    reservationPath,
    projectHosts,
    selected,
    gate,
    lease,
    restartHandoff,
    changed,
    finishQuit() {
      tray?.destroy();
      app.quit();
    },
    attempt,
    reservationPending,
    recordReservationFailure,
    hosts: () => [...hosts.values()],
    get transition() {
      return transition;
    },
    get quitting() {
      return quitting;
    },
    set quitting(value) {
      quitting = value;
    },
    get updateRecoveryError() {
      return updateRecoveryError;
    },
    set updateRecoveryError(value) {
      updateRecoveryError = value;
    },
  });
  updater = controls.updater;
  workspacePause = controls.workspacePause;
  updateReservation = controls.updateReservation;
  quitPreparation = controls.quitPreparation;
}
const requests = createWorkspaceRequests({
  selected,
  snapshot,
  assertSetupAllowed: () => gate.assertSetupAllowed(),
  select: selectProject,
  add: addProject,
  rename: (id, name) => registry.rename(id, name),
  configureCapacity,
  setWorkerLimit: (limit) => registry.setWorkerLimit(limit),
  changed,
  writeClipboard: (text) => clipboard.writeText(text),
});
ipcMain.handle("crew:setup", requests.setup);
ipcMain.handle("crew:clipboard-write", requests.clipboard);
ipcMain.handle("crew:workspaces", requests.workspaces);
ipcMain.handle("crew:browser", (event, input: unknown) => {
  const host = selected();
  if (!host.acceptsWorkspace(event)) throw Error("Browser request rejected.");
  return host.browserRequest(input);
});
if (!locked) app.quit();
else {
  app.on("second-instance", (_event, _argv, _cwd, data) =>
    attempt(async () => {
      const incoming = record(data || {});
      if (!incoming.configPath) return selected().openWindow();
      if (typeof incoming.configPath !== "string")
        throw new Error("Invalid project configuration path.");
      const incomingIdentity = await realpath(incoming.configPath);
      for (const project of registry.snapshot().projects) {
        if (
          (await realpath(project.configPath).catch(() => null)) ===
          incomingIdentity
        )
          return selectProject(project.id);
      }
      gate.assertSetupAllowed();
      await assertRegistrationAllowed();
      if (transition) throw Error("Another project change is still running.");
      transition = true;
      try {
        const additional = await prepareCrewStorage({
          appData,
          configOverride: incoming.configPath,
        });
        if (additional.issue) throw Error(additional.issue);
        const candidate = {
          id: "incoming",
          configPath: additional.configPath,
          config: parseConfig(await readFile(additional.configPath, "utf8")),
        };
        await assertWorkspaceIsolation({
          projects: [
            ...registry.snapshot().projects,
            { id: candidate.id, configPath: candidate.configPath },
          ],
          candidate,
        });
        await selected().hide();
        await registry.add({
          configPath: additional.configPath,
          key: additional.key,
          desktopData: additional.desktopData,
        });
        registerProjectPath(additional.configPath);
        await configureCapacity();
        await selected().bootstrap();
        changed();
      } finally {
        transition = false;
      }
    }),
  );
  app.on("activate", () => attempt(() => selected()?.openWindow()));
  app.on("window-all-closed", () => {});
  app.on("will-quit", () => {
    for (const host of hosts.values()) void host.disposeAttention();
  });
  app.on("before-quit", (event) => {
    if (!quitting) {
      event.preventDefault();
      attempt(quitCrew);
    }
  });
  void app
    .whenReady()
    .then(async () => {
      const release = await lease.acquire();
      await release();
      if (!storage.issue) {
        try {
          await access(storage.configPath);
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
          if (!explicit) await initializeConfig(storage.configPath);
        }
      }
      registry = await openWorkspaceRegistry({
        crewRoot,
        initial: {
          configPath: storage.configPath,
          key: storage.key,
          desktopData: storage.desktopData,
        },
        explicitConfig: Boolean(explicit || restarted),
      });
      for (const project of registry.snapshot().projects) register(project);
      // A retained idle journal owns a hold even if its capacity ledger was lost.
      if (await reservationPending())
        await configureGlobalCapacity({
          dir: capacityDirectory,
          admissionPaused: true,
        });
      let restoreIssue;
      try {
        await configureCapacity();
      } catch (error) {
        restoreIssue = safe(error);
      }
      await initializeUpdates();
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: "Crew",
            submenu: [
              { label: "About Crew", role: "about" },
              {
                label: "Project setup…",
                click: () => attempt(() => selected().openSetup()),
              },
              { label: "Add project…", click: () => attempt(addProject) },
              { type: "separator" },
              {
                label: "Open window",
                click: () => attempt(() => selected().openWindow()),
              },
              {
                label: "Quit Crew…",
                accelerator: "Command+Q",
                click: () => attempt(quitCrew),
              },
            ],
          },
          {
            label: "Edit",
            submenu: [
              { role: "undo" },
              { role: "redo" },
              { type: "separator" },
              { role: "cut" },
              { role: "copy" },
              { role: "paste" },
              { role: "selectAll" },
            ],
          },
          {
            label: "Window",
            submenu: [{ role: "minimize" }, { role: "close" }],
          },
        ]),
      );
      tray = createWorkspaceTray({
        snapshot,
        selected,
        attempt,
        selectProject,
        addProject,
        resolveUpdateRecovery,
        quitCrew,
        get updateStatus() {
          return updater?.getStatus();
        },
        get updateRecoveryError() {
          return updateRecoveryError;
        },
        get pausePlan() {
          return workspacePause?.status() || null;
        },
        get updateHolding() {
          return workspacePause?.isHolding() || false;
        },
        requestUpdate: (action) => updater.request(action),
      });
      updateTray();
      // Register capacity evidence for every project before recovering any controller.
      if (restoreIssue) {
        selected().setError(restoreIssue);
        await selected().openSetup();
      } else {
        for (const host of hosts.values())
          if (host !== selected()) await host.bootstrap();
        await selected().bootstrap();
      }
      let recovery: { recovered?: boolean; blocked?: boolean; error?: string };
      const retained = workspacePause.status();
      if (
        retained &&
        ["installing", "resuming"].includes(retained.phase) &&
        retained.targetVersion === app.getVersion()
      ) {
        try {
          await updateReservation.cancel();
          recovery = { recovered: true };
        } catch (error) {
          recovery = { blocked: true, error: safe(error) };
        }
      } else recovery = await updateReservation.recover();
      updateRecoveryError = recovery.blocked ? recovery.error : undefined;
      if (!updateRecoveryError) await workspacePause.recover();
      changed();
      const updatePoll = setInterval(
        () => void updater.refresh().catch(() => {}),
        1500,
      );
      updatePoll.unref();
    })
    .catch(async (error) => {
      quitting = true;
      await dialog.showMessageBox({
        type: "error",
        message: "Crew could not restore its projects",
        detail: safe(error),
      });
      app.exit(1);
    });
}

function registerProjectPath(configPath: string): ProjectHost {
  const project = registry
    .snapshot()
    .projects.find((project) => project.configPath === configPath);
  if (!project) throw new Error("Registered project is unavailable.");
  return register(project);
}
