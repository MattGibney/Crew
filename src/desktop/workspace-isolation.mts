// crew#2: preflight physical project boundaries before a controller or config changes.
import { readFile, realpath } from "node:fs/promises";
import {
  dirname,
  basename,
  resolve,
  join,
  relative,
  isAbsolute,
  sep,
} from "node:path";

import { record, parseJSON, errorCode } from "./validation.mjs";
export interface IsolationProject {
  id: string;
  configPath: string;
}
export interface IsolationCandidate extends IsolationProject {
  config: unknown;
}
function fail(message: string): never {
  throw new Error(`Workspace isolation: ${message}`);
}
function pathText(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    /[\x00-\x1f\x7f]/.test(value) ||
    value.length > 4096 ||
    value.startsWith("~") ||
    /\$\{|%[A-Z_]+%/.test(value)
  )
    fail(`${label} must be a real local path.`);
  return value;
}
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT")
      fail(
        `Cannot verify the physical path ${path} (${errorCode(error) || "read failed"}).`,
      );
    const parent = dirname(path);
    return parent === path
      ? path
      : join(await canonical(parent), basename(path));
  }
}
function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return (
    !rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  );
}
const overlap = (left: string, right: string) =>
  contains(left, right) || contains(right, left);

export async function assertWorkspaceIsolation({
  projects,
  candidate,
}: {
  projects: IsolationProject[];
  candidate?: IsolationCandidate;
}) {
  if (!Array.isArray(projects) || !projects.length)
    fail("Registered project list is missing.");
  const ids = new Set();
  for (const project of projects) {
    if (
      !project ||
      typeof project.id !== "string" ||
      !project.id ||
      ids.has(project.id)
    )
      fail("Registered project identities are missing or duplicated.");
    ids.add(project.id);
    pathText(project.configPath, "Configuration");
    if (!isAbsolute(project.configPath))
      fail("Registered configuration paths must be absolute.");
  }
  if (
    candidate &&
    (!ids.has(candidate.id) ||
      !candidate.config ||
      candidate.configPath !==
        projects.find((project) => project.id === candidate.id)?.configPath)
  )
    fail("Candidate must match a registered project and configuration path.");
  const summaries = [];
  for (const project of projects) {
    const configPath = resolve(project.configPath),
      base = dirname(configPath);
    let raw: Record<string, unknown>;
    try {
      raw = record(
        candidate?.id === project.id
          ? candidate.config
          : parseJSON(await readFile(configPath, "utf8")),
      );
    } catch (error) {
      fail(
        `Cannot read configuration for ${project.id} (${error instanceof SyntaxError ? "invalid JSON" : errorCode(error) || "read failed"}). Resolve it before starting a project.`,
      );
    }
    let runtime: Record<string, unknown>,
      projectConfig: Record<string, unknown>;
    try {
      runtime = record(raw.runtime);
      projectConfig = record(raw.project);
    } catch {
      fail(
        `Configuration for ${project.id} is missing runtime or project settings.`,
      );
    }
    const port = runtime.port;
    if (
      typeof port !== "number" ||
      !Number.isSafeInteger(port) ||
      port < 1024 ||
      port > 65535
    )
      fail(`Project ${project.id} needs a port between 1024 and 65535.`);
    const dataDir = resolve(
      base,
      pathText(runtime.dataDir, `State folder for ${project.id}`),
    );
    if (dataDir === dirname(dataDir))
      fail(`Project ${project.id} needs a dedicated state folder.`);
    const prompts = record(projectConfig.prompts);
    const [physicalConfigPath, physicalDataDir, managerPrompt, workerPrompt] =
      await Promise.all([
        canonical(configPath),
        canonical(dataDir),
        canonical(
          resolve(
            base,
            pathText(
              prompts?.manager,
              `Manager instructions for ${project.id}`,
            ),
          ),
        ),
        canonical(
          resolve(
            base,
            pathText(prompts?.worker, `Worker instructions for ${project.id}`),
          ),
        ),
      ]);
    summaries.push({
      id: project.id,
      configPath,
      port,
      dataDir,
      physicalConfigPath,
      physicalDataDir,
      promptPaths: { manager: managerPrompt, worker: workerPrompt },
    });
  }
  for (let i = 0; i < summaries.length; i++) {
    const left = summaries[i];
    for (const right of summaries.slice(i + 1)) {
      const pair = `Projects ${left.id} and ${right.id}`;
      if (left.port === right.port)
        fail(`${pair} share port ${left.port}. Choose separate project ports.`);
      if (left.physicalConfigPath === right.physicalConfigPath)
        fail(
          `${pair} share a configuration file. Keep separate configurations.`,
        );
      if (overlap(left.physicalDataDir, right.physicalDataDir))
        fail(
          `${pair} share or nest state folders. Choose separate state folders.`,
        );
      if (
        contains(left.physicalDataDir, right.physicalConfigPath) ||
        contains(right.physicalDataDir, left.physicalConfigPath)
      )
        fail(
          `${pair} place a configuration inside the other project's state folder.`,
        );
      const leftPrompts = Object.values(left.promptPaths),
        rightPrompts = Object.values(right.promptPaths);
      if (leftPrompts.some((path) => rightPrompts.includes(path)))
        fail(
          `${pair} share instruction files. Keep each project's manager and worker instructions separate.`,
        );
      if (
        rightPrompts.some((path) => contains(left.physicalDataDir, path)) ||
        leftPrompts.some((path) => contains(right.physicalDataDir, path))
      )
        fail(
          `${pair} place instructions inside the other project's state folder.`,
        );
    }
  }
  return summaries;
}
