import {opendir,lstat,open,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {relative,sep,isAbsolute,resolve,join} from 'node:path';
import {errorCode} from '../shared/errors.mjs';
import type {ProjectInventory} from './contracts.mjs';
import {abort,redact} from './safety.mjs';
export const LIMITS = Object.freeze({
  entries: 500,
  visited: 2000,
  depth: 5,
  files: 24,
  fileBytes: 16384,
  totalBytes: 131072,
});
const excluded =
  /^(?:\..*|node_modules|vendor|dist|build|out|coverage|target|__pycache__|Pods|DerivedData|\.next|\.nuxt)$/i;
const secretName =
  /(?:^|[._-])(?:env|secrets?|credentials?|tokens?|passwords?|private|auth|id_rsa|id_ed25519)(?:$|[._-])|(?:lock|\.min)\.|\.(?:pem|key|p12|pfx|keystore)$/i;
const readable =
  /\.(?:md|mdx|txt|json|[cm]?js|jsx|ts|tsx|py|rs|go|swift|java|kt|rb|html|css|scss|ya?ml|toml)$/i;
export const inside = (parent: string, child: string) => {
  const p = relative(parent, child);
  return !p || (p !== ".." && !p.startsWith(`..${sep}`) && !isAbsolute(p));
};
const priority = (path: string) =>
  /(^|\/)AGENTS\.md$/i.test(path)
    ? 0
    : /(^|\/)README(?:\.[^/]*)?$/i.test(path)
      ? 1
      : /(^|\/)(?:docs\/|package\.json$|Cargo\.toml$|pyproject\.toml$|go\.mod$)/i.test(
            path,
          )
        ? 2
        : 3;

export async function inventoryProject(
  repositoryRoot: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<ProjectInventory> {
  abort(signal);
  if (typeof repositoryRoot !== "string" || !isAbsolute(repositoryRoot))
    throw new Error("Choose an absolute local project directory.");
  const root = await realpath(repositoryRoot);
  if (!(await lstat(root)).isDirectory())
    throw new Error("Selected project must be a directory.");
  const entries: ProjectInventory["entries"] = [],
    candidates: string[] = [];
  let visited = 0,
    truncated = false;
  async function walk(directory: string, depth: number) {
    abort(signal);
    if (!inside(root, await realpath(directory)))
      throw new Error("Project path changed during discovery. Retry.");
    const handle = await opendir(directory);
    try {
      for await (const entry of handle) {
        abort(signal);
        if (++visited > LIMITS.visited || entries.length >= LIMITS.entries) {
          truncated = true;
          break;
        }
        if (
          excluded.test(entry.name) ||
          secretName.test(entry.name) ||
          entry.isSymbolicLink()
        )
          continue;
        const absolute = join(directory, entry.name),
          path = relative(root, absolute).split(sep).join("/");
        if (entry.isDirectory()) {
          entries.push({ path, kind: "directory" });
          if (depth < LIMITS.depth) await walk(absolute, depth + 1);
          else truncated = true;
        } else if (entry.isFile()) {
          entries.push({ path, kind: "file" });
          if (
            readable.test(entry.name) ||
            ["go.mod", "Dockerfile", "Makefile"].includes(entry.name)
          )
            candidates.push(path);
        }
        if (visited > LIMITS.visited || entries.length >= LIMITS.entries) break;
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new Error(
        "Project directory could not be read. Check local access.",
      );
    }
  }
  await walk(root, 0);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  candidates.sort(
    (a, b) =>
      priority(a) - priority(b) ||
      a.split("/").length - b.split("/").length ||
      a.localeCompare(b),
  );
  const sources = [];
  let bytes = 0;
  for (const path of candidates) {
    abort(signal);
    if (sources.length >= LIMITS.files || bytes >= LIMITS.totalBytes) {
      truncated = true;
      break;
    }
    const absolute = join(root, path);
    // Do not follow symlinks, including a parent replaced during traversal.
    if (!inside(root, await realpath(absolute))) continue;
    const fd = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await fd.stat();
      if (!info.isFile() || info.size > LIMITS.fileBytes) {
        truncated = true;
        continue;
      }
      const buffer = Buffer.alloc(
        Math.min(LIMITS.fileBytes + 1, LIMITS.totalBytes - bytes + 1),
      );
      const result = await fd.read(buffer, 0, buffer.length, 0);
      if (
        result.bytesRead > LIMITS.fileBytes ||
        bytes + result.bytesRead > LIMITS.totalBytes
      ) {
        truncated = true;
        continue;
      }
      const raw = buffer.subarray(0, result.bytesRead);
      if (raw.includes(0)) continue;
      const content = raw.toString("utf8");
      if (content.includes("\uFFFD")) continue;
      sources.push({ path, content: redact(content) });
      bytes += result.bytesRead;
    } finally {
      await fd.close();
    }
  }
  abort(signal);
  return { root, entries, sources, truncated, limits: LIMITS };
}

