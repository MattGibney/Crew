import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

export interface DesktopProject {
  id: string;
  name: string;
  directory: string;
  voice?: string | null;
}
export interface DesktopRegistrySnapshot {
  version: 1;
  rendererPort: number | null;
  selectedId: string | null;
  projects: DesktopProject[];
}

/** Only native window selection lives here. The production composition owns all
 * agent, access, connection, skill and delivery state beneath each project. */
export async function openUnifiedRegistry(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await realpath(directory);
  if ((await lstat(directory)).isSymbolicLink())
    throw new Error(
      "Crew application storage must be a canonical private directory.",
    );
  const path = join(root, "projects.json");
  let state: DesktopRegistrySnapshot;
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 128_000)
      throw new Error("The Crew project registry cannot be read safely.");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      state = validate(JSON.parse(await file.readFile("utf8")));
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    state = { version: 1, rendererPort: null, selectedId: null, projects: [] };
  }
  let tail = Promise.resolve();
  const update = <T,>(
    operation: (draft: DesktopRegistrySnapshot) => Promise<T>,
  ): Promise<T> => {
    const next = tail.then(async () => {
      const draft = structuredClone(state);
      const result = await operation(draft);
      validate(draft);
      const temporary = join(root, `.projects-${randomUUID()}.tmp`);
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(draft, null, 2)}\n`);
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
      state = draft;
      return result;
    });
    tail = next.then(
      () => {},
      () => {},
    );
    return next;
  };
  return {
    snapshot: () => structuredClone(state),
    saveRendererPort(port: number) {
      return update(async (draft) => {
        if (!Number.isInteger(port) || port < 1024 || port > 65535)
          throw new Error("The Crew renderer port is invalid.");
        if (draft.rendererPort !== null && draft.rendererPort !== port)
          throw new Error(
            "Crew must retain its registered presentation origin.",
          );
        draft.rendererPort = port;
      });
    },
    stateDirectory(projectId: string) {
      if (!state.projects.some((project) => project.id === projectId))
        throw new Error("Select a registered project.");
      return join(root, "projects", projectId);
    },
    async create(input: { name: string; directory: string }) {
      const projectDirectory = await realpath(input.directory);
      if (!(await lstat(projectDirectory)).isDirectory())
        throw new Error("Select a project folder.");
      if (within(projectDirectory, root) || within(root, projectDirectory))
        throw new Error(
          "Project source and Crew application storage must be separate folders.",
        );
      return update(async (draft) => {
        if (
          draft.projects.some(
            (project) => project.directory === projectDirectory,
          )
        )
          throw new Error("This project folder is already registered.");
        const project = {
          id: randomUUID(),
          name: projectName(input.name),
          directory: projectDirectory,
        };
        draft.projects.push(project);
        draft.selectedId = project.id;
        return project;
      });
    },
    select(id: string) {
      return update(async (draft) => {
        if (!draft.projects.some((project) => project.id === id))
          throw new Error("Select a registered project.");
        draft.selectedId = id;
      });
    },
    rename(id: string, name: string) {
      return update(async (draft) => {
        const project = draft.projects.find((project) => project.id === id);
        if (!project) throw new Error("Select a registered project.");
        project.name = projectName(name);
      });
    },
    selectVoice(id: string, voice: string) {
      return update(async (draft) => {
        const project = draft.projects.find((project) => project.id === id);
        if (
          !project ||
          typeof voice !== "string" ||
          !voice ||
          voice.length > 200 ||
          /[\u0000-\u001f]/.test(voice)
        )
          throw new Error("Select an available native voice.");
        project.voice = voice;
      });
    },
    retireLegacyVoice(id: string) {
      return update(async (draft) => {
        const project = draft.projects.find((row) => row.id === id);
        if (!project) throw new Error("Select a registered project.");
        delete project.voice;
      });
    },
  };
}

function within(parent: string, child: string) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
function projectName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 100 ||
    /[\u0000-\u001f]/.test(value)
  )
    throw new Error("Use a project name between 1 and 100 characters.");
  return value.trim();
}
function validate(value: unknown): DesktopRegistrySnapshot {
  const state = value as DesktopRegistrySnapshot;
  if (
    !state ||
    state.version !== 1 ||
    !Array.isArray(state.projects) ||
    state.projects.length > 100
  )
    throw new Error(
      "The Crew project registry is invalid. Restore it before continuing.",
    );
  if (
    state.rendererPort !== null &&
    (!Number.isInteger(state.rendererPort) ||
      state.rendererPort < 1024 ||
      state.rendererPort > 65535)
  )
    throw new Error("The saved Crew presentation port is invalid.");
  const ids = new Set<string>(),
    paths = new Set<string>();
  for (const project of state.projects) {
    if (
      !project ||
      !/^[0-9a-f-]{36}$/.test(project.id) ||
      ids.has(project.id) ||
      typeof project.directory !== "string" ||
      !isAbsolute(project.directory) ||
      paths.has(project.directory)
    )
      throw new Error("The Crew project registry contains an invalid project.");
    projectName(project.name);
    if (
      project.voice != null &&
      (typeof project.voice !== "string" ||
        !project.voice ||
        project.voice.length > 200 ||
        /[\u0000-\u001f]/.test(project.voice))
    )
      throw new Error("The saved voice choice is invalid.");
    ids.add(project.id);
    paths.add(project.directory);
  }
  if (state.selectedId !== null && !ids.has(state.selectedId))
    throw new Error("The selected Crew project is unavailable.");
  return state;
}
