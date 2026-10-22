// Development/build tooling remains executable JavaScript: no runtime TS loader ships.
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
function run(script, args) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "node_modules", script), ...args],
    { cwd: root, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
// Do not retain stale deleted modules after responsibility changes.
await rm(path.join(root, "runtime"), { recursive: true, force: true });
run("typescript/bin/tsc", ["-p", "tsconfig.json"]);
run("typescript/bin/tsc", ["-p", "tsconfig.renderer.json"]);
run("vite/bin/vite.js", ["build"]);
for (const resource of [
  "renderer-dist",
  "desktop/sounds",
  "config/fixture.example.json",
  "config/set1.example.json",
  "prompts",
  "docs",
  "build/crew-mark.png",
  "README.md",
]) {
  const destination = path.join(root, "runtime", resource);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(path.join(root, resource), destination, { recursive: true });
}
const metadata = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
// A runtime root always has its own resource-relative metadata. Production
// dependencies resolve from the outer application node_modules directory.
await writeFile(
  path.join(root, "runtime/package.json"),
  JSON.stringify(
    {
      ...metadata,
      main: "desktop/main.mjs",
      bin: { crew: "./cli.mjs", "ai-manager": "./cli.mjs" },
    },
    null,
    2,
  ) + "\n",
);
console.log("Built typed runtime and renderer in runtime/.");
