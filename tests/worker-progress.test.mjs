import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTask,
  updateTask,
  readTask,
  setWorkflowState,
} from "../runtime/orchestration/store.mjs";
import {
  createPromptSettings,
  buildWorkerInstructions,
  buildManagerInstructions,
} from "../runtime/manager/instructions/settings.mjs";
import { updateActivity } from "../runtime/updates/activity.mjs";

const taskId = "progress-worker";
const runId = "progress-run";
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "crew-progress-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await createTask(dir, {
    requestId: taskId,
    ticket: "GH-65",
    brief: "Validate reported progress",
    projectId: "crew",
    repositoryId: "primary",
  });
  await updateTask(dir, taskId, (task) => {
    task.status = "running";
    task.runId = runId;
  });
  return dir;
}
async function rpc(dir, args, boundRun = runId) {
  const child = spawn(process.execPath, [
    fileURLToPath(new URL("../runtime/orchestration-mcp.mjs", import.meta.url)),
    dir,
    "worker",
    taskId,
    boundRun,
  ]);
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (value) => (stdout += value));
  child.stderr.on("data", (value) => (stderr += value));
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  child.stdin.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "set_workflow_state", arguments: args },
    }) + "\n",
  );
  assert.equal(await exit, 0, stderr);
  return JSON.parse(stdout).result;
}
async function report(dir, requestId, state, fields = {}) {
  const response = await rpc(dir, { requestId, state, ...fields });
  assert.ok(!response.isError, JSON.stringify(response));
  return JSON.parse(response.content[0].text);
}

// Each call uses a fresh MCP process; every observation reopens persisted state.
test("worker MCP persists optional estimates, revisions and clearing without deriving execution", async (t) => {
  const dir = await fixture(t);
  assert.equal((await readTask(dir, taskId)).workflowState, undefined);
  await report(dir, "progress-first", "Researching");
  let task = await readTask(dir, taskId);
  assert.equal(
    task.workflowState.progressPercent,
    undefined,
    "first status does not invent zero",
  );
  assert.equal(task.workflowState.actor, "worker");
  assert.equal(task.workflowState.runId, runId);
  await report(dir, "progress-estimate", "Implementing", {
    progressPercent: 62.5,
  });
  assert.equal(
    (await readTask(dir, taskId)).workflowState.progressPercent,
    62.5,
  );
  await report(dir, "progress-revised", "More work discovered", {
    progressPercent: 35,
  });
  assert.equal(
    (await readTask(dir, taskId)).workflowState.progressPercent,
    35,
    "estimate may decrease",
  );
  await report(dir, "progress-label-only", "Testing");
  assert.equal(
    (await readTask(dir, taskId)).workflowState.progressPercent,
    35,
    "omission preserves reported estimate",
  );
  await report(dir, "progress-clear", "Estimate unavailable", {
    progressPercent: null,
  });
  assert.equal(
    (await readTask(dir, taskId)).workflowState.progressPercent,
    null,
  );
  await report(dir, "progress-clear-retained", "Investigating");
  assert.equal(
    (await readTask(dir, taskId)).workflowState.progressPercent,
    null,
    "unset remains unset on label-only update",
  );
  await report(dir, "progress-hundred", "Ready for review", {
    progressPercent: 100,
  });
  task = await readTask(dir, taskId);
  assert.equal(task.status, "running", "reported 100 never ends execution");
  assert.equal(task.workflowHistory.length, 7);
  assert.equal(
    task.workflowHistory[1].progressPercent,
    62.5,
    "prior estimate remains in history",
  );
  await updateTask(dir, taskId, (value) => {
    value.status = "completed";
  });
  assert.equal(
    (await readTask(dir, taskId)).workflowState.progressPercent,
    100,
  );
  await report(dir, "progress-zero", "New questions", { progressPercent: 0 });
  task = await readTask(dir, taskId);
  assert.equal(
    task.status,
    "completed",
    "reported zero never resumes execution",
  );
  assert.equal(task.workflowState.progressPercent, 0);
});

test("worker MCP retries bind the exact original payload and reject stale new reports", async (t) => {
  const dir = await fixture(t);
  await report(dir, "progress-original", "Building", { progressPercent: 20 });
  await report(dir, "progress-later", "Testing", { progressPercent: 55 });
  let task = await readTask(dir, taskId);
  const history = structuredClone(task.workflowHistory);
  await report(dir, "progress-original", "Building", { progressPercent: 20 });
  task = await readTask(dir, taskId);
  assert.deepEqual(task.workflowHistory, history);
  assert.equal(
    task.workflowState.progressPercent,
    55,
    "retry does not restore an older estimate",
  );
  for (const fields of [
    { state: "Different label", progressPercent: 20 },
    { state: "Building", progressPercent: 21 },
    { state: "Building" },
    { state: "Building", progressPercent: null },
  ]) {
    const result = await rpc(dir, {
      requestId: "progress-original",
      ...fields,
    });
    assert.equal(result.isError, true, JSON.stringify(result));
  }
  await report(dir, "progress-omitted", "Reviewing");
  await report(dir, "progress-omitted", "Reviewing");
  const changed = await rpc(dir, {
    requestId: "progress-omitted",
    state: "Reviewing",
    progressPercent: 55,
  });
  assert.equal(
    changed.isError,
    true,
    "omitted and explicit estimate are different retry payloads",
  );
  await updateTask(dir, taskId, (value) => {
    value.runId = "progress-next-run";
  });
  const before = await readTask(dir, taskId);
  const stale = await rpc(dir, {
    requestId: "progress-stale",
    state: "Wrong run",
    progressPercent: 99,
  });
  assert.equal(stale.isError, true);
  assert.deepEqual(
    (await readTask(dir, taskId)).workflowHistory,
    before.workflowHistory,
  );
});

test("invalid MCP and direct progress values preserve the last accepted state", async (t) => {
  const dir = await fixture(t);
  await report(dir, "progress-valid", "Working", { progressPercent: 48 });
  const before = await readTask(dir, taskId);
  for (const progressPercent of [-1, 100.001, "50", true, {}, []]) {
    const response = await rpc(dir, {
      requestId: "progress-invalid",
      state: "Working",
      progressPercent,
    });
    assert.equal(response.isError, true, JSON.stringify(progressPercent));
  }
  for (const progressPercent of [NaN, Infinity, -Infinity]) {
    await assert.rejects(
      setWorkflowState(dir, {
        taskId,
        requestId: "progress-nonfinite",
        state: "Working",
        progressPercent,
        actor: "worker",
        runId,
      }),
      /Invalid/,
    );
  }
  await assert.rejects(
    updateTask(dir, taskId, (value) => {
      value.workflowState.progressPercent = -1;
    }),
    /Malformed|immutable/,
  );
  assert.deepEqual(await readTask(dir, taskId), before);
});

test("reported status and progress never grant or prevent update readiness", () => {
  const work = {
    status: "idle",
    voiceActive: false,
    voiceConnecting: false,
    workStarting: false,
    activeTurnId: null,
    approvals: [],
  };
  const task = {
    id: taskId,
    status: "running",
    execution: { live: true },
    updateEvidence: { worker: "live", runtime: "absent", hooks: [] },
  };
  const check = (value) => updateActivity({ work, view: { tasks: [value] } });
  const busy = check(task);
  assert.equal(busy.safe, false);
  assert.deepEqual(
    check({ ...task, workflowState: { value: "Ready", progressPercent: 100 } }),
    busy,
  );
  const stopped = {
    ...task,
    status: "paused",
    execution: { live: false },
    updateEvidence: { worker: "stopped", runtime: "absent", hooks: [] },
  };
  const safe = check(stopped);
  assert.equal(safe.safe, true);
  assert.deepEqual(
    check({
      ...stopped,
      workflowState: { value: "Still researching", progressPercent: 0 },
    }),
    safe,
  );
  assert.deepEqual(
    check({
      ...stopped,
      workflowState: { value: "Blocked", progressPercent: null },
    }),
    safe,
  );
});

test("reporting guidance is editable default behavior and custom role prompts stay exact", async (t) => {
  const dir = await fixture(t);
  const workerDefault = await readFile(
    new URL("../prompts/worker.md", import.meta.url),
    "utf8",
  );
  assert.match(workerDefault, /five to ten minutes/);
  assert.match(workerDefault, /own the execution plan and progress estimate/);
  assert.match(workerDefault, /Revise it up or down/);
  assert.match(workerDefault, /not a timer, forced review or execution gate/);
  const settings = await createPromptSettings({
    stateDir: dir,
    projectId: "crew",
  });
  const initial = await settings.read();
  const customWorker =
    "Custom worker preferences: report only material findings.\nKeep café and 🧪 exactly.\n";
  const customManager =
    "Custom manager preferences: delegate goals and use concise answers.\n";
  await settings.save({
    role: "worker",
    text: customWorker,
    expectedVersion: initial.worker.version,
  });
  await settings.save({
    role: "manager",
    text: customManager,
    expectedVersion: initial.manager.version,
  });
  const reopened = await createPromptSettings({
    stateDir: dir,
    projectId: "crew",
  });
  const saved = await reopened.read();
  assert.equal(saved.worker.text, customWorker);
  assert.equal(saved.manager.text, customManager);
  const worker = buildWorkerInstructions({
    workerPrompt: saved.worker.text,
    taskId,
    runId,
    ticket: "GH-65",
    brief: "Validate custom prompts",
    project: { id: "crew" },
  });
  const manager = buildManagerInstructions({
    managerPrompt: saved.manager.text,
    project: { id: "crew" },
  });
  assert.ok(worker.startsWith(customWorker + "\n\n"));
  assert.ok(manager.startsWith(customManager + "\n\n"));
  const runtimeContext = worker.slice(customWorker.length);
  assert.match(runtimeContext, /set_workflow_state stores agent-reported/);
  assert.doesNotMatch(
    runtimeContext,
    /five to ten minutes|Report progress, question|Use set_workflow_state explicitly|Continue in the retained working context/,
  );
  assert.doesNotMatch(
    manager.slice(customManager.length),
    /five to ten minutes|Report progress/,
  );
});
