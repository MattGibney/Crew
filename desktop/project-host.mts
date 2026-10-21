import { parseControllerReply } from "./controller-api.mjs";
import { createProjectSetup } from "./project-setup-host.mjs";
// The main process owns controllers; project windows own only voice and UI.
import { BrowserWindow, dialog, shell, session } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import {
  readFile,
  writeFile,
  mkdir,
  open,
  access,
  rename,
} from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { UPDATE_ACTIONS, PAUSE_UPDATE_ACTIONS } from "./updater.mjs";
import { loadAppConfig } from "../config.mjs";
import {
  summarizeTasks,
  isAppURL,
  isExternalHTTPS,
  permitsAudio,
  childEnvironment,
  type TaskCounts,
} from "./lifecycle.mjs";
import { createNativeAttention } from "./native-attention.mjs";
import { projectWindowChrome } from "./window-chrome.mjs";
import type {
  ProjectStorage,
  ProjectParent,
  DesktopApiReply,
} from "./host-contracts.mjs";
import type { LoadedConfig } from "../config/contracts.mjs";
import { errorCode, errorMessage, parseJSON, record } from "./validation.mjs";
export function createProjectHost({
  root,
  storage,
  host,
}: {
  root: string;
  storage: ProjectStorage;
  host: ProjectParent;
}) {
  const { configPath, key, desktopData, id } = storage;
  mkdirSync(join(desktopData, "Partitions", `instance-${key}`), {
    recursive: true,
    mode: 0o700,
  });
  const flag = 0; // Registered configurations are never silently reinitialized.
  let window: BrowserWindow | undefined,
    config: LoadedConfig | undefined,
    origin: string | undefined,
    backend: ChildProcess | undefined,
    pollTimer: NodeJS.Timeout | undefined,
    starting = false,
    quitting = false,
    closing = false;
  const currentConfig = (): LoadedConfig => {
    if (!config) throw new Error("Project configuration is unavailable.");
    return config;
  };

  let stoppedForUpdate = false;
  let counts: TaskCounts = { active: null, pending: null },
    lastError: string | null = null,
    backendReady = false;
  let attentionRevision = 0;
  // Each registered project retains its own history and background notification
  // owner, independent of which project's renderer is currently visible.
  const attentionSound = createNativeAttention({
    ledgerPath: join(desktopData, "attention-sounds.json"),
    soundPath: join(root, "desktop/sounds/attention.wav"),
    onStatus: () => {
      void statusFile().catch(() => {});
    },
  });
  const env: NodeJS.ProcessEnv = {
    ...childEnvironment(configPath),
    CREW_GLOBAL_CAPACITY_DIR: host.capacityDirectory,
  };
  delete env.AI_MANAGER_PORT;
  delete env.VOICE_PORT;
  const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
  const safe = (error: unknown) =>
    errorMessage(error)
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/sk-[\w-]+/g, "[redacted]")
      .slice(0, 1400);
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
  async function statusFile() {
    if (!config) return;
    const target = join(currentConfig().dataDir, "desktop-status.json");
    const value = {
      pid: process.pid,
      backendPid: backend?.exitCode === null ? backend.pid : null,
      configPath,
      projectId: currentConfig().project.id,
      port: currentConfig().port,
      backendReady,
      windowOpen: Boolean(window && !window.isDestroyed()),
      windowCount: window && !window.isDestroyed() ? 1 : 0,
      isQuitting: quitting,
      pendingCount: counts.pending,
      activeCount: counts.active,
      ...counts,
      error: lastError,
      attentionSound: attentionSound.getStatus(),
      update: host.updater?.getStatus(),
      updatedAt: new Date().toISOString(),
    };
    const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, target);
  }
  async function api(
    route: string,
    input: Record<string, unknown> = {},
    timeout = 6000,
  ): Promise<DesktopApiReply> {
    const response = await fetch(`${origin}/api/${route}`, {
      method: "POST",
      headers: { Origin: origin || "", "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(timeout),
    });
    const value = parseControllerReply(await response.json());
    if (!response.ok)
      throw new Error(
        value.error || `Local request failed (${response.status}).`,
      );
    return value;
  }
  function updateTray() {
    host.changed();
  }
  async function openWindow() {
    if (!host.isSelected(id)) return;
    if (!backendReady) return openSetup();
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
      title: `${config?.project.name || "Setup"} — Crew`,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        preload: join(root, "desktop/workspace-preload.cjs"),
        session: session.fromPath(
          join(desktopData, "Partitions", `instance-${key}`),
        ),
      },
    });
    window = next;
    next.webContents.setWindowOpenHandler((details) => {
      // Only the trusted local UI may send an HTTPS connector/login link to the OS browser.
      if (
        origin &&
        isAppURL(next.webContents.getURL(), origin) &&
        isExternalHTTPS(details.url)
      )
        void shell
          .openExternal(details.url)
          .catch((error) => console.error(safe(error)));
      return { action: "deny" };
    });
    next.webContents.on("will-navigate", (event, url) => {
      if (!origin || !isAppURL(url, origin)) event.preventDefault();
    });
    next.webContents.on("will-attach-webview", (event) =>
      event.preventDefault(),
    );
    next.on("close", (event) => {
      if (quitting || closing) return;
      event.preventDefault();
      closing = true;
      void (async () => {
        // Stop server voice before destroying Chromium, which releases mic tracks/SSE.
        if (backendReady) await api("disconnect", {}, 4000).catch(() => {});
        if (!next.isDestroyed()) next.destroy();
        if (window === next) window = undefined;
        closing = false;
        await statusFile().catch(() => {});
      })();
    });
    next.on("closed", () => {
      if (window === next) window = undefined;
      void statusFile().catch(() => {});
    });
    if (backendReady) await next.loadURL(origin || "");
    else
      await next.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>Crew setup</title><style>body{font:17px system-ui;max-width:760px;margin:72px auto;padding:24px;line-height:1.6;background:#f7f8fc;color:#182033}code{overflow-wrap:anywhere}</style><h1>${lastError ? "Setup needs attention" : "Starting Crew"}</h1><p>${escape(lastError || "Starting the local controller. Microphone is off.")}</p><p>Configuration: <code>${escape(configPath)}</code></p><p>Use the menu-bar icon to edit configuration, open logs, or retry startup. Each workspace handles one project. No work starts automatically.</p>`)}`,
      );
    next.show();
    await statusFile().catch(() => {});
  }
  async function poll() {
    if (!backendReady || quitting) return;
    try {
      const observedAttentionRevision = attentionRevision;
      const [view, work, approvals] = await Promise.all([
        api("orchestration"),
        api("state"),
        api("worker-approvals"),
      ]);
      counts = summarizeTasks(view);
      lastError = view.error ? safe(view.error) : null;
      // IPC may resolve an approval while its older poll response is in flight.
      // Do not let that stale response restore a request already cleared natively.
      if (observedAttentionRevision === attentionRevision)
        attentionSound.update({
          work,
          orchestration: view,
          workerApprovals: approvals.requests,
        });
    } catch (error) {
      counts = { active: null, pending: null };
      lastError = safe(error);
    }
    // Parent polls all controllers; update refresh is shared.
    updateTray();
    await statusFile().catch(() => {});
  }
  async function startup({ showWindow = true } = {}) {
    if (starting || backend) return;
    host.assertControllerStartAllowed?.();
    starting = true;
    lastError = null;
    updateTray();
    try {
      try {
        await access(configPath);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        if (flag >= 0 || process.env.AI_MANAGER_CONFIG)
          throw new Error(
            `Configuration file not found: ${configPath}. Initialize it with the documented local configuration command before launching this instance.`,
          );
        await new Promise<void>((done, reject) => {
          const init = spawn(
            process.execPath,
            [
              join(root, "cli.mjs"),
              "init",
              "--template",
              "set1",
              "--config",
              configPath,
            ],
            { cwd: root, env, stdio: "ignore" },
          );
          init.once("error", reject);
          init.once("exit", (code) =>
            code === 0
              ? done()
              : reject(
                  new Error(
                    "Could not create first-launch project configuration. No existing file was overwritten.",
                  ),
                ),
          );
        });
      }
      await host.validateAll();
      config = await loadAppConfig({ root, configPath, env });
      origin = `http://127.0.0.1:${currentConfig().port}`;
      await mkdir(currentConfig().dataDir, { recursive: true, mode: 0o700 });
      // Never attach to or stop a server started by another owner.
      try {
        const marker = record(
          parseJSON(await readFile(currentConfig().serverStatePath, "utf8")),
        );
        if (
          typeof marker.pid !== "number" ||
          !Number.isSafeInteger(marker.pid) ||
          marker.pid < 1
        )
          throw new Error(
            "Instance server marker is malformed. Inspect it before restarting.",
          );
        let alive = true;
        try {
          process.kill(marker.pid, 0);
        } catch (error) {
          if (errorCode(error) === "ESRCH") alive = false;
          else throw error;
        }
        if (alive)
          throw new Error(
            `This configuration already has a local server (PID ${marker.pid}). Stop it with its existing local stop command before opening this instance in the desktop app. No process was changed.`,
          );
      } catch (error) {
        if (
          errorCode(error) !== "ENOENT" &&
          !errorMessage(error)?.startsWith("Unexpected")
        )
          throw error;
        if (error instanceof SyntaxError)
          throw new Error(
            "Instance server marker is malformed. Inspect it before restarting.",
          );
      }
      const log = await open(
        join(currentConfig().dataDir, "desktop.log"),
        "a",
        0o600,
      );
      try {
        backend = spawn(process.execPath, [join(root, "server.mjs")], {
          cwd: root,
          env,
          stdio: ["ignore", log.fd, log.fd, "ipc"],
        });
      } finally {
        await log.close();
      }
      const owned = backend;
      owned.on("message", (raw) => {
        let message: Record<string, unknown>, event: Record<string, unknown>;
        try {
          message = record(raw);
          event =
            message.event && typeof message.event === "object"
              ? record(message.event)
              : {};
        } catch {
          return;
        }
        if (
          backend === owned &&
          !quitting &&
          message?.type === "crew:attention:state"
        ) {
          attentionRevision++;
          if (
            event.type === "work-state" ||
            event.type === "orchestration-state"
          ) {
            let state: Record<string, unknown>;
            try {
              state = record(event.state);
            } catch {
              return;
            }
            if (event.type === "work-state")
              attentionSound.update({ work: state });
            else attentionSound.update({ orchestration: state });
          }
          if (event.type === "worker-approval-state")
            attentionSound.update({
              workerApprovals: Array.isArray(event.requests)
                ? event.requests
                : [],
            });
          return;
        }
        if (
          backend !== owned ||
          message?.type !== "crew:update:request" ||
          typeof message.id !== "string" ||
          typeof message.action !== "string" ||
          !/^[a-zA-Z0-9_-]{1,80}$/.test(message.id) ||
          (!UPDATE_ACTIONS.has(message.action) &&
            !PAUSE_UPDATE_ACTIONS.has(message.action) &&
            !["resume-paused-work", "return-to-work"].includes(message.action))
        )
          return;
        const action = message.action;
        void (async () => {
          try {
            const status = await host.updater.request(action);
            sendUpdate(owned, {
              type: "crew:update:response",
              id: message.id,
              status,
            });
          } catch (error) {
            sendUpdate(owned, {
              type: "crew:update:response",
              id: message.id,
              status: host.updater?.getStatus(),
              error: safe(error),
            });
          }
        })();
      });
      sendUpdate(owned, {
        type: "crew:update:status",
        status: host.updater?.getStatus(),
      });
      let spawnFailure: Error | undefined;
      owned.once("error", (error) => {
        spawnFailure = error;
      });
      owned.once("exit", () => {
        if (backend === owned) backend = undefined;
        backendReady = false;
        if (!quitting) {
          lastError =
            "Local controller stopped. Inspect desktop.log, then reopen the project from the project switcher. Already dispatched workers were not canceled.";
          updateTray();
          void statusFile().catch(() => {});
        }
      });
      for (let attempt = 0; attempt < 200; attempt++) {
        if (spawnFailure) throw spawnFailure;
        if (owned.exitCode !== null)
          throw new Error(
            "Local controller could not start. Inspect desktop.log for the configuration or port error. No other server was stopped.",
          );
        try {
          const marker = record(
            parseJSON(await readFile(currentConfig().serverStatePath, "utf8")),
          );
          if (
            marker.pid === owned.pid &&
            marker.configPath === currentConfig().configPath &&
            marker.projectId === currentConfig().project.id &&
            marker.port === currentConfig().port
          ) {
            await api("config");
            backendReady = true;
            break;
          }
        } catch {}
        await delay(100);
      }
      if (!backendReady)
        throw new Error(
          "Local controller startup was not confirmed within 20 seconds. Inspect desktop.log before retrying.",
        );
      const partition = session.fromPath(
        join(desktopData, "Partitions", `instance-${key}`),
      );
      partition.setPermissionRequestHandler(
        (contents, permission, callback, details) =>
          callback(
            contents === window?.webContents &&
              permitsAudio(permission, details, origin),
          ),
      );
      partition.setPermissionCheckHandler(
        (contents, permission, requestingOrigin, details) =>
          contents === window?.webContents &&
          permitsAudio(
            permission,
            { ...details, securityOrigin: requestingOrigin },
            origin,
          ),
      );
      partition.on("will-download", (event) => event.preventDefault());
      counts = summarizeTasks(await api("orchestration"));
      if (window && !window.isDestroyed()) await window.loadURL(origin);
      else if (showWindow && host.isSelected(id)) await openWindow();
      if (!pollTimer) pollTimer = setInterval(() => void poll(), 1500);
    } catch (error) {
      lastError = safe(error);
      console.error(lastError);
      if (window && !window.isDestroyed()) window.destroy();
      window = undefined;
      if (host.isSelected(id)) await openSetup();
    } finally {
      starting = false;
      updateTray();
      await statusFile().catch(() => {});
    }
  }
  async function stopOwnedBackend() {
    if (!backend) return;
    const owned = backend;
    const marker = record(
      parseJSON(await readFile(currentConfig().serverStatePath, "utf8")),
    );
    if (
      marker.pid !== owned.pid ||
      marker.configPath !== currentConfig().configPath ||
      marker.projectId !== currentConfig().project.id
    )
      throw new Error(
        "Controller ownership changed. Quit was stopped; no unrelated process was signaled.",
      );
    await api("disconnect", {}, 4000).catch(() => {});
    await api("shutdown", { token: marker.token });
    for (let attempt = 0; attempt < 150 && owned.exitCode === null; attempt++)
      await delay(100);
    if (owned.exitCode === null)
      throw new Error(
        "Controller shutdown is still pending. Inspect desktop.log; this window will remain available.",
      );
    backend = undefined;
    backendReady = false;
  }
  function sendUpdate(
    child: ChildProcess | undefined,
    message: Record<string, unknown>,
  ) {
    if (!child?.connected) return;
    try {
      child.send(message, (error) => {
        if (error) console.error("Update status delivery failed.");
      });
    } catch {
      console.error("Update status delivery failed.");
    }
  }
  async function updateAction(action: string) {
    try {
      if (action === "restart") {
        const result = await dialog.showMessageBox({
          type: "question",
          message: "Restart Crew to install the downloaded update?",
          detail:
            "Crew checks that this project is idle and other Crew instances are closed. Your local configuration, authentication, history and retained worktrees stay in place.",
          buttons: ["Keep running", "Restart to update"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (result.response !== 1) return;
      }
      await host.updater.request(action);
    } catch (error) {
      await dialog.showMessageBox({
        type: "warning",
        message: "Crew update needs attention",
        detail: safe(error),
      });
    }
  }
  async function updateToken(
    route: string,
    input: Record<string, unknown> = {},
  ) {
    if (!backendReady || !backend)
      throw new Error("Local controller is unavailable.");
    const marker = record(
      parseJSON(await readFile(currentConfig().serverStatePath, "utf8")),
    );
    if (
      marker.pid !== backend.pid ||
      marker.configPath !== currentConfig().configPath ||
      marker.projectId !== currentConfig().project.id
    )
      throw new Error("Controller ownership could not be verified.");
    return api(route, { ...input, token: marker.token });
  }
  const setup = createProjectSetup({
    root,
    storage,
    host,
    env,
    api,
    startup,
    openWindow,
    poll,
    stopOwnedBackend,
    safe,
    get backendReady() {
      return backendReady;
    },
    get backend() {
      return backend;
    },
    get counts() {
      return counts;
    },
    get lastError() {
      return lastError;
    },
    set lastError(value) {
      lastError = value;
    },
  });
  async function openSetup() {
    return setup.openSetup();
  }

  return {
    id,
    configPath,
    bootstrap: setup.bootstrap,
    startup,
    openWindow,
    openSetup,
    poll,
    handleSetup: setup.handleSetup,
    updateToken,
    setError: (message: string) => {
      lastError = message;
    },
    api,
    stop: stopOwnedBackend,
    acceptsSetup: setup.acceptsSetup,
    acceptsWorkspace: (event: Electron.IpcMainInvokeEvent) =>
      Boolean(
        window &&
        event.sender === window.webContents &&
        event.senderFrame === window.webContents.mainFrame &&
        isAppURL(event.senderFrame?.url || "", origin),
      ),
    snapshot: () => ({
      id,
      name: config?.project.name,
      ready: backendReady,
      error: lastError,
      ...counts,
    }),
    busy: () => Boolean(setup.busy() || starting || closing),
    backendPid: () => backend?.pid,
    logsDirectory: () => config?.dataDir,
    notify: (value: unknown) => {
      if (window && !window.isDestroyed())
        window.webContents.send("crew:workspaces:changed", value);
    },
    broadcastUpdate: (status: unknown) =>
      sendUpdate(backend, { type: "crew:update:status", status }),
    async hide() {
      if (setup.busy() || starting || closing)
        throw Error(
          "Finish the current project setup or window action before switching projects.",
        );
      if (backendReady) await api("disconnect", {}, 4000);
      // Destroying this renderer releases physical tracks, SSE, and project-local drafts.
      if (window && !window.isDestroyed()) {
        closing = true;
        window.destroy();
        window = undefined;
        closing = false;
      }
      setup.hide();
      await statusFile().catch(() => {});
    },
    disposeAttention: () => attentionSound.dispose(),
    async quit() {
      quitting = true;
      setup.abort();
      clearInterval(pollTimer);
      await stopOwnedBackend();
      await attentionSound.dispose();
      window?.destroy();
      setup.hide();
      await statusFile().catch(() => {});
    },
    async cancelUpdate() {
      quitting = false;
      if (backendReady) await updateToken("update-cancel");
      else if (stoppedForUpdate && !backend)
        await startup({ showWindow: host.isSelected(id) });
      stoppedForUpdate = false;
    },
    async stopForUpdate() {
      stoppedForUpdate = backendReady;
      quitting = true;
      clearInterval(pollTimer);
      pollTimer = undefined;
      await stopOwnedBackend();
    },
  };
}
