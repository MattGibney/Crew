// Local Settings refresh ticket: real controller + compiled UI, synthetic provider, disposable capacity/profile.
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const { chromium, _electron } = await import(
  process.env.CREW_PLAYWRIGHT_MODULE || "playwright-core"
);
const output = await mkdtemp(path.join(tmpdir(), "crew-settings-refresh-"));
const root = process.cwd(),
  port = Number(process.env.CREW_ACCEPTANCE_PORT || 4392),
  origin = `http://127.0.0.1:${port}`;
const configPath = path.join(output, "config.json"),
  binary = path.join(output, "synthetic-codex"),
  calls = path.join(output, "calls.jsonl");
const config = JSON.parse(
  await readFile("config/fixture.example.json", "utf8"),
);
config.runtime = {
  port,
  dataDir: path.join(output, "state"),
  codexBinary: binary,
};
config.project.id = `settings-refresh-${path.basename(output).toLowerCase()}`;
config.project.prompts = {
  manager: path.join(output, "manager.md"),
  worker: path.join(output, "worker.md"),
};
await writeFile(config.project.prompts.manager, "ORIGINAL MANAGER");
await writeFile(config.project.prompts.worker, "ORIGINAL WORKER");
await writeFile(configPath, JSON.stringify(config));
await writeFile(calls, "");
await writeFile(
  binary,
  `#!${process.execPath}
import{createInterface}from'node:readline';import{appendFileSync}from'node:fs';
if(process.argv.includes('--version')){console.log('codex-cli synthetic');process.exit(0)}
for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);appendFileSync(${JSON.stringify(calls)},line+'\\n');if(m.id===undefined)continue;let result={};if(m.method==='account/read')result={account:{type:'chatgpt',planType:'synthetic'}};if(m.method==='config/read')result={config:{}};if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:'refresh-synthetic-thread'}};if(m.method==='thread/turns/list')result={data:[]};if(m.method==='mcpServerStatus/list')result={data:[]};if(m.method==='turn/start')result={turn:{id:'refresh-fixture-turn',status:'completed'}};console.log(JSON.stringify({id:m.id,result}));if(m.method==='turn/start')console.log(JSON.stringify({method:'turn/completed',params:{threadId:'refresh-synthetic-thread',turn:{id:'refresh-fixture-turn',status:'completed'}}}));}
`,
  { mode: 0o700 },
);
const nativeUiOnly = process.argv.includes("--native-ui-only");
const nativeMode = nativeUiOnly || process.argv.includes("--native");
const exec = promisify(execFile);
let network,
  child,
  browser,
  native,
  nativeProcess,
  diagnostics = "";
const env = {
  ...process.env,
  AI_MANAGER_CONFIG: configPath,
  AI_MANAGER_CODEX_BINARY: binary,
  CREW_GLOBAL_CAPACITY_DIR: path.join(output, "capacity"),
};
delete env.AI_MANAGER_PORT;
delete env.VOICE_PORT;
const until = async (fn, label) => {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw Error("Timed out " + label);
};
// Disposable transparent network fixture: cut an actual SSE socket without
// changing product code, restarting its controller or fabricating browser events.
async function networkFixture() {
  let paused = false,
    proxyOrigin;
  const streams = new Set(),
    requests = new Set(),
    waiting = new Set();
  const proxy = http.createServer((request, response) => {
    const open = () => {
      const headers = { ...request.headers, host: new URL(origin).host };
      if (headers.origin === proxyOrigin) headers.origin = origin;
      const upstream = http.request(
        origin + request.url,
        { method: request.method, headers },
        (incoming) => {
          response.writeHead(incoming.statusCode, incoming.headers);
          incoming.pipe(response);
        },
      );
      requests.add(upstream);
      if (request.url === "/events") streams.add(response);
      response.on("close", () => {
        streams.delete(response);
        requests.delete(upstream);
        upstream.destroy();
      });
      upstream.on("error", () => response.destroy());
      request.pipe(upstream);
    };
    if (paused && request.url === "/events") {
      waiting.add(open);
      response.on("close", () => waiting.delete(open));
    } else open();
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  proxyOrigin = `http://127.0.0.1:${proxy.address().port}`;
  return {
    origin: proxyOrigin,
    disconnect() {
      paused = true;
      for (const stream of streams) stream.destroy();
    },
    reconnect() {
      paused = false;
      for (const open of waiting) open();
      waiting.clear();
    },
    async close() {
      for (const stream of streams) stream.destroy();
      for (const request of requests) request.destroy();
      proxy.closeAllConnections();
      await new Promise((resolve) => proxy.close(resolve));
    },
  };
}
// Cleanup registered before first observation wait. Never touch an inherited ledger.
async function cleanup() {
  if (nativeProcess?.exitCode === null) {
    await fetch(origin + "/api/manager/lifecycle", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
    }).catch(() => {});
  }
  if (
    nativeUiOnly &&
    nativeProcess?.exitCode === null &&
    nativeProcess.signalCode === null
  ) {
    // UI-only acceptance does not exercise application Quit. Stop the exact
    // disposable controller through its normal CLI, then end our owned shell.
    await native.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.close();
    });
    await exec(
      process.execPath,
      [path.join(root, "runtime/cli.mjs"), "stop", "--config", configPath],
      { env, timeout: 20000 },
    );
    const exited = once(nativeProcess, "exit");
    nativeProcess.kill("SIGTERM");
    let exitTimer;
    try {
      await Promise.race([
        exited,
        new Promise((_, reject) => {
          exitTimer = setTimeout(
            () => reject(Error("Owned UI fixture shell did not exit")),
            15000,
          );
        }),
      ]);
    } catch (error) {
      // The controller has already acknowledged normal CLI shutdown. Only
      // this process handle's isolated test shell may be forcibly cleaned;
      // this is fixture disposal, never a successful product Quit assertion.
      if (!nativeProcess.spawnargs.includes(configPath)) throw error;
      if (nativeProcess.exitCode === null && nativeProcess.signalCode === null)
        nativeProcess.kill("SIGKILL");
      await exited;
    } finally {
      clearTimeout(exitTimer);
      await writeFile(
        path.join(output, "fixture-cleanup.json"),
        JSON.stringify(
          {
            scope:
              "isolated native UI test shell after normal disposable-controller CLI shutdown",
            pid: nativeProcess.pid,
            exitCode: nativeProcess.exitCode,
            signalCode: nativeProcess.signalCode,
            productQuitAcceptance: "excluded",
            forcedFixtureCleanup: nativeProcess.signalCode === "SIGKILL",
          },
          null,
          2,
        ) + "\n",
      );
    }
  }
  if (
    !nativeUiOnly &&
    nativeProcess?.exitCode === null &&
    nativeProcess.signalCode === null
  ) {
    await native.evaluate(({ BrowserWindow, dialog, Menu }) => {
      for (const w of BrowserWindow.getAllWindows()) w.close();
      dialog.showMessageBox = async () => ({ response: 1 });
      Menu.getApplicationMenu()
        .items[0].submenu.items.find((x) => x.label === "Quit Crew…")
        .click();
    });
    let detachTimer;
    try {
      await Promise.race([
        native.close().catch(() => {}),
        new Promise((_, reject) => {
          detachTimer = setTimeout(
            () => reject(Error("Native inspector detach timeout")),
            30000,
          );
        }),
      ]);
    } finally {
      clearTimeout(detachTimer);
    }
    await until(
      () =>
        nativeProcess.exitCode !== null || nativeProcess.signalCode !== null,
      "owned native Quit",
    );
  }
  await browser?.close();
  await network?.close();
  if (child?.exitCode === null && child.signalCode === null) {
    const done = once(child, "exit");
    child.kill("SIGTERM");
    await done;
  }
  const fixturePath = path.join(output, "state/orchestration/fixture.json");
  try {
    const f = JSON.parse(await readFile(fixturePath, "utf8"));
    assert.match(f.base, /[/\\]crew-fixture-[^/\\]+$/);
    assert.equal(f.repo, path.join(f.base, "repo"));
    await rm(f.base, { recursive: true, force: true });
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}
try {
  let context, page;
  const errors = [];
  if (nativeMode) {
    await mkdir(path.join(output, "state"), { recursive: true });
    await writeFile(
      path.join(output, "state/manager-chat.json"),
      JSON.stringify({ threadId: "refresh-synthetic-thread" }),
    );
    const nativeEnv = {
      ...env,
      CREW_APP_DATA: path.join(output, "native-profile"),
    };
    delete nativeEnv.ELECTRON_RUN_AS_NODE;
    native = await _electron.launch({
      executablePath:
        process.env.CREW_ACCEPTANCE_EXECUTABLE ||
        path.join(
          root,
          "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
        ),
      args: process.env.CREW_ACCEPTANCE_EXECUTABLE
        ? ["--config", configPath]
        : [root, "--config", configPath],
      env: nativeEnv,
      timeout: 45000,
    });
    nativeProcess = native.process();
    nativeProcess.stderr.on("data", (d) => (diagnostics += d));
    context = native.context();
    page = await native.firstWindow();
    await page.waitForURL(origin + "/**", { timeout: 45000 });
  } else {
    child = spawn(process.execPath, ["runtime/server.mjs"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => (diagnostics += d));
    child.stderr.on("data", (d) => (diagnostics += d));
    await until(async () => {
      if (child.exitCode !== null) throw Error(diagnostics);
      try {
        const response = await fetch(origin + "/api/settings");
        return (
          response.ok && (await response.json()).projectId === config.project.id
        );
      } catch {
        return false;
      }
    }, "real controller");
    network = await networkFixture();
    browser = await chromium.launch({
      headless: true,
      ...(process.env.CREW_BROWSER_EXECUTABLE
        ? { executablePath: process.env.CREW_BROWSER_EXECUTABLE }
        : {}),
    });
    context = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
    });
    page = await context.newPage();
  }
  const guard = () => {
    window.__capture = 0;
    navigator.mediaDevices.getUserMedia = async () => {
      window.__capture++;
      throw Error("Physical media forbidden");
    };
    window.__streams = 0;
    const ES = window.EventSource;
    window.EventSource = class extends ES {
      constructor(...a) {
        super(...a);
        window.__streams++;
      }
    };
  };
  await context.addInitScript(guard);
  if (nativeMode) await page.evaluate(guard);
  page.on("pageerror", (e) => errors.push(e.message));
  const settings = async () => {
    const r = await context.request.get(origin + "/api/settings");
    assert.equal(r.status(), 200);
    return r.json();
  };
  const save = async (role, text) => {
    const s = await settings();
    const r = await context.request.put(origin + "/api/settings/prompts", {
      headers: { Origin: origin },
      data: { role, text, expectedVersion: s[role].saved.version },
    });
    assert.equal(r.status(), 200, await r.text());
    return r.json();
  };
  const profile = (role) =>
    page.getByLabel(
      `${role === "worker" ? "Worker" : "Manager"} profile settings`,
      { exact: true },
    );
  const openRole = async (role) =>
    page
      .getByRole("button", {
        name: `${role === "worker" ? "Worker" : "Manager"} profile`,
        exact: true,
      })
      .click();
  if (!nativeMode) await page.goto(network.origin);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await openRole("worker");
  await profile("worker")
    .getByText("ORIGINAL WORKER", { exact: true })
    .waitFor();
  await save("worker", "EXTERNAL WORKER");
  await profile("worker")
    .getByText("EXTERNAL WORKER", { exact: true })
    .waitFor();
  await profile("worker")
    .getByRole("button", { name: "Update worker instructions" })
    .click();
  const editor = page.getByLabel("Worker prompt", { exact: true });
  await editor.fill("LOCAL DIRTY DRAFT");
  await save("worker", "CONCURRENT EXTERNAL");
  await profile("worker")
    .getByRole("alert")
    .filter({ hasText: "saved version changed" })
    .waitFor();
  assert.equal(await editor.inputValue(), "LOCAL DIRTY DRAFT");
  assert.equal(
    await profile("worker")
      .getByRole("button", { name: "Save instructions", exact: true })
      .isDisabled(),
    true,
  );
  await profile("worker")
    .getByRole("button", { name: "Cancel changes" })
    .click();
  await profile("worker")
    .getByText("CONCURRENT EXTERNAL", { exact: true })
    .waitFor();
  await profile("worker")
    .getByRole("button", { name: "Update worker instructions" })
    .click();
  await editor.fill("MATCHING EXTERNAL");
  await save("worker", "MATCHING EXTERNAL");
  await until(
    async () =>
      (await profile("worker")
        .getByText("Unsaved changes", { exact: true })
        .count()) === 0,
    "matching external no conflict",
  );
  await editor.fill("FRESH EDIT AFTER MATCH");
  assert.equal(
    await profile("worker")
      .getByRole("button", { name: "Save instructions", exact: true })
      .isEnabled(),
    true,
  );
  await profile("worker")
    .getByRole("button", { name: "Cancel changes" })
    .click();

  await save("manager", "EXTERNAL MANAGER");
  await openRole("manager");
  await profile("manager")
    .getByText("EXTERNAL MANAGER", { exact: true })
    .waitFor();
  await profile("manager")
    .getByText(/Restart your manager/)
    .waitFor();
  assert.equal((await settings()).worker.saved.text, "MATCHING EXTERNAL");
  // Delay the PUT acknowledgement after it has durably saved; edit again before it returns.
  await openRole("worker");
  await profile("worker")
    .getByRole("button", { name: "Update worker instructions" })
    .click();
  await editor.fill("SAVED FIRST");
  let releaseSave, saveArrived;
  const pendingSave = new Promise((r) => (saveArrived = r)),
    saveGate = new Promise((r) => (releaseSave = r));
  await page.route(
    "**/api/settings/prompts",
    async (route) => {
      const response = await route.fetch();
      saveArrived();
      await saveGate;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  await profile("worker")
    .getByRole("button", { name: "Save instructions", exact: true })
    .click();
  await pendingSave;
  await editor.fill("NEWER TYPED DRAFT");
  await save("worker", "EXTERNAL AFTER SAVE");
  releaseSave();
  await until(
    async () =>
      !(
        await profile("worker")
          .getByRole("button", { name: "Save instructions", exact: true })
          .innerText()
      ).includes("Saving"),
    "delayed save acknowledgement",
  );
  assert.equal(await editor.inputValue(), "NEWER TYPED DRAFT");
  await profile("worker")
    .getByRole("alert")
    .filter({ hasText: "saved version changed" })
    .waitFor();
  await profile("worker")
    .getByRole("button", { name: "Cancel changes" })
    .click();
  if (!nativeMode) {
    // Retyping the old saved text during a pending save is still a newer edit.
    await profile("worker")
      .getByRole("button", { name: "Update worker instructions" })
      .click();
    await editor.fill("WRITE BEFORE REVERT");
    let releaseRevert, requestHeld;
    const revertGate = new Promise((r) => (releaseRevert = r)),
      heldRequest = new Promise((r) => (requestHeld = r));
    await page.route(
      "**/api/settings/prompts",
      async (route) => {
        requestHeld();
        await revertGate;
        await route.continue();
      },
      { times: 1 },
    );
    await profile("worker")
      .getByRole("button", { name: "Save instructions", exact: true })
      .click();
    await heldRequest;
    await editor.fill("EXTERNAL AFTER SAVE");
    releaseRevert();
    await until(
      async () =>
        await profile("worker")
          .getByRole("button", { name: "Save instructions", exact: true })
          .isEnabled(),
      "reverted newer edit remains editable",
    );
    assert.equal(await editor.inputValue(), "EXTERNAL AFTER SAVE");
    await profile("worker")
      .getByRole("button", { name: "Cancel changes" })
      .click();
    // Hold an old GET, invalidate it, then let the newer authoritative read win.
    let releaseRead, readArrived;
    const pendingRead = new Promise((r) => (readArrived = r)),
      readGate = new Promise((r) => (releaseRead = r));
    await page.route(
      "**/api/settings",
      async (route) => {
        const response = await route.fetch();
        readArrived();
        await readGate;
        await route.fulfill({ response });
      },
      { times: 1 },
    );
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await pendingRead;
    await save("worker", "LATEST AFTER DELAY");
    releaseRead();
    await profile("worker")
      .getByText("LATEST AFTER DELAY", { exact: true })
      .waitFor();
    // Failed refresh retains values and gives a retry. No model/runtime action is needed.
    await page.route("**/api/settings", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Refresh temporarily unavailable" }),
      }),
    );
    await save("worker", "RECOVERED WORKER");
    await page
      .getByRole("button", { name: "Reload settings", exact: true })
      .waitFor();
    await profile("worker")
      .getByText("LATEST AFTER DELAY", { exact: true })
      .waitFor();
    await page.unroute("**/api/settings");
    await page
      .getByRole("button", { name: "Reload settings", exact: true })
      .click();
    await profile("worker")
      .getByText("RECOVERED WORKER", { exact: true })
      .waitFor();
    // Wrong-project response cannot overwrite the selected project's profiles.
    await page.route(
      "**/api/settings",
      async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        body.projectId = "another-project";
        body.worker.saved.text = "FOREIGN PROJECT";
        await route.fulfill({ response, json: body });
      },
      { times: 1 },
    );
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("button", { name: "Reload settings", exact: true })
      .waitFor();
    assert.equal(
      await profile("worker")
        .getByText("FOREIGN PROJECT", { exact: true })
        .count(),
      0,
    );
    await page
      .getByRole("button", { name: "Reload settings", exact: true })
      .click();
    // Cut the actual connection: Chromium's offline emulation can leave an
    // already-open SSE socket alive, so a mere offline toggle proves nothing.
    network.disconnect();
    await page.getByText("Reconnecting…", { exact: true }).waitFor();
    await save("worker", "MISSED WHILE OFFLINE");
    network.reconnect();
    await profile("worker")
      .getByText("MISSED WHILE OFFLINE", { exact: true })
      .waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await save("worker", "SAVED WHILE SETTINGS CLOSED");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await profile("worker")
      .getByText("SAVED WHILE SETTINGS CLOSED", { exact: true })
      .waitFor();
  } else {
    await profile("worker")
      .getByText("EXTERNAL AFTER SAVE", { exact: true })
      .waitFor();
  }
  assert.equal(
    await page.evaluate(() => window.__streams),
    nativeMode ? 0 : 1,
    "one EventSource instance across opening, refresh and reconnect",
  );
  assert.equal(await page.evaluate(() => window.__capture), 0);
  assert.deepEqual(errors, []);
  const protocol = (await readFile(calls, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  assert.equal(
    protocol.some((x) =>
      ["turn/start", "thread/realtime/start"].includes(x.method),
    ),
    false,
  );
  if (!nativeMode) {
    // The earlier no-turn assertion proves saves themselves start nothing.
    // Now explicitly exercise one disposable worker after a real UI save.
    await profile("worker")
      .getByRole("button", { name: "Update worker instructions" })
      .click();
    await editor.fill("PROFILE SAVED IN UI FOR NEXT WORKER");
    await profile("worker")
      .getByRole("button", { name: "Save instructions", exact: true })
      .click();
    await profile("worker")
      .getByText("PROFILE SAVED IN UI FOR NEXT WORKER", { exact: true })
      .waitFor();
    const { createTask, readTask } =
      await import("../runtime/orchestration/store.mjs");
    const stateDir = path.join(output, "state/orchestration"),
      taskId = "ui-saved-profile-worker";
    await createTask(stateDir, {
      requestId: taskId,
      ticket: "LOCAL-SETTINGS",
      brief: "Explicit synthetic worker profile check only.",
      projectId: config.project.id,
    });
    await until(async () => {
      const task = await readTask(stateDir, taskId);
      if (!task.runDir || task.execution?.live !== false) return false;
      const terminal = await readFile(
        path.join(task.runDir, "exit.json"),
        "utf8",
      )
        .then(JSON.parse)
        .catch(() => null);
      return terminal?.runId === task.runId && terminal.connectionClosed;
    }, "explicit synthetic worker exit");
    const after = (await readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
    const turns = after.filter((call) => call.method === "turn/start");
    assert.equal(turns.length, 1);
    assert.ok(
      turns[0].params.input[0].text.startsWith(
        "PROFILE SAVED IN UI FOR NEXT WORKER\n",
      ),
    );
    assert.equal(
      after.some((call) => call.method === "thread/realtime/start"),
      false,
    );
    assert.equal(await page.evaluate(() => window.__capture), 0);
  }
  async function fingerprint(directories, accept = () => true) {
    const files = [];
    async function collect(directory) {
      for (const entry of await readdir(path.join(root, directory), {
        withFileTypes: true,
      })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await collect(file);
        else if (entry.isFile() && accept(file)) files.push(file);
      }
    }
    for (const directory of directories) await collect(directory);
    const hash = createHash("sha256");
    for (const file of files.sort()) {
      hash.update(file);
      hash.update("\0");
      hash.update(await readFile(path.join(root, file)));
      hash.update("\0");
    }
    return { sha256: hash.digest("hex"), files: files.length };
  }
  await writeFile(
    path.join(output, "evidence.json"),
    JSON.stringify(
      {
        scope:
          "combined Settings freshness and saved worker-profile implementation",
        baseCommit: (
          await exec("git", ["rev-parse", "HEAD"], { cwd: root })
        ).stdout.trim(),
        nativeMode,
        nativeUiOnly,
        source: await fingerprint(["src", "renderer/src", "prompts"]),
        runtime: await fingerprint(["runtime"], (file) =>
          /\.(mjs|js|css|html)$/.test(file),
        ),
        syntheticProvider: true,
        noPhysicalCapture: true,
        controllerConfig: configPath,
        networkFixture: network
          ? "transparent proxy with an observed SSE socket cut/reconnect"
          : "direct native controller",
        shutdownAcceptance: nativeUiOnly
          ? "excluded; fixture CLI stop and owned-shell termination only"
          : "separate from UI assertions",
      },
      null,
      2,
    ) + "\n",
  );
  await page.screenshot({ path: path.join(output, "settings-refresh.png") });
  console.log(
    JSON.stringify({
      output,
      result: "passed",
      nativeMode,
      nativeUiOnly,
      actualController: true,
      compiledRenderer: true,
      syntheticProvider: true,
      checks: nativeMode
        ? [
            "external clean worker/manager refresh",
            "dirty conflict",
            "save/edit race",
            "existing SSE retained",
            "no model turns or capture",
          ]
        : [
            "external clean worker/manager refresh",
            "dirty conflict",
            "save/edit and refresh races",
            "error retry",
            "project identity rejection",
            "offline reconnect",
            "reopen",
            "one SSE",
            "no unsolicited turns or capture; one explicit synthetic worker after UI save",
          ],
    }),
  );
} catch (error) {
  console.error("Acceptance failure:", output, diagnostics, error);
  for (const p of native?.windows() ||
    browser?.contexts().flatMap((context) => context.pages()) ||
    []) {
    console.error(
      "Fixture page:",
      p.url(),
      (
        await p
          .locator("body")
          .innerText()
          .catch(() => "")
      ).slice(0, 3000),
    );
    await p
      .screenshot({ path: path.join(output, "ui-failure.png") })
      .catch(() => {});
  }
  throw error;
} finally {
  await cleanup();
}
