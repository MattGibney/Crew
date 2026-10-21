// crew#2: parent-owned workspace identities. Registration never rewrites project state.
import {
  readFile,
  mkdir,
  open,
  rename,
  unlink,
  realpath,
} from "node:fs/promises";
import { dirname, basename, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { record, parseJSON, errorCode, errorMessage } from "./validation.mjs";
export interface WorkspaceProject {
  id: string;
  configPath: string;
  key: string;
  desktopData: string;
  name: string;
}
export interface WorkspaceRegistryState {
  version: 1;
  selectedId: string | null;
  workerLimit: number;
  projects: WorkspaceProject[];
}
export interface WorkspaceProjectInput {
  configPath: string;
  key: string;
  desktopData: string;
  name?: string;
}
function fail(message: string): never {
  throw new Error(`Workspace registry: ${message}`);
}
const clone = <T,>(value: T): T => structuredClone(value);
function keys(
  value: unknown,
  allowed: string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    fail(
      `${label} is invalid. Inspect workspaces.json; no project files were changed.`,
    );
}
function pathValue(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    /[\x00-\x1f\x7f]/.test(value) ||
    value.length > 4096 ||
    resolve(value) === dirname(resolve(value))
  )
    fail(`${label} must be an absolute dedicated path.`);
  return resolve(value);
}
function nameValue(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 200 ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    fail(
      "Project name must contain 1–200 characters without control characters.",
    );
  return value.trim();
}
function identity(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value)
  )
    fail(`${label} is invalid.`);
  return value;
}
function limitValue(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 64
  )
    fail("Worker limit must be an integer between 1 and 64.");
  return value;
}
// Resolve existing aliases, including the existing parent of a not-yet-created file.
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) return path;
    return join(await canonical(parent), basename(path));
  }
}
async function validate(input: unknown): Promise<WorkspaceRegistryState> {
  keys(input, ["version", "selectedId", "workerLimit", "projects"], "Registry");
  if (
    input.version !== 1 ||
    !Array.isArray(input.projects) ||
    input.projects.length > 1000
  )
    fail(
      "Registry version or project list is invalid. Inspect workspaces.json before continuing.",
    );
  const workerLimit = limitValue(input.workerLimit);
  const ids = new Set<string>(),
    configs = new Set<string>(),
    profiles = new Set<string>(),
    partitionKeys = new Set<string>();
  const projects: WorkspaceProject[] = [];
  for (const value of input.projects) {
    keys(value, ["id", "configPath", "key", "desktopData", "name"], "Project");
    const id = identity(value.id, "Project ID"),
      key = identity(value.key, "Project partition key"),
      name = nameValue(value.name);
    if (value.name !== name) fail("Saved project name is invalid.");
    const configPath = pathValue(value.configPath, "Project configuration"),
      desktopData = pathValue(value.desktopData, "Desktop profile");
    if (configPath !== value.configPath || desktopData !== value.desktopData)
      fail("Saved project paths must be normalized absolute paths.");
    const [configIdentity, profileIdentity] = await Promise.all([
      canonical(configPath),
      canonical(desktopData),
    ]);
    if (
      ids.has(id) ||
      configs.has(configIdentity) ||
      profiles.has(profileIdentity) ||
      partitionKeys.has(key)
    )
      fail(
        "Duplicate project identity, configuration or desktop profile. No projects were merged.",
      );
    ids.add(id);
    configs.add(configIdentity);
    profiles.add(profileIdentity);
    partitionKeys.add(key);
    projects.push({ id, key, name, configPath, desktopData });
  }
  const selectedId =
    input.selectedId === null
      ? null
      : identity(input.selectedId, "Selected project");
  if (
    !(projects.length === 0 && selectedId === null) &&
    !ids.has(selectedId || "")
  )
    fail(
      "Selected project is missing. Inspect workspaces.json before continuing.",
    );
  return { version: 1, selectedId, workerLimit, projects };
}
async function projectInput(input: unknown): Promise<WorkspaceProject> {
  keys(input, ["configPath", "key", "desktopData", "name"], "New project");
  const project = {
    id: `project-${randomUUID()}`,
    configPath: pathValue(input.configPath, "Project configuration"),
    key: identity(input.key, "Project partition key"),
    desktopData: pathValue(input.desktopData, "Desktop profile"),
    name: input.name === undefined ? null : nameValue(input.name),
  };
  if (project.name === null) {
    try {
      project.name = nameValue(
        record(
          record(parseJSON(await readFile(project.configPath, "utf8"))).project,
        ).name,
      );
    } catch {
      project.name = "Your project";
    }
  }
  return { ...project, name: project.name || "Your project" };
}
async function atomicWrite(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
    // Persist the rename as well as the new file contents where supported.
    let directory;
    try {
      directory = await open(dirname(path), "r");
      await directory.sync();
    } finally {
      await directory?.close();
    }
  } finally {
    await handle?.close();
    await unlink(temporary).catch((error) => {
      if (errorCode(error) !== "ENOENT") throw error;
    });
  }
}

export async function openWorkspaceRegistry({
  crewRoot,
  initial,
  explicitConfig = false,
}: {
  crewRoot: string;
  initial: WorkspaceProjectInput;
  explicitConfig?: boolean;
}) {
  const root = pathValue(crewRoot, "Crew storage");
  if (typeof explicitConfig !== "boolean")
    fail("Explicit configuration flag must be boolean.");
  const path = join(root, "workspaces.json");
  let state: WorkspaceRegistryState | undefined;
  try {
    state = await validate(parseJSON(await readFile(path, "utf8")));
  } catch (error) {
    if (errorCode(error) !== "ENOENT")
      fail(
        `Cannot open workspaces.json (${error instanceof SyntaxError ? "invalid JSON" : errorMessage(error)}). Existing files were preserved; inspect the registry before retrying.`,
      );
  }
  if (!state || !state.projects.length || explicitConfig) {
    const candidate = await projectInput(initial);
    if (!state || !state.projects.length)
      state = {
        version: 1,
        selectedId: candidate.id,
        workerLimit: state?.workerLimit ?? 2,
        projects: [candidate],
      };
    else {
      const configIdentity = await canonical(candidate.configPath);
      const present = (
        await Promise.all(
          state.projects.map(async (project) => ({
            project,
            path: await canonical(project.configPath),
          })),
        )
      ).find((item) => item.path === configIdentity)?.project;
      if (present) {
        // The retained partition identity is authoritative, even when an old path alias is used.
        state = { ...state, selectedId: present.id };
      } else
        state = {
          ...state,
          selectedId: candidate.id,
          projects: [...state.projects, candidate],
        };
    }
    await validate(state);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await atomicWrite(path, state);
  }
  let currentState: WorkspaceRegistryState = state;
  let tail: Promise<unknown> = Promise.resolve();
  const mutate = (
    operation: (
      current: WorkspaceRegistryState,
    ) => WorkspaceRegistryState | Promise<WorkspaceRegistryState>,
  ) => {
    const pending = tail.then(async () => {
      const next = await operation(clone(currentState));
      await validate(next);
      await atomicWrite(path, next);
      currentState = next;
      return clone(currentState);
    });
    tail = pending.catch(() => {});
    return pending;
  };
  return {
    snapshot: () => clone(currentState),
    add: (input: WorkspaceProjectInput) =>
      mutate(async (current) => {
        const project = await projectInput(input);
        return {
          ...current,
          selectedId: project.id,
          projects: [...current.projects, project],
        };
      }),
    select: (id: string) =>
      mutate((current) => {
        identity(id, "Project ID");
        if (!current.projects.some((project) => project.id === id))
          fail("Project was not found.");
        return { ...current, selectedId: id };
      }),
    rename: (id: string, name: string) =>
      mutate((current) => {
        identity(id, "Project ID");
        const nextName = nameValue(name);
        if (!current.projects.some((project) => project.id === id))
          fail("Project was not found.");
        return {
          ...current,
          projects: current.projects.map((project) =>
            project.id === id ? { ...project, name: nextName } : project,
          ),
        };
      }),
    setWorkerLimit: (limit: number) =>
      mutate((current) => ({ ...current, workerLimit: limitValue(limit) })),
  };
}
