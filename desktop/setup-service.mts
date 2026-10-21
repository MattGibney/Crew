import { discoverProjectExecutionPlan } from "../project-execution-plan.mjs";
import { resolveManagedToolchain } from "../managed-toolchain.mjs";
// Bounded local runtime/account checks. Linear reads live separately in project-options.mjs.
import {
  readFile,
  writeFile,
  rename,
  unlink,
  mkdir,
  access,
  stat,
  open,
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseConfig } from "../config/shape.mjs";
import type { RawConfig } from "../config/contracts.mjs";
import { errorCode } from "./validation.mjs";
export { probeCodex } from "./setup-account.mjs";
export interface SetupContext {
  root: string;
  configPath: string;
  env?: NodeJS.ProcessEnv;
}
export interface SetupCheck {
  status: string;
  detail: string;
  path?: string;
  mode?: string;
  servers?: Array<{
    name: string;
    status: string;
    auth: string;
    tools: string[];
  }>;
  truncated?: boolean;
  linear?: { status: string; detail: string };
}
export interface SetupPathCheck {
  name: string;
  status: string;
  detail: string;
}
export interface SetupChecks {
  auth?: SetupCheck;
  project?: SetupCheck;
  voices?: SetupCheck;
  protocol?: SetupCheck;
  tools?: SetupCheck;
  paths?: SetupPathCheck[];
  [key: string]: SetupCheck | SetupPathCheck[] | undefined;
}

import { loadAppConfig, resolveCodexExecutable } from "../config.mjs";
import { safeError } from "../codex-bridge.mjs";
const run = promisify(execFile);
export const fingerprint = (raw: string | Buffer) =>
  createHash("sha256").update(raw).digest("hex");
export async function readSetupConfig(configPath: string) {
  const source = await readFile(configPath, "utf8");
  return {
    config: parseConfig(source),
    revision: fingerprint(source),
    configPath,
  };
}
export function saveSetupConfig(
  options: SetupContext & { input: RawConfig; revision: string; dryRun: true },
): Promise<{ issues: string[] }>;
export function saveSetupConfig(
  options: SetupContext & {
    input: RawConfig;
    revision: string;
    dryRun?: false;
  },
): Promise<{
  config: RawConfig;
  revision: string;
  configPath: string;
  issues: string[];
}>;
export async function saveSetupConfig({
  root,
  configPath,
  input,
  revision,
  env,
  dryRun = false,
}: SetupContext & { input: RawConfig; revision: string; dryRun?: boolean }) {
  if (!input || JSON.stringify(input).length > 70000)
    throw new Error("Configuration is too large or missing.");
  const existing = await readSetupConfig(configPath);
  if (existing.revision !== revision)
    throw new Error(
      "Configuration changed elsewhere. Reload setup before saving; nothing was overwritten.",
    );
  // Draft validation does not depend on Codex already being installed. Prompts must exist.
  const temporary = join(dirname(configPath), `.setup-${randomUUID()}.json`);
  try {
    await writeFile(temporary, `${JSON.stringify(input, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    const candidate = await loadAppConfig({
      root,
      configPath: temporary,
      env,
      checkRuntime: false,
    });
    const currentData = resolve(
      dirname(configPath),
      existing.config.runtime.dataDir,
    );
    let hasState = false;
    for (const name of [
      "manager-chat.json",
      "orchestration/instance-project.json",
    ]) {
      try {
        await access(join(currentData, name));
        hasState = true;
      } catch {}
    }
    if (
      hasState &&
      (input.project.id !== existing.config.project.id ||
        candidate.dataDir !== currentData)
    )
      throw new Error(
        "This instance already has durable state. Keep its project ID and state folder; use a separate configured instance for another project.",
      );
    if ((await readSetupConfig(configPath)).revision !== revision)
      throw new Error(
        "Configuration changed during validation. Reload before saving.",
      );
    if (dryRun) return { issues: candidate.project.readiness.issues };
    await writeFile(
      `${configPath}.before-setup.json`,
      `${JSON.stringify(existing.config, null, 2)}\n`,
      { mode: 0o600 },
    );
    await rename(temporary, configPath);
    return {
      ...(await readSetupConfig(configPath)),
      issues: candidate.project.readiness.issues,
    };
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
export async function checkLocalRuntime({
  root,
  configPath,
  env,
}: SetupContext) {
  const raw = await readSetupConfig(configPath);
  const checks: Record<string, SetupCheck> = {};
  let executable;
  try {
    const found = await resolveCodexExecutable({
      configured: raw.config.runtime.codexBinary,
      base: dirname(configPath),
      env,
    });
    executable = found.executable;
    checks.codex = {
      status: "verified",
      detail: found.version,
      path: executable,
    };
  } catch (error) {
    checks.codex = { status: "unavailable", detail: safeError(error) };
  }
  try {
    const r = await run("git", ["--version"], {
      env,
      timeout: 10000,
      maxBuffer: 65536,
    });
    checks.git = { status: "verified", detail: r.stdout.trim() };
  } catch {
    checks.git = {
      status: "unavailable",
      detail:
        "Install Git or the macOS Command Line Tools, then retry. Git must be on PATH.",
    };
  }
  try {
    const loaded = await loadAppConfig({
      root,
      configPath,
      env,
      checkRuntime: false,
    });
    checks.project = {
      status: loaded.project.readiness.ready ? "configured" : "incomplete",
      detail:
        loaded.project.readiness.issues.join(" ") ||
        "Local project paths, refs and prompt files are configured. External ticket access has not been proven.",
      mode: loaded.project.mode,
    };
    if (loaded.project.mode === "repository") {
      for (const repo of loaded.project.repositories) {
        try {
          const found = await discoverProjectExecutionPlan({
            path: repo.path || undefined,
            ref: repo.baseRef || undefined,
            env,
          });
          if (found.toolchainError) throw new Error(found.toolchainError);
          const tools = await resolveManagedToolchain({
            requirements: found.toolchain,
            env,
            install: false,
          });
          checks[`toolchain_${repo.id}`] = {
            status: "verified",
            detail: tools.nodeVersion
              ? `Managed Node ${tools.nodeVersion}, npm ${tools.npmVersion}. Project commands have not run.`
              : "No Node/npm requirement declared; system utilities only.",
          };
        } catch (error) {
          checks[`toolchain_${repo.id}`] = {
            status: "unavailable",
            detail:
              safeError(error) +
              " Required managed tools install on first authorized worker launch, before project setup.",
          };
        }
      }
    }
  } catch (error) {
    checks.project = { status: "invalid", detail: safeError(error) };
  }
  return { checks, executable, revision: raw.revision };
}
export async function probePaths({ root, configPath, env }: SetupContext) {
  const c = await loadAppConfig({ root, configPath, env, checkRuntime: false });
  const results: SetupPathCheck[] = [];
  for (const repo of c.project.repositories) {
    if (!repo.path) {
      results.push({
        name: repo.name,
        status: "unconfigured",
        detail: "Choose the local repository folder.",
      });
      continue;
    }
    try {
      await access(repo.path, constants.R_OK | constants.X_OK);
      results.push({
        name: `${repo.name}: folder`,
        status: "verified",
        detail:
          "Readable by this packaged process. This does not prove worker sandbox access.",
      });
    } catch (error) {
      results.push({
        name: `${repo.name}: folder`,
        status: ["EACCES", "EPERM"].includes(errorCode(error) || "")
          ? "denied"
          : "unavailable",
        detail:
          "This process cannot read the selected folder. Choose the correct folder and review macOS Files and Folders access, then retry.",
      });
      continue;
    }
    if (!repo.baseRef) {
      results.push({
        name: `${repo.name}: base ref`,
        status: "unconfigured",
        detail:
          "Folder is readable, but a committed base ref has not been selected.",
      });
      continue;
    }
    try {
      const r = await run(
        "git",
        ["-C", repo.path, "rev-parse", "--verify", `${repo.baseRef}^{commit}`],
        { env, timeout: 10000, maxBuffer: 65536 },
      );
      results.push({
        name: `${repo.name}: base ref`,
        status: "verified",
        detail: `Ref resolves to ${r.stdout.trim().slice(0, 12)}. Worker sandbox access still needs a bounded task.`,
      });
    } catch {
      results.push({
        name: `${repo.name}: base ref`,
        status: "unavailable",
        detail:
          "The committed ref did not resolve. Check the Git repository and ref; this is not proof of an OS permission denial.",
      });
    }
  }
  try {
    await mkdir(c.dataDir, { recursive: true, mode: 0o700 });
    const p = join(c.dataDir, `.setup-access-${randomUUID()}`);
    const fd = await open(p, "wx", 0o600);
    await fd.close();
    await unlink(p);
    results.push({
      name: "Instance state folder",
      status: "verified",
      detail: "A temporary write/readiness probe succeeded and was removed.",
    });
  } catch {
    results.push({
      name: "Instance state folder",
      status: "denied",
      detail:
        "Cannot write instance state. Choose a dedicated writable folder and retry.",
    });
  }
  for (const [role, p] of Object.entries(c.promptPaths)) {
    try {
      if (!(await stat(p)).isFile()) throw Error();
      await access(p, constants.R_OK);
      results.push({ name: `${role} prompt`, status: "verified", detail: p });
    } catch {
      results.push({
        name: `${role} prompt`,
        status: "denied",
        detail: "Prompt file is not readable.",
      });
    }
  }
  return results;
}
// Bind readiness evidence to config and editable prompt bytes; never persist those bytes here.
export async function setupInputsKey(configPath: string) {
  const saved = await readSetupConfig(configPath),
    parts = [saved.revision];
  for (const role of ["manager", "worker"] as const) {
    try {
      parts.push(
        await readFile(
          resolve(dirname(configPath), saved.config.project.prompts[role]),
          "utf8",
        ),
      );
    } catch (error) {
      parts.push(`${role}:${errorCode(error) || "unreadable"}`);
    }
  }
  return fingerprint(JSON.stringify(parts));
}
// Automatic analyzed setup apply: new prompt files first, validated atomic config pointer last.
export async function applyDiscoveryDraft({
  root,
  configPath,
  env,
  revision,
  config,
  managerDraft,
  workerDraft,
  promptDirectory,
}: SetupContext & {
  revision: string;
  config: RawConfig;
  managerDraft: string;
  workerDraft: string;
  promptDirectory: string;
}) {
  if (
    typeof managerDraft !== "string" ||
    typeof workerDraft !== "string" ||
    managerDraft.length > 64000 ||
    workerDraft.length > 64000 ||
    !managerDraft.trim() ||
    !workerDraft.trim()
  )
    throw new Error(
      "Project instructions are missing or too large. Retry project setup.",
    );
  const expected = {
    manager: join(promptDirectory, "manager.md"),
    worker: join(promptDirectory, "worker.md"),
  };
  if (
    config?.project?.prompts?.manager !== expected.manager ||
    config?.project?.prompts?.worker !== expected.worker
  )
    throw new Error(
      "The generated instruction-file locations changed. Retry project setup; advanced settings can select existing files later.",
    );
  const target = resolve(dirname(configPath), promptDirectory);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  // New directory only: an existing prompt cannot be silently overwritten.
  await mkdir(target, { mode: 0o700 });
  let committed = false;
  try {
    await writeFile(join(target, "manager.md"), managerDraft, {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(join(target, "worker.md"), workerDraft, {
      flag: "wx",
      mode: 0o600,
    });
    const result = await saveSetupConfig({
      root,
      configPath,
      env,
      input: config,
      revision,
    });
    committed = true;
    return result;
  } finally {
    if (!committed) {
      await unlink(join(target, "manager.md")).catch(() => {});
      await unlink(join(target, "worker.md")).catch(() => {});
      const { rmdir } = await import("node:fs/promises");
      await rmdir(target).catch(() => {});
    }
  }
}
export async function requestMicrophonePermission({
  getStatus,
  ask,
}: {
  getStatus: () => string;
  ask: () => Promise<boolean>;
}) {
  const before = getStatus();
  // Denied/restricted/unknown must go to recovery, never a repeated/blind OS prompt.
  if (before === "not-determined") await ask();
  const after = getStatus();
  return ["granted", "denied", "restricted", "not-determined"].includes(after)
    ? after
    : "unknown";
}
