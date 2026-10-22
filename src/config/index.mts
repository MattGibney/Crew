import { runtimeRoot } from "../shared/paths.mjs";
import { fail, object, text } from "./validation.mjs";
import { validateWorkerEnvironment } from "./environment.mjs";
export { validateWorkerEnvironment } from "./environment.mjs";
import { parseConfig } from "./shape.mjs";
import type { RawConfig, LoadedConfig } from "./contracts.mjs";
import type {
  WorkerEnvironmentConfig,
  SourceEvidence,
} from "../workers/contracts.mjs";
export type { RawConfig, LoadedConfig } from "./contracts.mjs";
import { errorCode, errorMessage } from "../shared/errors.mjs";
// AI-006: one project per portable local instance. This module never reads auth files.
import { access, readFile, stat } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import {
  resolve,
  dirname,
  delimiter,
  isAbsolute,
  join,
  relative,
  sep,
} from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
export const appRoot = runtimeRoot;
// Resource/executable paths stay in runtime/. An extracted source checkout keeps
// its established root-relative config/local.json and legacy fixture state.
const checkoutRoot = resolve(appRoot, "..");
export const configurationRoot =
  existsSync(join(checkoutRoot, "tsconfig.json")) &&
  existsSync(join(checkoutRoot, "config/fixture.example.json"))
    ? checkoutRoot
    : appRoot;
const id = (value: string, label: string) => {
  text(value, label);
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(value))
    fail(
      `${label} must start with a lowercase letter and contain only lowercase letters, digits, _ or - (maximum 64 characters).`,
    );
  return value;
};
const exists = async (path: string) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};
function configPathValue(
  value: string,
  base: string,
  label: string,
  nullable?: false,
): string;
function configPathValue(
  value: string | null,
  base: string,
  label: string,
  nullable: true,
): string | null;
function configPathValue(
  value: string | null,
  base: string,
  label: string,
  nullable = false,
) {
  text(value, label, { nullable });
  if (value === null) return null;
  if (value.startsWith("~") || /\$\{|%[A-Z_]+%/.test(value))
    fail(
      `${label} must use a real path; shell/home substitutions are not expanded.`,
    );
  return resolve(base, value);
}
async function command(
  commandPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) {
  const childEnv = { ...env };
  for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"])
    delete childEnv[key];
  return (
    await run(commandPath, args, {
      env: childEnv,
      timeout: 10000,
      maxBuffer: 65536,
      windowsHide: true,
    })
  ).stdout.trim();
}
async function findOnPath(name: string, env: NodeJS.ProcessEnv) {
  for (const path of String(env.PATH || "")
    .split(delimiter)
    .filter(Boolean)) {
    const candidate = join(path, name);
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {}
  }
  return null;
}
export async function resolveCodexExecutable({
  configured = null,
  base = appRoot,
  env = process.env,
}: {
  configured?: string | null;
  base?: string;
  env?: NodeJS.ProcessEnv;
} = {}) {
  const explicit =
    env.AI_MANAGER_CODEX_BINARY || env.CODEX_BINARY || configured;
  const candidates: string[] = [];
  if (explicit) {
    text(explicit, "runtime.codexBinary");
    const candidate =
      !isAbsolute(explicit) && !explicit.includes("/")
        ? await findOnPath(explicit, env)
        : resolve(base, explicit);
    if (!candidate)
      fail(
        `Codex executable "${explicit}" was not found. Install Codex or set AI_MANAGER_CODEX_BINARY to its executable path.`,
      );
    candidates.push(candidate);
  } else {
    const pathBinary = await findOnPath("codex", env);
    if (pathBinary) candidates.push(pathBinary);
    candidates.push(
      "/Applications/Codex.app/Contents/Resources/codex",
      "/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex",
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
    );
  }
  for (const candidate of [...new Set(candidates)]) {
    try {
      await access(candidate, constants.X_OK);
      const version = await command(candidate, ["--version"], env);
      if (!/^codex(?:-cli)?\s+\S+/i.test(version))
        throw new Error("Unexpected version response.");
      return { executable: candidate, version };
    } catch {
      if (explicit)
        fail(
          `Cannot run configured Codex executable "${candidate}" with --version. Check the path and executable permissions.`,
        );
    }
  }
  fail(
    'Codex was not found. Install the Codex/ChatGPT desktop app or Codex CLI, or set AI_MANAGER_CODEX_BINARY. Authenticate with ChatGPT using "codex login"; do not configure API keys.',
  );
}
export async function loadAppConfig({
  root = configurationRoot,
  configPath = process.env.AI_MANAGER_CONFIG,
  env = process.env,
  checkRuntime = true,
}: {
  root?: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  checkRuntime?: boolean;
} = {}): Promise<LoadedConfig> {
  root = resolve(root);
  const explicitConfig = configPath || env.AI_MANAGER_CONFIG;
  const requestedPath = resolve(root, explicitConfig || "config/local.json");
  const present = await exists(requestedPath);
  if (!present && explicitConfig)
    fail(
      `File not found: ${requestedPath}. Run "node cli.mjs init" or provide an existing --config file.`,
    );
  const sourcePath = present
    ? requestedPath
    : resolve(root, "config/fixture.example.json");
  let raw: RawConfig;
  try {
    raw = parseConfig(await readFile(sourcePath, "utf8"));
  } catch (error) {
    if (errorMessage(error).startsWith("Configuration:")) throw error;
    fail(
      `Cannot read JSON from ${sourcePath}: ${error instanceof SyntaxError ? "invalid JSON" : errorCode(error) || "read failed"}.`,
    );
  }
  object(raw, ["schemaVersion", "runtime", "project"], "root");
  if (raw.schemaVersion !== 1) fail("schemaVersion must be 1.");
  object(raw.runtime, ["port", "codexBinary", "dataDir"], "runtime");
  const portInput = env.AI_MANAGER_PORT || env.VOICE_PORT || raw.runtime.port;
  const port =
    typeof portInput === "string" && /^\d+$/.test(portInput)
      ? Number(portInput)
      : portInput;
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535
  )
    fail("runtime.port must be an integer between 1024 and 65535.");
  text(raw.runtime.codexBinary, "runtime.codexBinary", { nullable: true });
  const base = dirname(sourcePath);
  const dataDir = configPathValue(raw.runtime.dataDir, base, "runtime.dataDir");
  if (
    dataDir === root ||
    dataDir === base ||
    dataDir === dirname(root) ||
    dataDir === dirname(dataDir) ||
    dataDir === homedir()
  )
    fail(
      "runtime.dataDir must be a dedicated state directory, not the app/config directory, filesystem root, home or app parent.",
    );
  const value = raw.project;
  object(
    value,
    [
      "id",
      "name",
      "mode",
      "repositories",
      "context",
      "linear",
      "prompts",
      "worker",
    ],
    "project",
  );
  id(value.id, "project.id");
  text(value.name, "project.name", { max: 200 });
  text(value.context, "project.context");
  if (!["fixture", "repository"].includes(value.mode))
    fail("project.mode must be fixture or repository.");
  if (!Array.isArray(value.repositories) || value.repositories.length > 20)
    fail("project.repositories must be an array of at most 20 entries.");
  const repositoryIds = new Set<string>();
  const repositories = value.repositories.map((repository, index) => {
    const label = `project.repositories[${index}]`;
    object(repository, ["id", "name", "path", "baseRef", "components"], label);
    id(repository.id, `${label}.id`);
    text(repository.name, `${label}.name`, { max: 200 });
    if (repositoryIds.has(repository.id))
      fail(`Duplicate repository ID "${repository.id}".`);
    repositoryIds.add(repository.id);
    text(repository.baseRef, `${label}.baseRef`, { nullable: true, max: 200 });
    if (repository.baseRef?.startsWith("-"))
      fail(`${label}.baseRef must be a Git ref, not a command option.`);
    if (
      !Array.isArray(repository.components) ||
      repository.components.some(
        (item) => typeof item !== "string" || !item.trim(),
      ) ||
      repository.components.length > 100
    )
      fail(`${label}.components must be an array of non-empty strings.`);
    return {
      ...repository,
      path: configPathValue(repository.path, base, `${label}.path`, true),
    };
  });
  if (value.mode === "fixture" && repositories.length)
    fail("Fixture mode must not include business repositories.");
  for (const repository of repositories)
    if (repository.path) {
      const insideRepository = relative(repository.path, dataDir);
      if (
        !insideRepository ||
        (insideRepository !== ".." &&
          !insideRepository.startsWith(`..${sep}`) &&
          !isAbsolute(insideRepository))
      )
        fail(
          "runtime.dataDir must be outside the configured business repositories so execution state is not written into a worktree.",
        );
    }
  object(value.linear, ["teamId", "projectId", "teamKey"], "project.linear");
  for (const key of ["teamId", "projectId", "teamKey"] as const)
    text(value.linear[key], `project.linear.${key}`, {
      nullable: true,
      max: 200,
    });
  if (
    value.linear.teamKey !== null &&
    !/^[A-Z][A-Z0-9]{0,19}$/.test(value.linear.teamKey)
  )
    fail(
      "project.linear.teamKey must be a confirmed uppercase Linear team key, or null.",
    );
  object(value.prompts, ["manager", "worker"], "project.prompts");
  const prompts = { manager: "", worker: "" },
    promptPaths = { manager: "", worker: "" };
  for (const role of ["manager", "worker"] as const) {
    promptPaths[role] = configPathValue(
      value.prompts[role],
      base,
      `project.prompts.${role}`,
    );
    try {
      prompts[role] = text(
        await readFile(promptPaths[role], "utf8"),
        `${role} prompt`,
        { max: 64000 },
      )!;
    } catch (error) {
      if (errorMessage(error).startsWith("Configuration:")) throw error;
      fail(
        `Cannot read ${role} prompt at ${promptPaths[role]} (${errorCode(error) || "read failed"}).`,
      );
    }
  }
  object(
    value.worker,
    ["sandbox", "timeoutMs", "maxConcurrent", "environment"],
    "project.worker",
  );
  if (!["read-only", "workspace-write"].includes(value.worker.sandbox))
    fail("project.worker.sandbox must be read-only or workspace-write.");
  if (value.mode === "fixture" && value.worker.sandbox !== "read-only")
    fail("Fixture workers must remain read-only.");
  if (
    !Number.isInteger(value.worker.timeoutMs) ||
    value.worker.timeoutMs < 10000 ||
    value.worker.timeoutMs > 86400000
  )
    fail(
      "project.worker.timeoutMs must be between 10000 and 86400000 milliseconds.",
    );
  const maxConcurrent =
    value.worker.maxConcurrent === undefined ? 2 : value.worker.maxConcurrent;
  if (
    !Number.isInteger(maxConcurrent) ||
    maxConcurrent < 1 ||
    maxConcurrent > 8
  )
    fail("project.worker.maxConcurrent must be an integer between 1 and 8.");
  const environment = validateWorkerEnvironment(value.worker.environment, {
    mode: value.mode,
  });
  // No configured hooks means no application runtime/readiness verification is promised.
  const worker = { ...value.worker, maxConcurrent, environment };
  if (Number(process.versions.node.split(".")[0]) < 22)
    fail("Node.js 22 or newer is required.");
  const { executable, version: codexVersion } = checkRuntime
    ? await resolveCodexExecutable({
        configured: raw.runtime.codexBinary,
        base,
        env,
      })
    : { executable: null, version: null };
  let gitVersion;
  if (checkRuntime) {
    try {
      gitVersion = await command("git", ["--version"], env);
    } catch {
      fail(
        "Git is required and must be available on PATH. On macOS install the Command Line Tools or Git.",
      );
    }
  }
  const issues = [];
  if (value.mode === "repository") {
    if (!repositories.length)
      issues.push("Configure at least one project repository.");
    if (!value.linear.teamId)
      issues.push(
        "Confirm and set project.linear.teamId from the intended Linear workspace.",
      );
    if (!value.linear.teamKey)
      issues.push("Confirm and set project.linear.teamKey.");
    for (const repository of repositories) {
      if (!repository.path)
        issues.push(`Set the local path for repository "${repository.id}".`);
      if (!repository.baseRef)
        issues.push(
          `Set an explicit baseRef for repository "${repository.id}".`,
        );
      if (repository.path) {
        try {
          await command(
            "git",
            ["-C", repository.path, "rev-parse", "--show-toplevel"],
            env,
          );
          if (repository.baseRef)
            await command(
              "git",
              [
                "-C",
                repository.path,
                "rev-parse",
                "--verify",
                `${repository.baseRef}^{commit}`,
              ],
              env,
            );
        } catch {
          issues.push(
            `Repository "${repository.id}" is unavailable or its baseRef does not resolve to a commit. Check the path and fetch the intended ref.`,
          );
        }
      }
    }
  }
  const project = {
    ...value,
    worker,
    repositories,
    readiness: { ready: !issues.length, issues },
  };
  const legacyState =
    !present &&
    value.mode === "fixture" &&
    (await exists(resolve(root, ".orchestration"))) &&
    (await exists(resolve(root, ".voice-chat.json")));
  return {
    configPath: present ? requestedPath : null,
    sourceConfigPath: sourcePath,
    port,
    executable,
    dataDir,
    project,
    activeProject: project,
    projectStateDir: legacyState
      ? resolve(root, ".orchestration")
      : resolve(dataDir, "orchestration"),
    managerStatePath: legacyState
      ? resolve(root, ".voice-chat.json")
      : resolve(dataDir, "manager-chat.json"),
    serverStatePath: resolve(dataDir, "server.json"),
    managerPrompt: prompts.manager,
    workerPrompt: prompts.worker,
    promptPaths,
    legacyState,
    runtime: { nodeVersion: process.version, gitVersion, codexVersion },
  };
}
