// #65: actual worker MCP + disk persistence, then real compiled renderer over synthetic SSE.
// No provider, user workers, native app, or physical media access.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import {
  createTask,
  updateTask,
  readTask,
} from "../runtime/orchestration/store.mjs";
const { chromium } = await import(
  process.env.CREW_PLAYWRIGHT_MODULE || "playwright-core"
);
const output = await mkdtemp(path.join(tmpdir(), "crew-progress-browser-"));
const stateDir = path.join(output, "state");
const port = Number(process.env.CREW_ACCEPTANCE_PORT || 4365);
const origin = `http://127.0.0.1:${port}`;
const id = "fixture-task-1",
  runId = "fixture-run-1";
await createTask(stateDir, {
  requestId: id,
  ticket: "GH-65",
  brief: "Validate worker-reported status and progress",
  projectId: "crew",
  repositoryId: "primary",
});
await updateTask(stateDir, id, (t) => {
  t.status = "running";
  t.runId = runId;
});
async function report(args) {
  const child = spawn(process.execPath, [
    "runtime/orchestration-mcp.mjs",
    stateDir,
    "worker",
    id,
    runId,
  ]);
  let out = "",
    err = "";
  child.stdout.on("data", (v) => (out += v));
  child.stderr.on("data", (v) => (err += v));
  const closed = once(child, "close");
  child.stdin.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "set_workflow_state", arguments: args },
    }) + "\n",
  );
  assert.equal((await closed)[0], 0, err);
  assert.ok(!JSON.parse(out).result.isError, out);
  return readTask(stateDir, id);
}
const fixture = spawn(
  process.execPath,
  ["tests/browser-fixture.mjs", String(port)],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let browser;
try {
  await new Promise((resolve, reject) => {
    fixture.stdout.once("data", resolve);
    fixture.once("error", reject);
    fixture.once("exit", (c) => reject(Error(`fixture exit ${c}`)));
  });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CREW_BROWSER_EXECUTABLE
      ? { executablePath: process.env.CREW_BROWSER_EXECUTABLE }
      : {}),
  });
  const context = await browser.newContext({
      viewport: { width: 1400, height: 950 },
    }),
    page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(origin);
  const snapshot = (
    await (await context.request.get(`${origin}/__state`)).json()
  ).orchestration;
  const publish = async (task) => {
    snapshot.tasks = [task];
    await context.request.post(`${origin}/__control`, {
      data: { orchestration: snapshot },
    });
  };
  await publish(await readTask(stateDir, id));
  const card = page.locator(`[data-worker-id="${id}"]`);
  await card.getByLabel("Status: Not reported", { exact: true }).waitFor();
  assert.equal(await card.getByLabel(/Reported progress/).count(), 0);
  let task = await report({
    requestId: "estimate-first",
    state: "Investigating",
    progressPercent: 65,
  });
  await publish(task);
  await card.getByLabel("Reported progress: 65%", { exact: true }).waitFor();
  assert.equal(await card.getByLabel(/^Status:/).count(), 1);
  assert.equal(await card.getByLabel(/^Execution:/).count(), 0);
  await page.screenshot({ path: path.join(output, "worker-card.png") });
  task = await report({
    requestId: "estimate-revised",
    state: "Investigating wider scope",
    progressPercent: 35,
  });
  await publish(task);
  await card.getByLabel("Reported progress: 35%", { exact: true }).waitFor();
  await page.reload();
  await card.getByLabel("Reported progress: 35%", { exact: true }).waitFor();
  task = await report({ requestId: "label-only", state: "Testing" });
  await publish(task);
  await card.getByLabel("Reported progress: 35%", { exact: true }).waitFor();
  await card.click();
  await page.getByRole("tab", { name: "Overview", exact: true }).click();
  await page.getByLabel("Execution: Working", { exact: true }).waitFor();
  assert.equal(await page.getByText(/Could not refresh this worker/).count(), 0);
  await page.getByText("Workflow history", { exact: true }).click();
  await page.getByText("Reported estimate: 65%", { exact: true }).waitFor();
  await page.getByText("Reported estimate: 35%", { exact: true }).first().waitFor();
  await page.screenshot({ path: path.join(output, "worker-overview.png") });
  // Persisted clear stays unset after a native turn completes and a page reload.
  task = await report({
    requestId: "estimate-clear",
    state: "Awaiting review",
    progressPercent: null,
  });
  await updateTask(stateDir, id, (t) => {
    t.status = "completed";
  });
  await publish(await readTask(stateDir, id));
  await page.reload();
  await page
    .getByLabel("Status: Awaiting review", { exact: true })
    .first()
    .waitFor();
  assert.equal(await page.getByLabel(/Reported progress:/).count(), 0);
  assert.equal(
    (await readTask(stateDir, id)).workflowState.progressPercent,
    null,
  );
  // Existing full-replacement prompt editors remain editable and survive reload.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const role of ["worker", "manager"]) {
    await page
      .getByRole("button", {
        name: role === "worker" ? "Worker profile" : "Manager profile",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: `Update ${role} instructions`, exact: true })
      .click();
    const editor = page.getByRole("textbox", {
      name: role === "worker" ? "Worker prompt" : "Manager prompt",
      exact: true,
    });
    const custom = `Custom ${role} instructions — report when useful.`;
    await editor.fill(custom);
    await page
      .getByRole("button", { name: "Save instructions", exact: true })
      .click();
    await page
      .getByRole("button", { name: `Update ${role} instructions`, exact: true })
      .waitFor();
    await page.reload();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("button", {
        name: role === "worker" ? "Worker profile" : "Manager profile",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: `Update ${role} instructions`, exact: true })
      .click();
    assert.equal(await editor.inputValue(), custom);
  }
  await page.screenshot({
    path: path.join(output, "editable-manager-instructions.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, "mobile-settings.png") });
  assert.equal(await page.evaluate(() => window.__crewMedia.calls), 0);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        output,
        checks: [
          "MCP → disk → SSE → compiled card",
          "unset estimate",
          "revised/decreasing estimate",
          "single status",
          "reload",
          "execution in Overview",
          "cleared estimate survives native completion",
          "editable manager and worker prompts persist through reload",
          "zero media calls",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  if (fixture.exitCode === null) {
    fixture.kill("SIGTERM");
    await once(fixture, "exit");
  }
  await rm(stateDir, { recursive: true, force: true });
}
