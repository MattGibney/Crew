import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, unlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPromptSettings } from "../runtime/manager/instructions/settings.mjs";
import { readSavedWorkerProfile } from "../runtime/manager/instructions/worker-profile.mjs";
import { parseWorkerConfiguration } from "../runtime/workers/worker-protocol.mjs";

test("saved worker profile seeds configured custom text once; later reads never revive stale startup text", async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "crew-profile-source-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const store = await createPromptSettings({
    stateDir,
    projectId: "one",
    workerPrompt: "CUSTOM INITIAL",
  });
  assert.equal(
    (await readSavedWorkerProfile(stateDir, "one")).text,
    "CUSTOM INITIAL",
  );
  const first = await store.read();
  await store.save({
    role: "worker",
    text: "CURRENT CUSTOM",
    expectedVersion: first.worker.version,
  });
  const reopened = await createPromptSettings({
    stateDir,
    projectId: "one",
    workerPrompt: "STALE STARTUP",
  });
  assert.equal((await reopened.snapshot("worker")).text, "CURRENT CUSTOM");
  assert.equal(
    (await readSavedWorkerProfile(stateDir, "one")).text,
    "CURRENT CUSTOM",
  );
  const file = path.join(stateDir, "prompt-settings", "one.json"),
    bytes = await readFile(file, "utf8");
  await unlink(file);
  await assert.rejects(store.snapshot("worker"), /Cannot read saved/);
  const missingAfterRestart = await createPromptSettings({
    stateDir,
    projectId: "one",
    workerPrompt: "STALE RESTART",
  });
  await assert.rejects(
    missingAfterRestart.snapshot("worker"),
    /Cannot read saved/,
  );
  await assert.rejects(
    readSavedWorkerProfile(stateDir, "one"),
    /No startup or historical/,
  );
  await assert.rejects(readFile(file), { code: "ENOENT" });
  await writeFile(file, bytes);
  assert.equal((await store.snapshot("worker")).text, "CURRENT CUSTOM");
});

test("worker profile source validates project identity, preserves custom settings and fails closed without rewriting a foreign document", async (t) => {
  const stateDir = await mkdtemp(
    path.join(tmpdir(), "crew-profile-isolation-"),
  );
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await createPromptSettings({
    stateDir,
    projectId: "one",
    workerPrompt: "CUSTOM ONE",
  });
  await createPromptSettings({
    stateDir,
    projectId: "two",
    workerPrompt: "CUSTOM TWO",
  });
  assert.equal(
    (await readSavedWorkerProfile(stateDir, "one")).text,
    "CUSTOM ONE",
  );
  assert.equal(
    (await readSavedWorkerProfile(stateDir, "two")).text,
    "CUSTOM TWO",
  );
  const one = path.join(stateDir, "prompt-settings", "one.json"),
    two = path.join(stateDir, "prompt-settings", "two.json"),
    foreign = await readFile(two, "utf8");
  await writeFile(one, foreign);
  await assert.rejects(
    readSavedWorkerProfile(stateDir, "one"),
    /saved project worker profile/,
  );
  assert.equal(await readFile(one, "utf8"), foreign);
  assert.equal(
    (await readSavedWorkerProfile(stateDir, "two")).text,
    "CUSTOM TWO",
  );
  const config = {
    taskId: "task",
    runId: "run",
    stateDir,
    worktree: stateDir,
    executable: "/fixture/codex",
    mcpScript: "/fixture/mcp",
    workerPrompt: "HISTORICAL",
    ticket: "LOCAL",
    brief: "Fixture",
    project: { id: "one" },
    workerProfileSource: { projectId: "two" },
  };
  assert.throws(() => parseWorkerConfiguration(config), /does not match/);
});
