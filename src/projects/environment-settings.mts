import type {
  WorkerEnvironmentConfig,
  Project,
} from "../workers/contracts.mjs";
import type { Stats } from "node:fs";
import { isRecord, errorCode } from "../workers/errors.mjs";
interface ConfigurationInput {
  configPath?: string | null;
  dataDir?: string;
  project?: {
    id?: string;
    mode?: "fixture" | "repository";
    repositories?: unknown;
    worker?: { environment?: unknown };
  } | null;
  activeProject?: ConfigurationInput["project"];
}
// GitHub #45: edits only Crew's saved command snapshot; never executes project tooling.
import { lstat, realpath, open, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { validateWorkerEnvironment } from "../config/index.mjs";

const saves = new Map<string, Promise<unknown>>();
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const same = isDeepStrictEqual;
function failure(message: string): never {
  throw new Error(message);
}
function serialize<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const result = (saves.get(file) || Promise.resolve()).then(operation);
  const settled = result.catch(() => {});
  saves.set(file, settled);
  void settled.then(() => {
    if (saves.get(file) === settled) saves.delete(file);
  });
  return result;
}
function protectMetadata(
  previous: WorkerEnvironmentConfig,
  next: WorkerEnvironmentConfig,
) {
  const oldPlan = previous.executionPlan,
    newPlan = next.executionPlan;
  if (!!oldPlan !== !!newPlan)
    failure(
      "Keep the configured environment format; changing project setup provenance requires project setup.",
    );
  if (!oldPlan) return;
  if (!newPlan) failure("Keep the configured environment format.");
  if (!same(oldPlan.env, newPlan.env))
    failure(
      "The legacy PATH snapshot is retained for compatibility and cannot be edited here; normal toolchain and inherited environment settings remain in effect.",
    );
  for (const field of [
    "schemaVersion",
    "sources",
    "networkAccess",
    "permissionsSource",
  ] as const) {
    if (!same(oldPlan[field], newPlan[field]))
      failure(
        `Execution ${field} is supplied by project setup and cannot be changed here.`,
      );
  }
}
export async function createEnvironmentSettings({
  configuration,
}: {
  configuration?: ConfigurationInput;
}) {
  if (!configuration?.configPath) {
    const environment = validateWorkerEnvironment(
      (configuration?.project || configuration?.activeProject)?.worker
        ?.environment,
      {
        mode:
          (configuration?.project || configuration?.activeProject)?.mode ||
          "fixture",
      },
    );
    return {
      read: async () => ({
        available: false,
        environment: structuredClone(environment),
        revision: null,
        configPath: null,
        detail: "Save project setup before editing its environment.",
      }),
      save: async () =>
        failure("Save project setup before editing its environment."),
    };
  }
  const configPath = resolve(configuration.configPath);
  const project = configuration.project || configuration.activeProject;
  if (
    !project ||
    !project.id ||
    !project.mode ||
    !["repository", "fixture"].includes(project.mode)
  )
    failure("A valid project identity is required.");
  const projectId = project.id,
    projectMode = project.mode,
    projectRepositories = project.repositories,
    dataDir = configuration.dataDir;
  const parentPath = await realpath(dirname(configPath));
  let observed: { revision: string; ino: number; dev: number } | undefined;
  async function load() {
    if ((await realpath(dirname(configPath))) !== parentPath)
      failure("The configuration folder changed; reload project setup.");
    const before = await lstat(configPath);
    if (!before.isFile() || before.isSymbolicLink())
      failure(
        "The configuration must be an existing regular file, not a symbolic link.",
      );
    const handle = await open(
      configPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const identity = await handle.stat();
      if (identity.ino !== before.ino || identity.dev !== before.dev)
        failure(
          "The configuration file changed while reading; reload before saving.",
        );
      const bytes = await handle.readFile("utf8");
      const after = await lstat(configPath);
      if (
        identity.ino !== after.ino ||
        identity.dev !== after.dev ||
        after.isSymbolicLink()
      )
        failure(
          "The configuration file changed while reading; reload before saving.",
        );
      let rawValue: unknown;
      try {
        rawValue = JSON.parse(bytes);
      } catch {
        failure(
          "The saved configuration is invalid JSON; existing settings have been preserved.",
        );
      }
      if (
        !isRecord(rawValue) ||
        !isRecord(rawValue.project) ||
        !isRecord(rawValue.project.worker)
      )
        failure("The saved project identity changed; reload project setup.");
      const raw: Record<string, unknown> & {
        project: Record<string, unknown> & { worker: Record<string, unknown> };
        runtime: Record<string, unknown>;
      } = {
        ...rawValue,
        project: {
          ...rawValue.project,
          worker: { ...rawValue.project.worker },
        },
        runtime: isRecord(rawValue.runtime) ? rawValue.runtime : {},
      };
      if (
        raw.schemaVersion !== 1 ||
        !raw.project.worker ||
        raw.project.id !== projectId ||
        raw.project.mode !== projectMode
      )
        failure("The saved project identity changed; reload project setup.");
      if (
        dataDir !== undefined &&
        (typeof raw.runtime?.dataDir !== "string" ||
          resolve(dirname(configPath), raw.runtime.dataDir) !==
            resolve(dataDir))
      )
        failure(
          "The saved project state directory changed; restart with the reviewed project setup before editing its environment.",
        );
      if (projectRepositories !== undefined) {
        const identities = (repositories: unknown) =>
          Array.isArray(repositories)
            ? repositories.map((repository) => {
                if (!isRecord(repository)) return null;
                return {
                  id: repository.id,
                  path:
                    repository.path === null
                      ? null
                      : typeof repository.path === "string"
                        ? resolve(dirname(configPath), repository.path)
                        : undefined,
                  baseRef: repository.baseRef,
                };
              })
            : null;
        if (
          !isDeepStrictEqual(
            identities(raw.project.repositories),
            identities(projectRepositories),
          )
        )
          failure(
            "The saved repository identity changed; restart with the reviewed project setup before editing its environment.",
          );
      }
      const environment = validateWorkerEnvironment(
        raw.project.worker.environment,
        { mode: projectMode },
      );
      return { raw, bytes, revision: hash(bytes), environment, identity };
    } finally {
      await handle.close();
    }
  }
  function view(current: Awaited<ReturnType<typeof load>>) {
    const plan = current.environment.executionPlan;
    return {
      available: true,
      revision: current.revision,
      environment: structuredClone(current.environment),
      configPath,
      provenance: {
        kind: "crew-config-snapshot",
        description:
          "Commands are saved in Crew configuration. Project source files and normal Codex configuration are not edited. Source references identify the project setup snapshot; edited commands are Crew overrides, not a claim that project files contain those commands.",
        sources: structuredClone(plan?.sources || []),
        permissionsSource: structuredClone(plan?.permissionsSource || null),
      },
    };
  }
  async function read() {
    const current = await load();
    observed = {
      revision: current.revision,
      ino: current.identity.ino,
      dev: current.identity.dev,
    };
    return view(current);
  }
  async function save(input: unknown) {
    if (
      !isRecord(input) ||
      Object.keys(input).some(
        (key) => !["expectedRevision", "environment"].includes(key),
      ) ||
      typeof input.expectedRevision !== "string" ||
      !input.environment
    )
      failure("A current revision and environment settings are required.");
    // Validation is pure: no runtime resolution, Git, shell, worker or project commands.
    const environment = validateWorkerEnvironment(input.environment, {
      mode: projectMode,
    });
    return serialize(configPath, async () => {
      const current = await load();
      if (current.revision !== input.expectedRevision)
        failure(
          "Environment settings changed elsewhere; reload before saving.",
        );
      if (
        observed?.revision === current.revision &&
        (observed.ino !== current.identity.ino ||
          observed.dev !== current.identity.dev)
      )
        failure("The configuration file was replaced; reload before saving.");
      protectMetadata(current.environment, environment);
      const raw = structuredClone(current.raw);
      raw.project.worker.environment = environment;
      const bytes = JSON.stringify(raw, null, 2) + "\n";
      const temporary = `${configPath}.${randomUUID()}.tmp`;
      try {
        const handle = await open(
          temporary,
          "wx",
          current.identity.mode & 0o777,
        );
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        const latest = await load();
        if (
          latest.revision !== current.revision ||
          latest.identity.ino !== current.identity.ino ||
          latest.identity.dev !== current.identity.dev
        )
          failure(
            "Environment settings changed while saving; reload before saving.",
          );
        await rename(temporary, configPath);
      } finally {
        await unlink(temporary).catch((error) => {
          if (errorCode(error) !== "ENOENT") throw error;
        });
      }
      return read();
    });
  }
  await load();
  return { read, save };
}
