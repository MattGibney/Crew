// GH-66 validation only: no inherited project binding or live capacity ledger.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const evidence = await mkdtemp(
  path.join(tmpdir(), "crew66-initialized-suite-"),
);
const capacityDir = path.join(evidence, "capacity");
const env = {
  ...process.env,
  CREW_GLOBAL_CAPACITY_DIR: capacityDir,
  CREW_APP_DATA: path.join(evidence, "app-data"),
};
for (const key of ["AI_MANAGER_CONFIG", "AI_MANAGER_PORT", "VOICE_PORT"])
  delete env[key];
console.log(`Evidence: ${evidence}`);

async function run(label, command, args) {
  let output = "";
  const child = spawn(command, args, {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    output += data;
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  await writeFile(path.join(evidence, `${label}.log`), output);
  console.log(
    `${label}: exit ${code}\n${output.split("\n").slice(-12).join("\n")}`,
  );
  return code;
}

// Capture exact source identity without inspecting any inherited profile/config.
const files = execFileSync(
  "git",
  [
    "ls-files",
    "-z",
    "-c",
    "-o",
    "--exclude-standard",
    "--",
    "src",
    "renderer",
    "tests",
    "scripts",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.renderer.json",
    "vite.config.js",
  ],
  { cwd: root },
)
  .toString()
  .split("\0")
  .filter(Boolean);
const hashes = {};
for (const file of files)
  hashes[file] = createHash("sha256")
    .update(await readFile(path.join(root, file)))
    .digest("hex");
await writeFile(
  path.join(evidence, "source-sha256.json"),
  JSON.stringify(hashes, null, 2) + "\n",
);
assert.equal(
  await run("build", "npm", ["run", "build"]),
  0,
  "Build failed; suite not started.",
);
const { configureGlobalCapacity, globalAdmissionPaused } =
  await import("../runtime/orchestration/capacity.mjs");
// A configured missing ledger is correctly fail-closed; initialize only this
// freshly allocated test directory using the production API before testing.
assert.equal(await globalAdmissionPaused(capacityDir), true);
await configureGlobalCapacity({
  dir: capacityDir,
  limit: 2,
  admissionPaused: false,
});
assert.equal(await globalAdmissionPaused(capacityDir), false);
await writeFile(
  path.join(evidence, "initial-capacity.json"),
  await readFile(path.join(capacityDir, "capacity.json")),
);
const focused = await run("scheduling-preparation", process.execPath, [
  "--import",
  "tsx",
  "--test",
  "tests/manager-schedules-preparation.test.mjs",
]);
assert.equal(
  focused,
  0,
  "Scheduling preparation validation failed; inspect retained evidence.",
);
const full = await run("full-suite", "npm", ["test"]);
await writeFile(
  path.join(evidence, "result.json"),
  JSON.stringify(
    { focusedExit: focused, fullExit: full, capacityDir },
    null,
    2,
  ) + "\n",
);
// Keep private disposable logs/ledger for review; never clean inherited claims.
process.exitCode = full === 0 ? 0 : 1;
