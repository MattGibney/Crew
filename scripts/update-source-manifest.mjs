// Developer-only: refresh the reviewable source allowlist after staging new files.
import { execFileSync } from "node:child_process";
import { lstat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const tracked = execFileSync("git", ["ls-files", "--cached", "-z"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);
const top = new Set([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.renderer.json",
  "vite.config.js",
  "electron-builder.yml",
  "components.json",
  ".gitignore",
  "README.md",
  "AGENTS.md",
]);
const source =
  /^(?:(?:backend|bridge|shared|execution|desktop|renderer|scripts|tests|docs|tickets)\/|\.github\/workflows\/).*\.(?:mts|cts|ts|tsx|mjs|js|jsx|md|json|yml|css|html)$/;
const assets = new Set([
  "config/fixture.example.json",
  "config/set1.example.json",
  "prompts/manager.md",
  "prompts/worker.md",
  "build/crew-mark.png",
  "build/icon.png",
  "build/icon.icns",
  "build/entitlements.mac.plist",
  "desktop/sounds/attention.wav",
]);
const files = [];
for (const file of new Set(tracked)) {
  if (!(
    top.has(file) ||
    assets.has(file) ||
    source.test(file) ||
    /^[^/]+\.mts$/.test(file) ||
    /^config\/[^/]+\.mts$/.test(file)
  ))
    continue;
  const info = await lstat(path.join(root, file)).catch(() => null);
  if (!info) continue;
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`Source must be a regular tracked file: ${file}`);
  files.push(file);
}
for (const file of [
  "scripts/source-manifest.json",
  "scripts/update-source-manifest.mjs",
])
  if (!files.includes(file)) files.push(file);
await writeFile(
  path.join(root, "scripts/source-manifest.json"),
  JSON.stringify({ schemaVersion: 1, files: files.sort() }, null, 2) + "\n",
);
console.log(
  `Recorded ${files.length} exact source files. Review and commit the manifest with the source changes.`,
);
