import type { SourceEvidence } from "./execution/contracts.mjs";
import type { ToolRequirements } from "./execution/tool-requirements.mjs";
import { errorCode, errorMessage } from "./execution/errors.mjs";
export interface DiscoveredAction {
  command: string;
  name?: string;
  role: string | null;
  source: SourceEvidence;
}
export interface DiscoveredExecutionPlan {
  schemaVersion: number;
  status: string;
  repository: { path: string; ref: string; commit: string };
  networkAccess: boolean | null;
  localPermissions: {
    networkAccess: boolean | null;
    source: SourceEvidence | null;
  };
  sources: SourceEvidence[];
  setup: DiscoveredAction | null;
  actions: DiscoveredAction[];
  instructions: { path: string; sha256?: string; content: string }[];
  issues: { path: string; detail: string }[];
  toolchain?: ToolRequirements;
  toolchainError?: string;
}
// Read committed project instructions and commands; never run project commands.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, lstat, open } from "node:fs/promises";
import { constants } from "node:fs";
import { posix, resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { discoverToolRequirements } from "./managed-toolchain.mjs";

const run = promisify(execFile);
const FILE_LIMIT = 128 * 1024;
const TOTAL_LIMIT = 512 * 1024;
const SOURCE_LIMIT = 20;
const digest = (content: string | Buffer) =>
  createHash("sha256").update(content).digest("hex");

import {
  parseProjectEnvironmentToml,
  parseProjectNetworkAccess,
} from "./execution/project-toml.mjs";
export {
  parseProjectEnvironmentToml,
  parseProjectNetworkAccess,
} from "./execution/project-toml.mjs";
export async function discoverProjectExecutionPlan({
  path,
  ref,
  environmentPath,
  env = process.env,
}: {
  path?: string;
  ref?: string;
  environmentPath?: string | null;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<DiscoveredExecutionPlan> {
  if (typeof path !== "string" || !path.trim() || path.includes("\0"))
    throw new Error("Choose a local Git repository.");
  if (
    typeof ref !== "string" ||
    !ref.trim() ||
    ref.startsWith("-") ||
    /[\u0000-\u001f\u007f]/.test(ref) ||
    ref.length > 1024
  ) {
    throw new Error("Choose an existing committed starting reference.");
  }
  const selected = await realpath(resolve(path));
  const git = async (args: string[], maxBuffer = TOTAL_LIMIT) =>
    (
      await run("git", ["-C", selected, ...args], {
        env: { ...env, GIT_OPTIONAL_LOCKS: "0" },
        timeout: 10000,
        maxBuffer,
        encoding: "buffer",
      })
    ).stdout;
  let repositoryPath, commit;
  try {
    repositoryPath = await realpath(
      (await git(["rev-parse", "--show-toplevel"])).toString().trim(),
    );
    commit = (
      await git([
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${ref}^{commit}`,
      ])
    )
      .toString()
      .trim();
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error();
  } catch {
    throw new Error(
      "The selected repository or committed starting reference is unavailable.",
    );
  }
  const plan: DiscoveredExecutionPlan = {
    schemaVersion: 1,
    status: "incomplete",
    repository: { path: repositoryPath, ref, commit },
    networkAccess: null,
    localPermissions: { networkAccess: null, source: null },
    sources: [],
    setup: null,
    actions: [],
    instructions: [],
    issues: [],
  };
  const issueKeys = new Set();
  const issue = (file: string, detail: string) => {
    const key = `${file}\0${detail}`;
    if (issueKeys.has(key) || plan.issues.length >= 32) return;
    issueKeys.add(key);
    plan.issues.push({ path: file, detail });
  };
  const listing = (
    await git(
      ["ls-tree", "--full-tree", "-r", "-z", "--long", commit],
      8 * 1024 * 1024,
    )
  ).toString();
  const files = new Map<string, { mode: string; size: number; blob: string }>();
  for (const record of listing.split("\0")) {
    const match = /^(\d+) blob ([a-f0-9]+)\s+(\d+)\t([\s\S]+)$/.exec(record);
    if (match)
      files.set(match[4], {
        mode: match[1],
        size: Number(match[3]),
        blob: match[2],
      });
  }
  let bytes = 0;
  async function read(file: string, kind: string) {
    const entry = files.get(file);
    if (!entry) return null;
    if (!["100644", "100755"].includes(entry.mode)) {
      issue(
        file,
        "Only committed regular files can supply instructions or commands.",
      );
      return null;
    }
    if (
      entry.size > FILE_LIMIT ||
      bytes + entry.size > TOTAL_LIMIT ||
      plan.sources.length >= SOURCE_LIMIT
    ) {
      issue(
        file,
        "Discovery text limit reached. Review this source separately.",
      );
      return null;
    }
    const raw = await git(["cat-file", "blob", entry.blob], FILE_LIMIT + 1024);
    const content = raw.toString("utf8");
    if (content.includes("\0") || !Buffer.from(content).equals(raw)) {
      issue(file, "Source is not supported UTF-8 text.");
      return null;
    }
    bytes += raw.length;
    const source = { path: file, sha256: digest(raw), kind };
    plan.sources.push(source);
    return { source, content };
  }
  // Local client permission choices are separate provenance, never Git command sources.
  const localPermissionPath = join(repositoryPath, ".codex", "config.toml");
  let localHandle;
  try {
    const directory = await lstat(join(repositoryPath, ".codex"));
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new Error(
        "Local Codex config directory must be a regular directory.",
      );
    const metadata = await lstat(localPermissionPath);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error(
        "Local Codex permission config must be a regular file, not a symlink.",
      );
    localHandle = await open(
      localPermissionPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const owned = await localHandle.stat();
    if (!owned.isFile() || owned.size > FILE_LIMIT)
      throw new Error(
        "Local Codex permission config exceeds the supported text limit.",
      );
    const buffer = Buffer.alloc(FILE_LIMIT + 1);
    const { bytesRead } = await localHandle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > FILE_LIMIT)
      throw new Error(
        "Local Codex permission config exceeds the supported text limit.",
      );
    const raw = buffer.subarray(0, bytesRead),
      content = raw.toString("utf8");
    if (!Buffer.from(content).equals(raw) || content.includes("\0"))
      throw new Error("Local Codex permission config must be UTF-8 text.");
    if ((await realpath(localPermissionPath)) !== localPermissionPath)
      throw new Error(
        "Local Codex permission config must remain inside the canonical project directory.",
      );
    plan.localPermissions.source = {
      path: localPermissionPath,
      sha256: digest(raw),
    };
    plan.localPermissions.networkAccess = parseProjectNetworkAccess(content);
    if (plan.localPermissions.networkAccess === null)
      issue(
        localPermissionPath,
        "No supported explicit network permission boolean was declared locally.",
      );
  } catch (error) {
    if (errorCode(error) !== "ENOENT")
      issue(localPermissionPath, errorMessage(error));
  } finally {
    await localHandle?.close();
  }
  const permissionPath = ".codex/config.toml";
  const permissions = await read(permissionPath, "permissions");
  if (permissions) {
    try {
      plan.networkAccess = parseProjectNetworkAccess(permissions.content);
      if (plan.networkAccess === null)
        issue(
          permissionPath,
          "No supported explicit sandbox_workspace_write.network_access boolean was declared.",
        );
    } catch (error) {
      issue(permissionPath, errorMessage(error));
    }
  } else if (!files.has(permissionPath))
    issue(
      permissionPath,
      "No committed Codex permission config was found; committed network policy is unknown. Explicit local client choices are reported separately.",
    );
  const candidates = [...files.keys()]
    .filter((file) => /^\.codex\/environments\/[^/]+\.toml$/.test(file))
    .sort();
  let chosen = environmentPath;
  if (
    chosen !== undefined &&
    (typeof chosen !== "string" || !candidates.includes(chosen))
  ) {
    issue(
      typeof chosen === "string" ? chosen : ".codex/environments",
      "Choose a committed environment TOML file from this reference.",
    );
    chosen = null;
  } else if (chosen === undefined) {
    if (candidates.length === 1) chosen = candidates[0];
    else {
      chosen = null;
      issue(
        ".codex/environments",
        candidates.length
          ? "Multiple environment files are available. Choose one explicitly."
          : "No committed environment TOML was found. Review project instructions for commands.",
      );
    }
  }
  if (chosen) {
    const file = await read(chosen, "environment");
    if (file) {
      try {
        const parsed = parseProjectEnvironmentToml(file.content),
          source = { path: file.source.path, sha256: file.source.sha256 };
        plan.setup = parsed.setup
          ? { ...parsed.setup, role: "setup", source }
          : null;
        plan.actions = parsed.actions.map((action) => ({
          ...action,
          role: null,
          source,
        }));
        if (plan.setup || plan.actions.length) plan.status = "discovered";
        else issue(chosen, "No setup script or named actions were declared.");
      } catch (error) {
        issue(chosen, errorMessage(error));
      }
    }
  }
  const skillFiles = [...files.keys()]
    .filter((file) => /^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(file))
    .sort();
  if (skillFiles.length > 8)
    issue(
      ".claude/skills",
      "Only the first eight committed skill files were included. Review additional skills when applicable.",
    );
  const queue = ["AGENTS.md", "CLAUDE.md", ...skillFiles.slice(0, 8)];
  const visited = new Set();
  while (queue.length) {
    const file = queue.shift();
    if (!file) continue;
    if (visited.has(file)) continue;
    visited.add(file);
    const result = await read(file, "instruction");
    if (!result) continue;
    plan.instructions.push({
      path: file,
      sha256: result.source.sha256,
      content: result.content,
    });
    // Follow only explicit local Markdown/@ references. Never read a working-tree file.
    const references = [
      ...result.content.matchAll(
        /\]\(([^)\s]+\.md)(?:#[^)]*)?\)|(?:^|\s)@([^\s]+\.md)/gm,
      ),
    ].map((match) => match[1] || match[2]);
    for (const reference of references) {
      if (
        reference.startsWith("/") ||
        reference.includes(":") ||
        reference.includes("\\")
      )
        continue;
      const relative = posix.normalize(
        posix.join(posix.dirname(file), reference),
      );
      if (
        relative.startsWith("../") ||
        !files.has(relative) ||
        visited.has(relative) ||
        queue.includes(relative)
      )
        continue;
      if (visited.size + queue.length >= SOURCE_LIMIT) {
        issue(
          relative,
          "Instruction discovery file limit reached. Review this reference separately.",
        );
        continue;
      }
      queue.push(relative);
    }
  }
  const toolSources = [...plan.instructions];
  for (const file of [
    "package.json",
    ".nvmrc",
    ".node-version",
    ".tool-versions",
  ]) {
    const result = await read(file, "toolchain");
    if (result) toolSources.push({ path: file, content: result.content });
  }
  try {
    plan.toolchain = discoverToolRequirements({ sources: toolSources });
  } catch (error) {
    issue("toolchain", errorMessage(error));
    plan.toolchainError = errorMessage(error);
  }
  return plan;
}
