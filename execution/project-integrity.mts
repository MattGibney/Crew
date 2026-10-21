import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, realpath, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type {
  ExecutionPlan,
  ExecutionPhase,
  ScriptAction,
} from "./contracts.mjs";
import { errorCode } from "./errors.mjs";
const exec = promisify(execFile);
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export async function verifyProjectWorktree({
  worktree,
  repositoryPath,
  baseCommit,
}: {
  worktree: string;
  repositoryPath: string;
  baseCommit: string;
}) {
  let actual;
  try {
    actual = await realpath(worktree);
  } catch (error) {
    if (errorCode(error) === "ENOENT")
      throw new Error(
        "Retained worktree is missing. Ask the manager to review missing-worktree recovery; cleanup is not verified.",
      );
    throw error;
  }
  const repo = await realpath(repositoryPath);
  if (actual === repo)
    throw new Error(
      "Project execution requires a separate registered Git worktree.",
    );
  const git = async (args: string[]) =>
    (
      await exec("git", ["-C", actual, ...args], {
        timeout: 10000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      })
    ).stdout.trim();
  if ((await realpath(await git(["rev-parse", "--show-toplevel"]))) !== actual)
    throw new Error("Worker Git root does not match its retained worktree.");
  if ((await git(["rev-parse", "HEAD"])) !== baseCommit)
    throw new Error("Worker baseline commit does not match its retained task.");
  const { stdout } = await exec(
    "git",
    ["-C", repo, "worktree", "list", "--porcelain", "-z"],
    { timeout: 10000, maxBuffer: 1024 * 1024 },
  );
  if (!stdout.split("\0").some((field) => field === `worktree ${actual}`))
    throw new Error("Worker worktree is not registered to this repository.");
  return actual;
}
export function assertPlan(plan: ExecutionPlan) {
  if (
    plan?.schemaVersion !== 1 ||
    !Array.isArray(plan.sources) ||
    !plan.sources.length
  )
    throw new Error("A source-backed project execution plan is required.");
  for (const phase of [
    "setup",
    "start",
    "resume",
    "ready",
    "stop",
    "teardown",
  ] as const) {
    const action = plan[phase];
    if (action === null || action === undefined) continue;
    if (
      typeof action.command !== "string" ||
      !action.command.trim() ||
      action.command.includes("\0") ||
      !Number.isInteger(action.timeoutMs) ||
      action.timeoutMs < 1000 ||
      action.timeoutMs > 600000
    )
      throw new Error(`Invalid project ${phase} action.`);
  }
}
export async function verifySources(
  worktree: string,
  baseCommit: string,
  plan: ExecutionPlan,
  phases?: ExecutionPhase[],
) {
  assertPlan(plan);
  for (const source of (
    phases || ["setup", "start", "resume", "ready", "stop", "teardown"]
  )
    .map((p) => plan[p])
    .filter((action): action is ScriptAction => Boolean(action))
    .map((action) => action.source)) {
    if (
      !source ||
      typeof source.path !== "string" ||
      path.isAbsolute(source.path) ||
      source.path.split(/[\\/]/).includes("..") ||
      !source.path ||
      source.path.includes("\0") ||
      !/^[a-f0-9]{64}$/.test(source.sha256 || "")
    )
      throw new Error("Invalid project script source evidence.");
    const target = await realpath(path.join(worktree, source.path)),
      inside = path.relative(worktree, target);
    if (
      !inside ||
      inside.startsWith(`..${path.sep}`) ||
      path.isAbsolute(inside)
    )
      throw new Error("Project script source escapes its worktree.");
    const { stdout } = await exec(
      "git",
      ["-C", worktree, "show", `${baseCommit}:${source.path}`],
      { encoding: "buffer", timeout: 10000, maxBuffer: 1024 * 1024 },
    );
    if (
      digest(stdout) !== source.sha256 ||
      digest(await readFile(target)) !== source.sha256
    )
      throw new Error(
        "Project script sources changed. Refresh the execution plan before starting this worker.",
      );
  }
}
export async function verifyPermissionsSource(
  repositoryPath: string,
  plan: ExecutionPlan,
) {
  if (!plan.permissionsSource) return;
  const source = plan.permissionsSource,
    repo = await realpath(repositoryPath),
    expected = path.join(repo, ".codex", "config.toml");
  if (
    typeof source.path !== "string" ||
    !path.isAbsolute(source.path) ||
    source.path !== expected ||
    !/^[a-f0-9]{64}$/.test(source.sha256 || "")
  )
    throw new Error(
      "Project permission source must be its own local .codex/config.toml.",
    );
  const metadata = await lstat(expected);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 262144)
    throw new Error(
      "Project permission source must be a bounded regular local file.",
    );
  const actual = await realpath(expected),
    inside = path.relative(repo, actual);
  if (
    actual !== expected ||
    inside.startsWith(`..${path.sep}`) ||
    path.isAbsolute(inside) ||
    digest(await readFile(actual)) !== source.sha256
  )
    throw new Error(
      "Project Codex permissions changed. Refresh project settings before launching a worker.",
    );
}
