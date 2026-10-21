// Generic worker placement: keep new checkout paths compact when private state has spaces.
// Existing recorded checkouts are never moved. Only this instance's namespace or legacy root is allowed.
import { realpath, mkdir, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { errorCode } from "./execution/errors.mjs";
interface RootOptions {
  home?: string;
}
interface WorktreeLocation {
  worktreeRoot?: string | null;
  worktree?: string | null;
}
async function existsMetadata(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}
export async function worktreeRoots(
  stateDir: string,
  { home = homedir() }: RootOptions = {},
) {
  const canonicalState = await realpath(stateDir),
    canonicalHome = await realpath(home),
    legacy = path.resolve(stateDir, "worktrees");
  const compact = path.join(
    canonicalHome,
    ".crew",
    "worktrees",
    createHash("sha256").update(canonicalState).digest("hex").slice(0, 24),
  );
  return {
    legacy,
    canonicalLegacy: path.join(canonicalState, "worktrees"),
    compact,
    compactParents: [
      path.join(canonicalHome, ".crew"),
      path.join(canonicalHome, ".crew", "worktrees"),
      compact,
    ],
    preferred:
      /\s/.test(path.join(canonicalState, "worktrees")) && !/\s/.test(compact)
        ? compact
        : legacy,
  };
}
export async function selectWorktreeRoot(
  stateDir: string,
  task: WorktreeLocation = {},
  options?: RootOptions,
) {
  const roots = await worktreeRoots(stateDir, options),
    selected =
      task.worktreeRoot ||
      (task.worktree ? path.dirname(task.worktree) : roots.preferred);
  if (typeof selected !== "string" || !path.isAbsolute(selected))
    throw new Error(
      "Invalid recorded worker checkout root; no worktree was changed.",
    );
  const candidate = path.resolve(selected),
    metadata = await existsMetadata(candidate);
  if (metadata?.isSymbolicLink())
    throw new Error(
      "Worker checkout root is a symbolic link; no worktree was changed.",
    );
  const canonical = metadata ? await realpath(candidate) : candidate;
  if (![roots.legacy, roots.canonicalLegacy, roots.compact].includes(canonical))
    throw new Error(
      "Worker checkout root does not belong to this instance; no worktree was changed.",
    );
  // Detect symlinked compact ancestors even if the final namespace is not created yet.
  if (candidate === roots.compact)
    for (const parent of roots.compactParents) {
      const value = await existsMetadata(parent);
      if (value?.isSymbolicLink() || (value && !value.isDirectory()))
        throw new Error(
          "Private worker checkout namespace contains a link or non-directory.",
        );
    }
  return candidate;
}
export async function ensureWorktreeRoot(
  stateDir: string,
  selected: string,
  options?: RootOptions,
) {
  const root = await selectWorktreeRoot(
      stateDir,
      { worktreeRoot: selected },
      options,
    ),
    roots = await worktreeRoots(stateDir, options);
  const directories = root === roots.compact ? roots.compactParents : [root];
  for (const directory of directories) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory())
      throw new Error(
        "Worker checkout namespace changed; refusing to follow it.",
      );
  }
  const canonical = await realpath(root);
  if (![roots.canonicalLegacy, roots.compact].includes(canonical))
    throw new Error("Worker checkout namespace escaped its owning instance.");
  return root;
}
