// #95: packaged and development entry points use this single composition.
import {
  app,
  Menu,
  Tray,
  nativeImage,
  dialog,
  ipcMain,
  clipboard,
  safeStorage,
} from "electron";
import { access, lstat, mkdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, join, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  startUnifiedApplication,
  type UnifiedApplication,
} from "../agents/service-composition.mjs";
import { createElectronCredentialEncryption } from "../access/index.mjs";
import {
  ProjectSkillStore,
  createProjectSkillAgentTools,
  ProjectSkillError,
} from "../skills/index.mjs";
import {
  createAgentSchedules,
  createScheduleOwnerCommands,
} from "../application/agent-schedules.mjs";
import { createVoiceOwnerCommands } from "../application/agent-voice.mjs";
import {
  createAgentImages,
  createImageOwnerCommands,
} from "../application/agent-images.mjs";
import type { RuntimeBinding } from "../agents/contracts.mjs";
import {
  openUnifiedRegistry,
  type DesktopProject,
} from "./unified-registry.mjs";
import { startDesktopRenderer } from "./unified-renderer.mjs";
import { createUnifiedWindow } from "./unified-window.mjs";
import {
  createUnifiedQuit,
  type DesktopLifecycleProject,
} from "./unified-quit.mjs";
import { createUnifiedUpdates } from "./unified-updates.mjs";
import { openWebLink } from "./external-links.mjs";
import { AgentSetupError, openAgentSetup } from "./agent-setup.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const desktopDirectory = join(
  process.env.CREW_APP_DATA || app.getPath("appData"),
  "Crew",
  "unified",
);
app.setName("Crew");
app.setPath("userData", desktopDirectory);
app.setPath("sessionData", desktopDirectory);
const locked = app.requestSingleInstanceLock();
let registry: Awaited<ReturnType<typeof openUnifiedRegistry>>;
let renderer: Awaited<ReturnType<typeof startDesktopRenderer>>;
let surface: ReturnType<typeof createUnifiedWindow>;
let quit: ReturnType<typeof createUnifiedQuit>;
let updates: Awaited<ReturnType<typeof createUnifiedUpdates>>;
let tray: Tray | undefined;
let quitting = false,
  switching = false;
type ProjectHost = {
  project: DesktopProject;
  application: UnifiedApplication;
  skills: ProjectSkillStore;
  schedules: ReturnType<typeof createAgentSchedules>;
  scheduleCommand: ReturnType<typeof createScheduleOwnerCommands>;
  voice: UnifiedApplication["voice"];
  voiceCommand: ReturnType<typeof createVoiceOwnerCommands>;
  imageCommand: ReturnType<typeof createImageOwnerCommands>;
  setup: Awaited<ReturnType<typeof openAgentSetup>>;
  unsubscribe: () => void;
};
const hosts = new Map<string, ProjectHost>(),
  failures = new Map<string, string>();
const openings = new Map<string, Promise<void>>();
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected action fields.");
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 4096 ||
    /[\u0000-\u001f]/.test(value)
  )
    throw new Error("Invalid action field.");
  return value;
};
function snapshot() {
  const state = registry.snapshot();
  return {
    selectedId: state.selectedId,
    projects: state.projects.map((project) => ({
      ...project,
      error: failures.get(project.id) ?? null,
    })),
    quit: quit.snapshot(),
    updates: updates?.snapshot() ?? null,
  };
}
function changed() {
  if (!registry || !quit) return;
  quit.observe();
  updates?.observe();
  surface?.notify({ type: "application", snapshot: snapshot() });
  refreshTray();
}
function attempt(operation: () => Promise<unknown>) {
  void operation().catch(() =>
    dialog.showMessageBox({
      type: "warning",
      message: "Crew needs attention",
      detail:
        "This action could not be completed. Open Crew to review the current project and its retained work.",
    }),
  );
}
function requiredProject(projectId: string) {
  if (projectId !== registry.snapshot().selectedId)
    throw new Error("The selected project changed.");
  const host = hosts.get(projectId);
  if (!host) throw new Error("This project needs attention.");
  return host;
}
async function nativeExecutable() {
  // Trusted installation paths only; never inspect personal authentication.
  for (const candidate of [
    "/Applications/Codex.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
    join(homedir(), "Applications/Codex.app/Contents/Resources/codex"),
    join(
      homedir(),
      "Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
    ),
  ]) {
    try {
      const path = await realpath(candidate);
      if (!(await lstat(path)).isFile()) continue;
      await access(path, constants.X_OK);
      return path;
    } catch {
      /* Try the next supported installation. */
    }
  }
  throw new Error("The native Codex runtime is unavailable.");
}
async function openProject(project: DesktopProject) {
  if (hosts.has(project.id)) return;
  if (openings.has(project.id)) return openings.get(project.id);
  const opening = (async () => {
    let application: UnifiedApplication | undefined;
    try {
      const stateDirectory = registry.stateDirectory(project.id);
      const skills = await ProjectSkillStore.open({
        directory: join(stateDirectory, "skills"),
        projectId: project.id,
        forbiddenRoots: [
          project.directory,
          join(homedir(), ".codex"),
          ...(process.env.CODEX_HOME ? [process.env.CODEX_HOME] : []),
        ],
      });
      application = await startUnifiedApplication({
        stateDirectory,
        projectId: project.id,
        projectName: project.name,
        ownerUserId: `local-owner:${project.id}`,
        nativeExecutable: await nativeExecutable(),
        vaultEncryption: createElectronCredentialEncryption(safeStorage),
        skills,
        agentTools: ({ runAuthorized }) => ({
          async list(caller) {
            return createProjectSkillAgentTools({
              store: skills,
              caller,
              runAuthorized,
            }).list();
          },
          async call(caller, name, args) {
            return createProjectSkillAgentTools({
              store: skills,
              caller,
              runAuthorized,
            }).call(name, args);
          },
        }),
      });
      const composed = application;
      const voice = composed.voice;
      const selectedVoice = () =>
        registry.snapshot().projects.find((row) => row.id === project.id)
          ?.voice ?? null;
      const images = createAgentImages({
        projectId: project.id,
        directory: join(stateDirectory, "images"),
      });
      const schedules = createAgentSchedules({
        directory: join(stateDirectory, "schedules"),
        projectId: project.id,
        getAgent: (id) =>
          composed.foundation.store
            .snapshot()
            .agents.find((agent) => agent.id === id) ?? null,
        canRun: (id) => {
          const state = composed.foundation.store.snapshot(),
            agent = state.agents.find((row) => row.id === id);
          return Boolean(
            voice.settlement().settled &&
            agent?.runtime.threadId &&
            agent.runtime.session.sessionId &&
            !state.nativeApprovals.some(
              (approval) => approval.agentId === id,
            ) &&
            composed.foundation.executionAllowed({
              projectId: project.id,
              agentId: id,
              sessionId: agent.runtime.session.sessionId,
            }),
          );
        },
        privateSend: async (input, isCurrent) => {
          const message = await composed.foundation.sendInternal(
            {
              id: input.id,
              source: "schedule",
              sourceId: input.origin.scheduleId,
              recipientAgentId: input.agentId,
              content: [{ type: "text", text: input.instruction }],
            },
            isCurrent,
          );
          return { accepted: message !== null };
        },
        changed: () =>
          surface?.notify({
            type: "owner",
            projectId: project.id,
            event: { kind: "changed" },
          }),
      });
      await schedules.register(
        composed.foundation.store
          .snapshot()
          .agents.filter((agent) => !agent.archivedAt)
          .map((agent) => agent.id),
      );
      await schedules.start();
      // A damaged setup draft must not prevent access to retained agents.
      let setupOpening: ReturnType<typeof openAgentSetup> | undefined;
      const setup = {
        async command(name: string, value: unknown) {
          setupOpening ??= openAgentSetup({
            directory: join(stateDirectory, "setup"),
            project,
            application: composed,
            changed: () =>
              surface?.notify({
                type: "owner",
                projectId: project.id,
                event: { kind: "changed" },
              }),
            created: () =>
              schedules.register(
                composed.foundation.store
                  .snapshot()
                  .agents.filter((agent) => !agent.archivedAt)
                  .map((agent) => agent.id),
              ),
          }).catch((error) => {
            setupOpening = undefined;
            throw error;
          });
          return (await setupOpening).command(name, value);
        },
      };
      const unsubscribe = composed.ownerApi.subscribe((event) => {
        surface?.notify({ type: "owner", projectId: project.id, event });
        changed();
      });
      const unsubscribeVoice = voice.subscribe((event) =>
        surface?.notify({ type: "voice", projectId: project.id, event }),
      );
      const unsubscribeTranscript = voice.subscribeRealtime((event) => {
        // Only native role-bearing transcript items reach the owner display.
        // These are live call text, never evidence of a coding-turn association.
        if (event.kind !== "transcript" || !event.itemId) return;
        surface?.notify({
          type: "voice",
          projectId: project.id,
          event: {
            kind: "transcript",
            binding: event.binding,
            callId: event.callId,
            itemId: event.itemId,
            role: event.role,
            text: event.text,
            done: event.done,
            delta: event.delta,
          },
        });
      });
      hosts.set(project.id, {
        project,
        application: composed,
        skills,
        schedules,
        scheduleCommand: createScheduleOwnerCommands(schedules),
        voice,
        voiceCommand: createVoiceOwnerCommands(voice, selectedVoice),
        imageCommand: createImageOwnerCommands(images),
        setup,
        unsubscribe: () => {
          unsubscribe();
          unsubscribeVoice();
          unsubscribeTranscript();
        },
      });
      failures.delete(project.id);
    } catch {
      await application?.close().catch(() => {});
      failures.set(
        project.id,
        "Crew could not open this project's isolated runtime. Check the installed Codex app and retained project state, then retry.",
      );
    } finally {
      changed();
    }
  })();
  openings.set(project.id, opening);
  try {
    await opening;
  } finally {
    openings.delete(project.id);
  }
}
async function disconnectVoice() {
  const results = await Promise.allSettled(
    [...hosts.values()].map((host) => host.voice.disconnect()),
  );
  if (results.some((result) => result.status === "rejected"))
    throw new Error("A native voice call did not confirm closure.");
}
async function selectProject(projectId: string) {
  if (switching || quit.holding() || updates?.holding())
    throw new Error("Finish the current project transition first.");
  switching = true;
  try {
    const project = registry
      .snapshot()
      .projects.find((row) => row.id === projectId);
    if (!project) throw new Error("Unknown project.");
    await disconnectVoice();
    await registry.select(projectId);
    await updates.withStartupLease(() => openProject(project));
    changed();
  } finally {
    switching = false;
  }
}
function refreshTray() {
  if (!tray || !registry) return;
  const pending = [...hosts.values()].reduce((sum, host) => {
    const state = host.application.foundation.store.snapshot();
    return (
      sum +
      state.helpRequests.filter((request) => request.state === "open").length +
      state.nativeApprovals.length
    );
  }, 0);
  tray.setTitle(pending ? `✋ ${pending}` : "");
  tray.setToolTip(pending ? `Crew — ${pending} need attention` : "Crew");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Crew", click: () => attempt(() => surface.open()) },
      { type: "separator" },
      ...registry.snapshot().projects.map((project) => ({
        label: project.name,
        type: "radio" as const,
        checked: project.id === registry.snapshot().selectedId,
        click: () =>
          attempt(async () => {
            await selectProject(project.id);
            await surface.open();
          }),
      })),
      { type: "separator" },
      {
        label: "Check for updates…",
        click: () =>
          attempt(async () => {
            await surface.open();
            surface.notify({ type: "navigate", view: "updates" });
            await updates.check();
          }),
      },
      { label: "Quit Crew…", click: () => attempt(prepareQuit) },
    ]),
  );
}
async function prepareQuit() {
  if (registry.snapshot().projects.length === 0) {
    await quit.prepare();
    await quit.quit();
    return;
  }
  await surface.open();
  surface.notify({ type: "navigate", view: "prepare" });
  if (switching || openings.size || updates.holding())
    throw new Error(
      "Finish the project or update transition before preparing Quit.",
    );
  await quit.prepare();
}
async function ownerCommand(host: ProjectHost, command: string, args: unknown) {
  if (quit.holding() || updates.holding())
    throw new Error("Crew is completing its execution reservation.");
  if (command.startsWith("setup.")) return host.setup.command(command, args);
  if (command === "environments.snapshot")
    return host.application.environmentOwnerApi.snapshot();
  if (command === "environments.projectFolder")
    return { directory: host.project.directory };
  if (command === "environments.prepareFolderAccess") {
    const input = object(args);
    if (
      input.access !== "none" &&
      input.access !== "read_only" &&
      input.access !== "read_write"
    )
      throw new Error("Choose folder access.");
    const result =
      await host.application.environmentOwnerApi.prepareFolderAccess({
        workspaceDirectory: text(input.workspaceDirectory),
        access: input.access,
      });
    surface.notify({
      type: "owner",
      projectId: host.project.id,
      event: { kind: "changed" },
    });
    return result;
  }
  if (command === "environments.approveWorkspace") {
    const input = object(args);
    const result = await host.application.environmentOwnerApi.approveWorkspace(
      input.input as Parameters<
        UnifiedApplication["environmentOwnerApi"]["approveWorkspace"]
      >[0],
      input.expectedRevision as number | null,
    );
    surface.notify({
      type: "owner",
      projectId: host.project.id,
      event: { kind: "changed" },
    });
    return result;
  }
  if (command === "access.snapshot")
    return host.application.accessOwnerApi.snapshot();
  if (command.startsWith("access."))
    return host.application.accessOwnerApi.command(command.slice(7), args);
  if (command === "skills.list") return host.skills.list();
  if (command === "skills.read")
    return host.skills.read(text(object(args).skillId));
  if (command === "skills.create")
    return host.skills.create(
      args as Parameters<ProjectSkillStore["create"]>[0],
    );
  if (command === "skills.update")
    return host.skills.update(
      args as Parameters<ProjectSkillStore["update"]>[0],
    );
  if (command.startsWith("schedules."))
    return host.scheduleCommand(command, args);
  if (command.startsWith("images.")) return host.imageCommand(command, args);
  if (command === "voice.select") {
    const input = object(args),
      voice = text(input.voice);
    const catalog = await host.voice.listVoices(
      input.binding as RuntimeBinding,
    );
    if (!catalog.voices.some((item) => item.id === voice))
      throw new Error("Select an available native voice.");
    await registry.selectVoice(host.project.id, voice);
    surface.notify({
      type: "owner",
      projectId: host.project.id,
      event: { kind: "changed" },
    });
    return;
  }
  if (command.startsWith("voice.")) return host.voiceCommand(command, args);
  if (command === "subscription.status")
    return host.application.subscription.status();
  if (command === "subscription.beginSignIn")
    return host.application.subscription.beginSignIn();
  if (command === "subscription.cancelSignIn")
    return host.application.subscription.cancelSignIn();
  const result = await host.application.ownerApi.command(command, args);
  if (command === "createAgent")
    await host.schedules.register(
      host.application.foundation.store
        .snapshot()
        .agents.filter((agent) => !agent.archivedAt)
        .map((agent) => agent.id),
    );
  return result;
}
async function request(method: string, value: unknown) {
  if (method === "snapshot") return snapshot();
  if (method === "updates") {
    const action = text(object(value).action);
    if (action === "status") return updates.status();
    if (action === "check") return updates.check();
    if (action === "download") return updates.download();
    if (action === "prepare") return updates.prepare();
    if (action === "cancel") return updates.cancel();
    if (action === "install") return updates.install();
    throw new Error("Unsupported update action.");
  }
  if (method === "copyText") {
    if (typeof value !== "string" || value.length > 1_000_000)
      throw new Error("Clipboard text is too large.");
    clipboard.writeText(value);
    return;
  }
  if (method === "openWebLink") {
    await openWebLink(text(value));
    return;
  }
  if (method === "chooseProjectDirectory") {
    const result = await dialog.showOpenDialog(surface.native()!, {
      properties: ["openDirectory"],
      title: "Choose your project folder",
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const directory = await realpath(result.filePaths[0]);
    return { directory, suggestedName: basename(directory) };
  }
  if (method === "prepareQuit") return prepareQuit();
  if (method === "cancelQuit") return quit.cancel();
  if (method === "quit") return quit.quit();
  const input = object(value);
  if (method === "createProject") {
    if (switching || quit.holding() || updates.holding())
      throw new Error("Finish the current project transition first.");
    switching = true;
    try {
      await disconnectVoice();
      const project = await registry.create({
        name: text(input.name),
        directory: text(input.directory),
      });
      await updates.withStartupLease(() => openProject(project));
      changed();
      return project;
    } finally {
      switching = false;
    }
  }
  if (method === "selectProject") return selectProject(text(input.projectId));
  const host = requiredProject(text(input.projectId));
  if (method === "ownerSnapshot") return host.application.ownerApi.snapshot();
  if (method === "ownerCommand")
    return ownerCommand(host, text(input.command), input.args);
  if (method === "renameProject") {
    await registry.rename(host.project.id, text(input.name));
    changed();
    return;
  }
  throw new Error("Unsupported Crew action.");
}
async function start() {
  if (!isAbsolute(desktopDirectory))
    throw new Error("Crew storage must be absolute.");
  await mkdir(desktopDirectory, { recursive: true, mode: 0o700 });
  registry = await openUnifiedRegistry(desktopDirectory);
  const lifecycleProjects = (): DesktopLifecycleProject[] => {
    if (failures.size || openings.size || switching)
      throw new Error(
        "Every project must be available for the shutdown check.",
      );
    return [...hosts.values()].map((host) => ({
      id: host.project.id,
      name: host.project.name,
      lifecycle: host.application.foundation,
      observePreparation: () =>
        host.application.foundation.store.snapshot().preparation,
      async close(reservation) {
        await host.schedules.close();
        await host.application.close(reservation.id);
        host.unsubscribe();
      },
    }));
  };
  quit = createUnifiedQuit({
    projects: lifecycleProjects,
    changed,
    async finish() {
      quitting = true;
      await disconnectVoice();
      surface.destroy();
      tray?.destroy();
      await renderer.close();
      app.quit();
    },
  });
  updates = await createUnifiedUpdates({
    updatesDirectory: join(desktopDirectory, "updates"),
    projects: lifecycleProjects,
    busy: () =>
      switching ||
      openings.size > 0 ||
      quitting ||
      quit.holding() ||
      quit.snapshot().state === "preparing",
    changed,
    async beforeInstall() {
      await disconnectVoice();
      quitting = true;
      surface.destroy();
      tray?.destroy();
      await renderer.close();
    },
  });
  renderer = await startDesktopRenderer(
    join(root, "renderer-dist"),
    registry.snapshot().rendererPort ?? 0,
  );
  if (registry.snapshot().rendererPort === null)
    await registry.saveRendererPort(renderer.port);
  surface = createUnifiedWindow({
    root,
    desktopDirectory,
    origin: renderer.origin,
    isQuitting: () => quitting,
    disconnectVoice,
    closed: changed,
  });
  ipcMain.handle(
    "crew:unified",
    async (event, method: unknown, value: unknown) => {
      if (!surface.accepts(event) || typeof method !== "string")
        return {
          ok: false,
          error: {
            code: "denied",
            message: "Crew accepts actions only from its current window.",
          },
        };
      try {
        if (JSON.stringify(value ?? null).length > 2_000_000)
          throw new Error("Oversized request.");
        return { ok: true, value: await request(method, value) };
      } catch (error) {
        const detail =
          error instanceof ProjectSkillError || error instanceof AgentSetupError
            ? { code: error.code, message: error.message }
            : {
                code: "failed",
                message:
                  "Crew could not complete this action. Refresh the current settings and retry; your saved state is retained.",
              };
        return { ok: false, error: detail };
      }
    },
  );
  tray = new Tray(
    nativeImage
      .createFromPath(join(root, "build/crew-mark.png"))
      .resize({ width: 20, height: 20 }),
  );
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Crew",
        submenu: [
          { role: "about" },
          { type: "separator" },
          {
            label: "Quit Crew…",
            accelerator: "CommandOrControl+Q",
            click: () => attempt(prepareQuit),
          },
        ],
      },
      { role: "editMenu" },
      { role: "windowMenu" },
    ]),
  );
  await updates.withStartupLease(async () => {
    for (const project of registry.snapshot().projects)
      await openProject(project);
  });
  refreshTray();
  await surface.open();
}
app.on("window-all-closed", () => {
  /* The menu-bar host and agents continue. */
});
app.on("activate", () => {
  if (surface) attempt(() => surface.open());
});
app.on("second-instance", () => {
  if (surface) attempt(() => surface.open());
});
app.on("before-quit", (event) => {
  if (!quitting && surface) {
    event.preventDefault();
    attempt(prepareQuit);
  }
});
if (!locked) app.quit();
else
  app
    .whenReady()
    .then(start)
    .catch(() => {
      dialog.showErrorBox(
        "Crew could not start",
        "The isolated Crew application could not open safely. Retained projects and existing installations have not been reset.",
      );
      quitting = true;
      app.quit();
    });
