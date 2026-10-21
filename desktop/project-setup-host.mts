import { createProjectSetupWindow } from "./project-setup-window.mjs";
import { analyzeAndApplyProject } from "./project-discovery-apply.mjs";
import { app, dialog, shell, systemPreferences } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile, access } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import {
  readSetupConfig,
  saveSetupConfig,
  checkLocalRuntime,
  probeCodex,
  probePaths,
  setupInputsKey,
  requestMicrophonePermission,
  type SetupChecks,
} from "./setup-service.mjs";
import {
  discoverRepository,
  discoverLinearOptions,
  verifyReference,
  type RepositoryOption,
  type LinearCatalog,
} from "./project-options.mjs";
import { assertLinearSelection } from "./project-setup.mjs";
import {
  discoverWorkerEnvironment,
  assertWorkerEnvironmentSelection,
} from "./environment-options.mjs";
import { parseConfig } from "../config/shape.mjs";
import { errorCode, errorMessage, parseJSON, record } from "./validation.mjs";
import type {
  ProjectStorage,
  ProjectParent,
  DesktopApiReply,
} from "./host-contracts.mjs";
import type { TaskCounts } from "./lifecycle.mjs";
export interface SetupHostContext {
  root: string;
  storage: ProjectStorage;
  host: ProjectParent;
  env: NodeJS.ProcessEnv;
  api(
    route: string,
    input?: Record<string, unknown>,
    timeout?: number,
  ): Promise<DesktopApiReply>;
  startup(options?: { showWindow?: boolean }): Promise<void>;
  openWindow(): Promise<void>;
  poll(): Promise<void>;
  stopOwnedBackend(): Promise<void>;
  safe(error: unknown): string;
  readonly backendReady: boolean;
  readonly backend: ChildProcess | undefined;
  readonly counts: TaskCounts;
  lastError: string | null;
}
/** Setup owns disposable discovery/checks and its privileged window, independently of the running project surface. */
export function createProjectSetup(context: SetupHostContext) {
  const {
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
  } = context;
  const { configPath, key, desktopData, id } = storage;
  const flag = 0;
  let discoveryController: AbortController | undefined,
    discoveryRoot: string | undefined,
    discoveryProposal: unknown,
    discoverySummary: unknown,
    linearOptions: LinearCatalog | undefined,
    discoveryPhase: string | undefined;
  const repositoryOptions = new Map<string, RepositoryOption>();
  let setupChecks: SetupChecks = {},
    setupRevision: string | undefined,
    setupInputs: string | undefined,
    setupOperation = false;
  const surface = createProjectSetupWindow({
    root,
    key,
    isSelected: () => host.isSelected(id),
    onClosed: () => discoveryController?.abort(),
  });
  // Setup and workspace surfaces expose separate bounded native bridges.
  function projectDraftStatus(issues: string[] = []) {
    const detail = issues.map((issue) =>
      /teamId|teamKey/.test(issue)
        ? "Choose your Linear team, or connect it later before assigning ticketed work."
        : /baseRef/.test(issue)
          ? "Choose a starting branch for each project folder."
          : /path/.test(issue)
            ? "Choose your local project folder."
            : issue,
    );
    return {
      status: issues.length ? "incomplete" : "configured",
      detail:
        [...new Set(detail)].join(" ") ||
        "Project settings are saved. Ticket access is checked when you ask for work.",
    };
  }
  function microphoneStatus() {
    try {
      const status = systemPreferences.getMediaAccessStatus("microphone");
      return ["granted", "denied", "restricted", "not-determined"].includes(
        status,
      )
        ? status
        : "unknown";
    } catch {
      return "unknown";
    }
  }
  async function setupSnapshot() {
    if (storage.issue)
      return {
        configPath,
        config: null,
        checks: {},
        microphone: microphoneStatus(),
        migration: storage,
        error: storage.issue,
      };
    let value;
    try {
      value = await readSetupConfig(configPath);
    } catch (error) {
      return {
        configPath,
        config: null,
        missingConfig: errorCode(error) === "ENOENT",
        checks: {},
        microphone: microphoneStatus(),
        controllerRunning: context.backendReady,
        error: `Cannot read configuration: ${safe(error)}. Open its JSON file to repair it, then reload setup.`,
      };
    }
    const currentInputs = await setupInputsKey(configPath);
    if (
      (setupRevision && setupRevision !== value.revision) ||
      (setupInputs && setupInputs !== currentInputs)
    ) {
      setupChecks = {};
      discoveryProposal = undefined;
    }
    setupRevision = value.revision;
    setupInputs = currentInputs;
    if (!discoveryRoot)
      discoveryRoot =
        value.config.project.repositories.find((r) => r.path)?.path ||
        undefined;
    for (const repo of value.config.project.repositories) {
      if (!repo.path) continue;
      if (!repositoryOptions.has(repo.path)) {
        let choice;
        try {
          choice = await discoverRepository({
            path: resolve(dirname(configPath), repo.path),
            env,
          });
        } catch {
          choice = {
            path: repo.path,
            name: repo.name,
            status: "unavailable",
            branches: [],
            detail:
              "This folder is unavailable. Choose its current location to reconnect it.",
          };
        }
        repositoryOptions.set(repo.path, choice);
      }
    }
    const workerEnvironmentOptions = await Promise.all(
      value.config.project.repositories.map(async (repo) => ({
        ...(await discoverWorkerEnvironment({
          path: repo.path ? resolve(dirname(configPath), repo.path) : null,
          baseRef: repo.baseRef,
          env,
        })),
        repositoryId: repo.id,
        path: repo.path,
        baseRef: repo.baseRef,
      })),
    );
    return {
      ...value,
      workerEnvironmentOptions,
      discoverySummary,
      linearOptions,
      repositoryOptions: [...repositoryOptions.values()],
      discoveryRoot,
      checks: setupChecks,
      microphone: microphoneStatus(),
      controllerRunning: context.backendReady,
      error: context.lastError,
    };
  }
  const openSetup = surface.open;
  async function assertSetupInputs(inputs: string) {
    if ((await setupInputsKey(configPath)) !== inputs) {
      setupChecks = {};
      throw new Error(
        "Configuration or prompts changed during this check. Reload and retry; stale evidence was discarded.",
      );
    }
  }
  async function checkRuntimeForSetup() {
    await setupSnapshot();
    const inputs = await setupInputsKey(configPath);
    const value = await checkLocalRuntime({ root, configPath, env });
    await assertSetupInputs(inputs);
    if (setupRevision && setupRevision !== value.revision) setupChecks = {};
    setupRevision = value.revision;
    Object.assign(setupChecks, value.checks);
    context.lastError = null;
    return value;
  }
  async function checkAccountForSetup(startLogin = false) {
    const runtime = await checkRuntimeForSetup();
    if (!runtime.executable) throw new Error(runtime.checks.codex.detail);
    const inputs = await setupInputsKey(configPath);
    for (const key of ["protocol", "auth", "voices", "tools"])
      delete setupChecks[key];
    const result = await probeCodex({
      executable: runtime.executable,
      root,
      env,
      startLogin,
      openLogin: (url) => shell.openExternal(url),
    });
    await assertSetupInputs(inputs);
    Object.assign(setupChecks, result);
    return result;
  }
  async function bootstrap() {
    if (context.backendReady) {
      if (host.isSelected(id)) await openWindow();
      return;
    }
    try {
      if (storage.issue) throw new Error(storage.issue);
      try {
        await access(configPath);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        if (flag >= 0 || process.env.AI_MANAGER_CONFIG)
          throw new Error(
            `Configuration file not found: ${configPath}. Initialize this instance using the documented bundled CLI command.`,
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
              : reject(new Error("Could not create the editable template.")),
          );
        });
      }
      const saved = await readSetupConfig(configPath);
      let existing = false;
      try {
        await access(
          join(
            resolve(dirname(configPath), saved.config.runtime.dataDir),
            "manager-chat.json",
          ),
        );
        existing = true;
      } catch {}
      let reviewed = false;
      try {
        const r = record(
          parseJSON(
            await readFile(join(desktopData, "setup-review.json"), "utf8"),
          ),
        );
        reviewed = r.revision === saved.revision;
      } catch {}
      if (existing || reviewed)
        await startup({ showWindow: host.isSelected(id) });
      else if (host.isSelected(id)) await openSetup();
    } catch (error) {
      context.lastError = safe(error);
      await openSetup();
    }
  }
  const handleSetup = async (
    event: Electron.IpcMainInvokeEvent,
    action: string,
    input: unknown,
  ) => {
    const setupWindow = surface.current();
    if (!setupWindow || !surface.accepts(event))
      throw new Error("Setup request rejected.");
    if (typeof action !== "string") throw new Error("Invalid setup request.");
    // Serialize native checks/mutations. Snapshot is read-only and may run during a check.
    if (action === "snapshot") return setupSnapshot();
    host.gate.assertSetupAllowed();
    if (action === "cancel-discovery") {
      if (discoveryPhase === "saving")
        return {
          notice:
            "Your validated settings are already saving. Please wait for the result.",
        };
      discoveryController?.abort();
      return {
        notice: "Canceling project setup. Your saved settings stay unchanged.",
      };
    }
    if (setupOperation)
      throw new Error(
        "Another setup action is still running. Wait for it to finish.",
      );
    setupOperation = true;
    try {
      if (action === "storage-folder") {
        await shell.openPath(storage.crewRoot);
        return;
      }
      if (action === "storage-retry" || action === "storage-use") {
        if (!storage.issue) throw new Error("No storage recovery is pending.");
        let launchArgs = process.argv.slice(1);
        if (action === "storage-use") {
          const choices = [storage.newConfigPath, ...storage.legacyConfigPaths];
          const selected = Number(input);
          if (!Number.isInteger(selected) || !choices[selected])
            throw new Error("Unknown recovery configuration.");
          await access(choices[selected]);
          launchArgs = [
            ...(app.isPackaged ? [] : [root]),
            "--config",
            choices[selected],
          ];
        }
        await host.relaunch(launchArgs);
        return;
      }
      if (storage.issue) throw new Error(storage.issue);
      if (action === "initialize") {
        try {
          await access(configPath);
          throw new Error(
            "Configuration already exists; reload or edit it. Nothing was overwritten.",
          );
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
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
                    "Could not create editable template; inspect the selected configuration folder.",
                  ),
                ),
          );
        });
        context.lastError = null;
        return setupSnapshot();
      }
      if (action === "choose-discovery") {
        const selected = await dialog.showOpenDialog(setupWindow, {
          title: "Choose a project to analyze (read-only)",
          defaultPath: discoveryRoot || app.getPath("home"),
          properties: ["openDirectory"],
        });
        if (!selected.canceled) {
          const choice = await discoverRepository({
            path: selected.filePaths[0],
            env,
          });
          if (choice.status !== "verified") throw Error(choice.detail);
          discoveryRoot = choice.path;
          repositoryOptions.set(choice.path, choice);
          discoveryProposal = undefined;
          discoverySummary = undefined;
        }
        return setupSnapshot();
      }
      if (action === "discover") {
        if (!discoveryRoot)
          throw new Error("Choose a local project folder first.");
        discoveryController = new AbortController();
        discoveryPhase = "analyzing";
        try {
          await analyzeAndApplyProject({
            context,
            discoveryRoot,
            signal: discoveryController.signal,
            checkRuntimeForSetup,
            checkAccountForSetup,
            assertSetupInputs,
            onDiscovered(linear, repository) {
              linearOptions = linear;
              repositoryOptions.set(repository.path, repository);
            },
            markSaving() {
              discoveryPhase = "saving";
            },
            async onApplied(applied, summary) {
              setupRevision = applied.revision;
              setupInputs = await setupInputsKey(configPath);
              setupChecks = { project: projectDraftStatus(applied.issues) };
              context.lastError = null;
              discoveryRoot = summary.path;
              discoverySummary = summary;
            },
          });
          return setupSnapshot();
        } finally {
          discoveryController = undefined;
          discoveryPhase = undefined;
        }
      }
      if (action === "linear-options") {
        const runtime = await checkRuntimeForSetup();
        if (!runtime.executable) throw Error(runtime.checks.codex.detail);
        const inputs = await setupInputsKey(configPath);
        const next = await discoverLinearOptions({
          executable: runtime.executable,
          root,
          env,
          teamId: typeof input === "string" ? input : undefined,
        });
        await assertSetupInputs(inputs);
        linearOptions = next;
        return setupSnapshot();
      }
      if (action === "repository-options") {
        if (typeof input !== "string" || input.length > 4096)
          throw Error("Choose a local folder first.");
        const choice = await discoverRepository({ path: input, env });
        if (choice.status !== "verified") throw Error(choice.detail);
        repositoryOptions.set(choice.path, choice);
        return choice;
      }
      if (action === "runtime") {
        await checkRuntimeForSetup();
        return setupSnapshot();
      }
      if (action === "account" || action === "login") {
        await checkAccountForSetup(action === "login");
        return setupSnapshot();
      }
      if (action === "save") {
        if (context.backend && !context.backendReady)
          throw new Error(
            "Controller startup/shutdown is still pending. Quit this instance safely before editing configuration.",
          );
        const savedInput = record(input);
        if (typeof savedInput.revision !== "string")
          throw new Error("Reload configuration before saving.");
        const inputConfig = parseConfig(JSON.stringify(savedInput.config));
        for (const repo of inputConfig.project.repositories)
          if (repo.path && repo.baseRef)
            await verifyReference({ path: repo.path, ref: repo.baseRef, env });
        if (inputConfig.project.worker.environment?.executionPlan) {
          const options = await Promise.all(
            inputConfig.project.repositories.map(async (repo) => ({
              ...(await discoverWorkerEnvironment({
                path: repo.path,
                baseRef: repo.baseRef,
                env,
              })),
              repositoryId: repo.id,
              path: repo.path,
              baseRef: repo.baseRef,
            })),
          );
          assertWorkerEnvironmentSelection(inputConfig, options);
        }
        assertLinearSelection(inputConfig.project.linear, linearOptions);
        await host.validateCandidate(id, configPath, inputConfig);
        const options = {
          root,
          configPath,
          input: inputConfig,
          revision: savedInput.revision,
          env,
        };
        await saveSetupConfig({ ...options, dryRun: true });
        const wasRunning = context.backendReady;
        if (wasRunning) {
          await poll();
          const state = await api("state");
          if (
            context.counts.active !== 0 ||
            state.activeTurnId ||
            state.voiceActive ||
            state.voiceConnecting
          )
            throw new Error(
              "Finish active work and disconnect voice before applying configuration. No controller or files were changed.",
            );
          await stopOwnedBackend();
        }
        try {
          const previousName = (await readSetupConfig(configPath)).config
            .project.name;
          const saved = await saveSetupConfig(options);
          await host.configured(id, previousName, saved.config.project.name);
          setupRevision = saved.revision;
          setupInputs = await setupInputsKey(configPath);
          setupChecks = { project: projectDraftStatus(saved.issues) };
          context.lastError = null;
        } finally {
          if (wasRunning) await startup({ showWindow: false });
        }
        return setupSnapshot();
      }
      if (action === "paths") {
        const inputs = await setupInputsKey(configPath);
        delete setupChecks.paths;
        const result = await probePaths({ root, configPath, env });
        await assertSetupInputs(inputs);
        setupChecks.paths = result;
        return setupSnapshot();
      }
      if (action === "microphone") {
        if (process.platform !== "darwin")
          throw new Error(
            "Use your operating system microphone settings. Status is unknown on this platform.",
          );
        await requestMicrophonePermission({
          getStatus: microphoneStatus,
          ask: () => systemPreferences.askForMediaAccess("microphone"),
        });
        return setupSnapshot();
      }
      if (action === "choose-repository" || action === "choose-codex") {
        const result = await dialog.showOpenDialog(setupWindow, {
          title:
            action === "choose-repository"
              ? "Choose this project’s repository folder"
              : "Choose the Codex executable",
          properties:
            action === "choose-repository"
              ? ["openDirectory"]
              : ["openFile", "showHiddenFiles"],
        });
        return result.canceled ? null : result.filePaths[0];
      }
      if (action === "settings") {
        const panes: Record<string, string> = {
          microphone:
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
          files:
            "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders",
          network:
            "x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork",
        };
        if (typeof input !== "string" || !Object.hasOwn(panes, input))
          throw new Error("Unknown privacy settings page.");
        await shell.openExternal(panes[input]);
        return {
          notice:
            "Opened macOS privacy settings. Availability depends on your macOS version. Retry the relevant check after changing access; a restart may be needed.",
        };
      }
      if (action === "open-config") {
        await shell.openPath(configPath);
        return;
      }
      if (action === "open-prompts") {
        await shell.openPath(dirname(configPath));
        return;
      }
      if (action === "help") {
        await shell.openExternal(
          "https://developers.openai.com/codex/quickstart",
        );
        return;
      }
      if (action === "launch") {
        if (context.backendReady) {
          await openWindow();
          setupWindow?.close();
          return;
        }
        const runtime = await checkRuntimeForSetup();
        if (
          runtime.checks.codex.status !== "verified" ||
          runtime.checks.git.status !== "verified"
        )
          throw new Error("Install or configure Codex and Git, then retry.");
        await checkAccountForSetup();
        if (setupChecks.auth?.status !== "verified")
          throw new Error(
            "ChatGPT sign-in is required before opening the manager.",
          );
        // Project/voice/tool/permission gaps stay visible and do not become a false complete flag.
        await startup();
        if (!context.backendReady)
          throw new Error(
            context.lastError || "Controller startup was not confirmed.",
          );
        await writeFile(
          join(desktopData, "setup-review.json"),
          JSON.stringify({
            revision: runtime.revision,
            reviewedAt: new Date().toISOString(),
            projectConfigured: setupChecks.project?.status === "configured",
            voiceCatalogVerified: setupChecks.voices?.status === "verified",
            microphone: microphoneStatus(),
            businessAccessVerified: false,
          }) + "\n",
          { mode: 0o600 },
        );
        setupWindow?.close();
        return;
      }
      throw new Error("Unknown setup action.");
    } catch (error) {
      if (
        action === "discover" &&
        /cancel(?:ed|led)/i.test(String(errorMessage(error)))
      )
        return {
          ...(await setupSnapshot()),
          notice:
            "Project analysis canceled. Active configuration is unchanged.",
        };
      throw new Error(safe(error));
    } finally {
      setupOperation = false;
    }
  };

  return {
    bootstrap,
    openSetup,
    handleSetup,
    acceptsSetup: surface.acceptsSender,
    busy: () => Boolean(discoveryController || setupOperation),
    abort: () => discoveryController?.abort(),
    hide: surface.destroy,
  };
}
