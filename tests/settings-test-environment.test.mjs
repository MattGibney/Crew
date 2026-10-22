// Local Settings ticket: preserve fail-closed production admission while making
// the explicit test-only preload start from a valid isolated capacity ledger.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
test("test environment initializes only its private ledger, while missing and explicitly held ledgers still block", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "crew-settings-preload-")),
    canary = path.join(root, "untouched-capacity");
  await mkdir(canary);
  let privateDir;
  t.after(async () => {
    if (privateDir) await rm(privateDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  const original = JSON.stringify({
    version: 1,
    limit: 2,
    admissionPaused: true,
    stateDirs: [],
    claims: [],
  });
  await writeFile(path.join(canary, "capacity.json"), original);
  const program = `import{readFile}from'node:fs/promises';import path from'node:path';import{globalAdmissionPaused,configureGlobalCapacity}from'./runtime/orchestration/capacity.mjs';const dir=process.env.CREW_GLOBAL_CAPACITY_DIR;const initial=await globalAdmissionPaused(dir);const ledger=JSON.parse(await readFile(path.join(dir,'capacity.json'),'utf8'));const missing=await globalAdmissionPaused(path.join(dir,'absent'));await configureGlobalCapacity({dir,admissionPaused:true});console.log(JSON.stringify({dir,initial,ledger,missing,held:await globalAdmissionPaused(dir),config:process.env.AI_MANAGER_CONFIG??null,port:process.env.AI_MANAGER_PORT??null,voicePort:process.env.VOICE_PORT??null}));`;
  const { stdout } = await exec(
    process.execPath,
    [
      "--import",
      "./scripts/settings-profile-refresh-test-environment.mjs",
      "--input-type=module",
      "-e",
      program,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CREW_GLOBAL_CAPACITY_DIR: canary,
        AI_MANAGER_CONFIG: path.join(root, "not-opened.json"),
        AI_MANAGER_PORT: "59999",
        VOICE_PORT: "59998",
      },
    },
  );
  const result = JSON.parse(stdout.trim());
  privateDir = result.dir;
  assert.notEqual(privateDir, canary);
  assert.equal(result.initial, false);
  assert.equal(result.ledger.version, 1);
  assert.equal(result.ledger.admissionPaused, false);
  assert.deepEqual(result.ledger.claims, []);
  assert.deepEqual(result.ledger.stateDirs, []);
  assert.equal(result.missing, true);
  assert.equal(result.held, true);
  assert.equal(result.config, null);
  assert.equal(result.port, null);
  assert.equal(result.voicePort, null);
  assert.equal(
    await readFile(path.join(canary, "capacity.json"), "utf8"),
    original,
    "inherited capacity bytes stay untouched",
  );
});
