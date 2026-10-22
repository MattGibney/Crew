// GH-50 opt-in real subscription acceptance. Never opens voice or the installed app.
// Run only with explicit authorization for bounded subscription use and disposable fixtures.
import { createPromptSettings } from "../runtime/manager/instructions/settings.mjs";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createController } from "../runtime/workers/controller.mjs";
import {
  createTask,
  readTask,
  requestWorkerAction,
  requestWorkerFollowup,
} from "../runtime/orchestration/store.mjs";
import { resolveCodexExecutable } from "../runtime/config/index.mjs";
const exec = promisify(execFile),
  sourceDir = fileURLToPath(new URL("../runtime/", import.meta.url));
const dir = await mkdtemp(path.join(tmpdir(), "crew-steering-subscription-")),
  repo = path.join(dir, "repo"),
  stateDir = path.join(dir, "state"),
  taskId = "subscription-steering-fixture";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(read, predicate, label, ms = 150000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(150);
  }
  throw Error("Timed out: " + label);
}
let controller, started;
const read = () => readTask(stateDir, taskId);
// Cleanup is registered before any lifecycle observation; it never force-kills.
async function cleanup() {
  if (controller) {
    const task = await read().catch(() => null);
    if (task?.runId && task.execution?.live !== false) {
      await requestWorkerAction(stateDir, {
        taskId,
        actionId: "acceptance-cleanup-pause",
        action: "pause",
        cooperative: true,
        expectedRunId: task.runId,
      });
      await controller.tick();
      await wait(
        read,
        (n) => n.execution?.live === false,
        "cooperative fixture exit",
        30000,
      );
    }
    await controller.stop();
  }
}
try {
  await mkdir(repo);
  await writeFile(
    path.join(repo, "README.md"),
    "Disposable subscription steering acceptance.\n",
  );
  await exec("git", ["init", "-q", "-b", "main", repo]);
  await exec("git", ["-C", repo, "add", "."]);
  await exec("git", [
    "-C",
    repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@localhost.invalid",
    "commit",
    "-qm",
    "Disposable fixture",
  ]);
  const { executable, version } = await resolveCodexExecutable();
  const project = {
    id: "subscription-steering",
    name: "Disposable steering acceptance",
    mode: "repository",
    readiness: { ready: true },
    repositories: [{ id: "repo", path: repo, baseRef: "main" }],
    worker: { maxConcurrent: 1, timeoutMs: 180000 },
  };
  const workerPrompt =
    "You are a bounded disposable transport acceptance participant. Follow the fixture brief exactly. Use only local_orchestration.report and normal shell tools in this disposable worktree. Never read credentials, access business services, open voice, create workers, commit, push or mutate external services. Existing subscription and normal native permissions apply. Report real observations only.";
  const profiles = await createPromptSettings({
    stateDir,
    projectId: project.id,
    workerPrompt,
  });
  controller = await createController({
    workerProfileSource: { projectId: project.id },
    stateDir,
    sourceDir,
    executable,
    project,
    workerPrompt,
  });
  await createTask(stateDir, {
    requestId: taskId,
    ticket: "GH-50",
    projectId: project.id,
    repositoryId: "repo",
    brief:
      "This is an explicitly authorized disposable live-steering test. First call local_orchestration.report with kind progress, reportId fixture-ready, message Ready for manager steering. Then remain in this same active turn until a file named acceptance-release exists in your current worktree. While waiting, run bounded 3-second shell waits and check for that file repeatedly (at most 120 seconds). Do not finish or report result before the file exists. New manager corrections must be read and reported promptly without ending this turn. Once released, report result with reportId fixture-final and message Original turn completed after steering, then finish. Do not create or edit any files.",
  });
  await requestWorkerAction(stateDir, {
    taskId,
    actionId: "acceptance-start",
    action: "start",
    expectedRunId: null,
  });
  await controller.tick();
  started = await wait(
    read,
    (n) => n.reports.some((r) => r.reportId === "fixture-ready"),
    "initial fixture readiness",
  );
  console.log(
    JSON.stringify({
      event: "ready",
      evidenceDir: dir,
      version,
      runId: started.runId,
      threadId: started.threadId,
    }),
  );
  const runtimeBefore = JSON.parse(
    await readFile(path.join(started.runDir, "runtime.json"), "utf8"),
  );
  const beforeSave = await profiles.read();
  await profiles.save({
    role: "worker",
    expectedVersion: beforeSave.worker.version,
    text:
      workerPrompt +
      "\nWhen an explicit manager direction asks for profile verification, report the current saved profile marker REL018_CURRENT_PROFILE.",
  });
  await delay(500);
  assert.equal(
    (await read()).assignments?.length || 1,
    1,
    "Saving Settings alone creates no direction",
  );
  await requestWorkerFollowup(stateDir, {
    taskId,
    workLink: {
      provider: "github",
      repository: "MattGibney/crew",
      number: 78,
      url: "https://github.com/MattGibney/crew/issues/78",
    },
    requestId: "subscription-correction-one",
    brief:
      "Live correction ONE: first verify the current saved worker profile by reporting kind progress, reportId profile-consumed, message containing the current saved profile marker. Then call local_orchestration.report now with kind progress, reportId consumed-correction-one, message CORRECTION_ONE_CONSUMED. Stay in this active turn and keep waiting for acceptance-release. Do not report result yet.",
  });
  await requestWorkerFollowup(stateDir, {
    taskId,
    requestId: "subscription-correction-two",
    brief:
      "Live correction TWO: call local_orchestration.report now with kind progress, reportId consumed-correction-two, message CORRECTION_TWO_CONSUMED. Preserve correction ONE too. Stay in this same active turn and wait for acceptance-release before reporting any result.",
  });
  const consumed = await wait(
    read,
    (n) =>
      [
        "consumed-correction-one",
        "consumed-correction-two",
        "profile-consumed",
      ].every((id) => n.reports.some((r) => r.reportId === id)),
    "model-consumed corrections before completion",
  );
  assert.match(
    consumed.reports.find((r) => r.reportId === "profile-consumed").message,
    /REL018_CURRENT_PROFILE/,
  );
  const promptReads = (
    await readFile(
      path.join(started.runDir, "prompt-consumptions.jsonl"),
      "utf8",
    )
  )
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(promptReads.filter((p) => p.boundary === "direction").length, 2);
  assert.ok(
    promptReads
      .filter((p) => p.boundary === "direction")
      .every((p) => p.saved.text.includes("REL018_CURRENT_PROFILE")),
  );
  assert.equal(consumed.runId, started.runId);
  assert.equal(consumed.threadId, started.threadId);
  assert.equal(consumed.worktree, started.worktree);
  assert.equal(
    consumed.currentAssignmentId,
    started.currentAssignmentId || "initial",
  );
  assert.ok(!consumed.reports.some((r) => r.kind === "result"));
  assert.equal(consumed.execution.live, true);
  await wait(
    read,
    (n) =>
      n.assignments.slice(1).every((a) => a.delivery?.state === "acknowledged"),
    "native acknowledgement",
  );
  const runtimeAfter = JSON.parse(
    await readFile(path.join(started.runDir, "runtime.json"), "utf8"),
  );
  assert.equal(runtimeAfter.turnId, runtimeBefore.turnId);
  await writeFile(
    path.join(started.worktree, "acceptance-release"),
    "Release bounded fixture after observed steering.\n",
  );
  const completed = await wait(
    read,
    (n) => n.execution?.live === false && n.status === "completed",
    "natural original turn completion",
  );
  const terminal = JSON.parse(
    await readFile(path.join(started.runDir, "exit.json"), "utf8"),
  );
  assert.equal(terminal.nativeTurnStatus, "completed");
  assert.equal(terminal.stopConfirmed, true);
  const proof = {
    pass: true,
    version,
    evidenceDir: dir,
    currentSavedProfileConsumed: true,
    sameRun: completed.runId === started.runId,
    sameThread: completed.threadId === started.threadId,
    sameWorktree: completed.worktree === started.worktree,
    sameNativeTurn: runtimeAfter.turnId === runtimeBefore.turnId,
    nativeAcknowledgements: completed.assignments.slice(1).map((a) => ({
      requestId: a.id,
      state: a.delivery.state,
      turnId: a.delivery.turnId,
      history: a.deliveryHistory,
    })),
    modelConsumptionReports: consumed.reports
      .filter((r) => r.reportId.startsWith("consumed-correction-"))
      .map((r) => ({ reportId: r.reportId, at: r.at, message: r.message })),
    noResultAtConsumption: true,
    naturalExit: true,
    physicalMicrophoneUsed: false,
  };
  await writeFile(
    path.join(dir, "proof.json"),
    JSON.stringify(proof, null, 2) + "\n",
  );
  console.log(JSON.stringify(proof));
} catch (error) {
  console.error(
    JSON.stringify({ pass: false, evidenceDir: dir, error: error.message }),
  );
  process.exitCode = 1;
} finally {
  await cleanup();
}
