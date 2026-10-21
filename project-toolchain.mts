import type { ManagedToolchain } from "./managed-toolchain.mjs";
import type { ExecutionPlan } from "./execution/contracts.mjs";
import { errorCode, isRecord } from "./execution/errors.mjs";
export interface ProjectToolchain extends Omit<ManagedToolchain, "env"> {}
// Issue #1: bounded committed requirements, shared verified tool cache, per-run selection.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, realpath, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  discoverToolRequirements,
  resolveManagedToolchain,
  validateManagedToolchain,
} from "./managed-toolchain.mjs";
const exec = promisify(execFile);
const systemPath =
  "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
export function applyProjectToolchain(
  toolchain: Partial<ManagedToolchain> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!toolchain) return { ...env };
  // Managed tools are launch defaults. Codex configuration and ordinary shell
  // startup may deliberately replace them; never suppress the user's environment.
  const PATH = [
    ...new Set(
      [toolchain.PATH, env.PATH]
        .filter(Boolean)
        .flatMap((value) => (value || "").split(path.delimiter))
        .filter(Boolean),
    ),
  ].join(path.delimiter);
  return { ...env, PATH };
}
export async function resolveProjectToolchain({
  worktree,
  baseCommit,
  plan,
  retained,
  cacheRoot,
  env = process.env,
  install = true,
}: {
  worktree: string;
  baseCommit: string;
  plan: Pick<ExecutionPlan, "sources"> & Record<string, unknown>;
  retained?: ProjectToolchain | null;
  cacheRoot?: string;
  env?: NodeJS.ProcessEnv;
  install?: boolean;
}): Promise<ProjectToolchain> {
  const sources = [];
  const candidates = new Set([
    "package.json",
    ".nvmrc",
    ".node-version",
    ".tool-versions",
    "AGENTS.md",
    "CLAUDE.md",
    ...(plan.sources || [])
      .filter((s) => /\.md$/.test(s.path))
      .map((s) => s.path),
  ]);
  let total = 0;
  for (const file of candidates) {
    if (path.isAbsolute(file) || file.split(/[\\/]/).includes(".."))
      throw new Error("Invalid toolchain source path.");
    let content;
    try {
      content = (
        await exec("git", ["-C", worktree, "show", `${baseCommit}:${file}`], {
          env: { ...env, PATH: systemPath, GIT_OPTIONAL_LOCKS: "0" },
          timeout: 10000,
          maxBuffer: 128 * 1024,
        })
      ).stdout;
    } catch (error) {
      if (
        errorCode(error) === 128 &&
        /does not exist|exists on disk, but not in|Path .* does not exist/i.test(
          String(isRecord(error) ? error.stderr : ""),
        )
      )
        continue;
      throw new Error(
        `Cannot read committed tool requirement source ${file}. Refresh the project plan.`,
      );
    }
    total += Buffer.byteLength(content);
    if (total > 512 * 1024)
      throw new Error(
        "Toolchain requirement discovery exceeds its text limit.",
      );
    // Requirements are pinned to the baseline and must match before executing commands.
    // Ordinary instruction edits after setup are allowed; retained versions stay pinned.
    if (!retained) {
      const target = path.join(worktree, file),
        metadata = await lstat(target);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        (await realpath(target)) !== target ||
        createHash("sha256")
          .update(await readFile(target))
          .digest("hex") !== createHash("sha256").update(content).digest("hex")
      )
        throw new Error(
          `Toolchain source ${file} changed; refresh the plan before starting.`,
        );
    }
    sources.push({ path: file, content });
  }
  const requirements = discoverToolRequirements({ sources });
  if (
    !requirements.node.length &&
    Object.values(plan).some(
      (action) =>
        isRecord(action) &&
        typeof action.command === "string" &&
        /(?:^|[;&|]\s*|\s)(?:node|npm|npx)\s/.test(action.command),
    )
  )
    throw new Error(
      "Project commands require Node/npm but no Node version is declared. Clarify the intended tool requirement before setup.",
    );
  const selected = retained
    ? await validateManagedToolchain(retained, { env })
    : await resolveManagedToolchain({ requirements, cacheRoot, env, install });
  if (
    retained &&
    (selected.nodeVersion !== retained.nodeVersion ||
      selected.npmVersion !== retained.npmVersion ||
      selected.PATH !== retained.PATH)
  )
    throw new Error(
      "Retained toolchain changed or is unavailable. Restore the retained managed tools; no setup was replayed.",
    );
  // Persist tool paths/versions only; never store the inherited application environment.
  const {
    PATH,
    nodeVersion,
    npmVersion,
    nodePath,
    npmPath,
    cacheRoot: root,
  } = selected;
  return {
    PATH,
    nodeVersion,
    npmVersion,
    nodePath,
    npmPath,
    cacheRoot: root,
    requirements,
  };
}
