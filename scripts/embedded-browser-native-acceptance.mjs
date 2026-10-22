// GH-56: real Crew window/renderer + isolated synthetic backend and local preview.
// Independent MCP stdio client only. No agent runtime, profile, voice or worker.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { WebSocket } from "ws";
const { _electron } = await import(
  process.env.CREW_PLAYWRIGHT_MODULE || "playwright-core"
);
const root = path.resolve(process.cwd());
const dir = await mkdtemp(path.join(tmpdir(), "crew56-browser-"));
const evidence = { directory: dir, checks: [], errors: [], versions: {} };
const check = (name, value = true) => {
  assert.ok(value, name);
  evidence.checks.push(name);
  console.log("PASS", name);
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(read, test, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (test(value)) return value;
    await delay(100);
  }
  throw Error("Timed out: " + label);
}
let electron, fixture, mcp, host, previewPage, endpoint;
const hits = [];
const previewServer = http.createServer((req, res) => {
  hits.push(req.url);
  res.setHeader("Content-Type", "text/html");
  res.setHeader("Cache-Control", "no-store");
  if (req.url === "/redirect-host") {
    res.writeHead(302, { Location: origin });
    res.end();
    return;
  }
  const second = req.url.startsWith("/second");
  res.end(
    `<!doctype html><meta charset="utf-8"><title>${second ? "Second page" : "Shared Crew preview"}</title><style>body{font:18px system-ui;margin:0;padding:36px;background:#f4f8f5;color:#18362a}small{color:#537464}h1{font-size:32px;letter-spacing:-1px}input,button{font:inherit;padding:12px;border:1px solid #a8c6b3;border-radius:8px}input{width:80%;margin:8px 0}button{background:#215c43;color:white;cursor:pointer;margin:12px 0}section{background:white;padding:24px;border-radius:16px}a{color:#215c43}output{display:block;padding:12px 0;font-weight:bold}</style><small>CREW · SHARED BROWSER EXPERIMENT · #56</small><h1>${second ? "Navigation works" : "One page, shared control"}</h1><p>This local page is inside Crew. The independent MCP harness and native user input share it.</p><section><label for="name">Preview note</label><input id="name" placeholder="Type a note"><button id="apply" onclick="document.querySelector('output').textContent='Saved: '+document.querySelector('input').value">Apply note</button><output>Waiting for a note</output><a href="${second ? "/" : "/second"}">${second ? "First page" : "Second page"}</a></section>`,
  );
});
let origin;
const pending = new Map();
let nextId = 0;
function rpc(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error("MCP timeout " + method));
    }, 45000);
    pending.set(id, { resolve, reject, timer });
    mcp.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
    );
  });
}
function stopMcp() {
  if (!mcp) return Promise.resolve();
  const child = mcp;
  mcp = undefined;
  return (async () => {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      const done = once(child, "exit");
      child.kill("SIGTERM");
      await done;
    }
  })();
}
async function startMcp(url) {
  const bin = process.env.CREW_CHROME_MCP_BIN;
  assert.ok(
    bin,
    "Set CREW_CHROME_MCP_BIN to installed chrome-devtools-mcp JS entrypoint",
  );
  const args = [
    bin,
    "--wsEndpoint",
    url,
    "--logFile",
    path.join(dir, "mcp-debug.log"),
    "--no-usage-statistics",
    "--no-performance-crux",
    "--no-category-performance",
    "--no-category-emulation",
    "--no-category-network",
    "--no-category-memory",
    "--no-file-navigations",
  ];
  mcp = spawn(process.execPath, args, {
    cwd: dir,
    env: { ...process.env, CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  mcp.stderr.on("data", (bytes) =>
    evidence.errors.push(bytes.toString().slice(0, 3000)),
  );
  createInterface({ input: mcp.stdout }).on("line", (line) => {
    let v;
    try {
      v = JSON.parse(line);
    } catch {
      return;
    }
    const entry = pending.get(v.id);
    if (!entry) return;
    pending.delete(v.id);
    clearTimeout(entry.timer);
    v.error ? entry.reject(Error(v.error.message)) : entry.resolve(v.result);
  });
  mcp.on("exit", () => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(Error("MCP exited"));
    }
    pending.clear();
  });
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "crew56-independent-harness", version: "1" },
  });
  evidence.versions.mcp = initialized.serverInfo;
  mcp.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
      "\n",
  );
  evidence.tools = (await rpc("tools/list")).tools.map((t) => ({
    name: t.name,
    inputSchema: t.inputSchema,
  }));
}
let pageId;
async function tool(name, args = {}) {
  if (name !== "list_pages" && pageId) args = { pageId, ...args };
  const result = await rpc("tools/call", { name, arguments: args });
  await writeFile(
    path.join(dir, `mcp-${++toolCounter}-${name}.json`),
    JSON.stringify(result, null, 2),
  );
  if (result.isError) throw Error(JSON.stringify(result));
  return result;
}
let toolCounter = 0;
const text = (result) =>
  result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
async function cleanup() {
  const results = await Promise.allSettled([
    stopMcp(),
    electron?.close(),
    (async () => {
      if (fixture && fixture.exitCode === null && fixture.signalCode === null) {
        const done = once(fixture, "exit");
        fixture.kill("SIGTERM");
        await done;
      }
    })(),
    new Promise((resolve) => previewServer.close(resolve)),
  ]);
  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length)
    throw new AggregateError(
      failures.map((r) => r.reason),
      "Fixture cleanup failed",
    );
}
try {
  await new Promise((resolve) => previewServer.listen(0, "127.0.0.1", resolve));
  const previewOrigin = `http://127.0.0.1:${previewServer.address().port}`;
  // Reserve a local backend port without touching an existing Crew controller.
  const reservation = http.createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  origin = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    CREW_APP_DATA: path.join(dir, "app-data"),
    CREW_GLOBAL_CAPACITY_DIR: path.join(dir, "capacity"),
    CREW_BROWSER_EXPERIMENT_URL: previewOrigin,
    CREW_BROWSER_CDP_TRACE: "1",
    AI_MANAGER_CONFIG: path.join(dir, "unused-config.json"),
  };
  for (const key of ["AI_MANAGER_PORT", "VOICE_PORT", "ELECTRON_RUN_AS_NODE"])
    delete env[key];
  fixture = spawn(
    process.execPath,
    [path.join(root, "tests/browser-fixture.mjs"), String(port)],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  await until(
    () =>
      fetch(origin + "/api/settings")
        .then((r) => r.ok)
        .catch(() => false),
    Boolean,
    "fixture",
  );
  const main = path.join(dir, "main.cjs");
  await writeFile(
    main,
    `const {app,ipcMain}=require('electron');app.setPath('userData',${JSON.stringify(path.join(dir, "profile"))});app.whenReady().then(async()=>{const {createProjectWindow}=await import(${JSON.stringify(path.join(root, "runtime/desktop/project-window.mjs"))});global.project=createProjectWindow({root:${JSON.stringify(path.join(root, "runtime"))},desktopData:${JSON.stringify(dir)},key:'issue56',configPath:'fixture',isSelected:()=>true,ready:()=>true,projectName:()=> 'Crew browser experiment #56',getOrigin:()=>${JSON.stringify(origin)},getError:()=>null,isQuitting:()=>false,disconnect:async()=>{},openSetup:async()=>{},statusChanged:async()=>{},safe:String});ipcMain.handle('crew:workspaces',()=>({selectedId:'issue56',projects:[{id:'issue56',name:'Crew browser experiment #56',selected:true}],capacity:{workerLimit:1}}));ipcMain.handle('crew:browser',(event,input)=>{if(!global.project.accepts(event))throw Error('Rejected browser IPC');return global.project.browserRequest(input);});global.project.configurePermissions();await global.project.open();});app.on('window-all-closed',()=>app.quit());`,
  );
  electron = await _electron.launch({
    executablePath:
      process.env.CREW_ACCEPTANCE_EXECUTABLE ||
      path.join(
        root,
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      ),
    args: [main],
    env,
  });
  electron.on("console", (msg) => {
    evidence.errors.push(msg.text());
  });
  host = await electron.firstWindow();
  await host.getByRole("button", { name: "Browser", exact: true }).waitFor();
  await host.getByRole("tab", { name: "Text", exact: true }).click();
  await host
    .getByRole("textbox", { name: "Message your manager", exact: true })
    .fill("Retained manager draft");
  await host.getByRole("button", { name: "Browser", exact: true }).click();
  endpoint = await until(
    () => electron.evaluate(() => global.project.browserEndpoint()),
    Boolean,
    "preview endpoint",
  );
  evidence.endpoint = endpoint;
  evidence.previewOrigin = previewOrigin;
  evidence.hostOrigin = origin;
  previewPage = await until(
    async () =>
      (await electron.context().pages()).find((p) =>
        p.url().startsWith(previewOrigin),
      ),
    Boolean,
    "embedded page",
  );
  await previewPage
    .getByRole("heading", { name: "One page, shared control" })
    .waitFor();
  await until(
    () =>
      electron.evaluate(({ webContents }) =>
        webContents
          .getAllWebContents()
          .filter((w) => w.getURL().startsWith("http"))
          .map((w) => ({ url: w.getURL(), prefs: w.getLastWebPreferences() })),
      ),
    (v) => v.length === 2,
    "two actual web contents",
  );
  evidence.versions.electron = await electron.evaluate(() => process.versions);
  check("Real Crew panel and separate preview WebContents open");
  await startMcp(endpoint);
  const pages = text(await tool("list_pages"));
  check(
    "MCP discovers only the intended visible preview",
    pages.includes(previewOrigin) && !pages.includes(origin),
  );
  pageId = Number(pages.match(/(\d+):/)?.[1]);
  assert.ok(pageId, pages);
  let snapshot = text(await tool("take_snapshot"));
  evidence.firstSnapshot = snapshot;
  const inputUid = snapshot.match(
    /uid=([\w.:-]+)[^\n]*textbox[^\n]*Preview note/,
  )?.[1];
  const buttonUid = snapshot.match(
    /uid=([\w.:-]+)[^\n]*button[^\n]*Apply note/,
  )?.[1];
  assert.ok(inputUid && buttonUid, snapshot);
  await tool("fill", {
    uid: inputUid,
    value: "Written through independent MCP",
  });
  await tool("click", { uid: buttonUid });
  await previewPage
    .getByText("Saved: Written through independent MCP", { exact: true })
    .waitFor();
  check("MCP type and click change the exact visible page");
  await tool("take_screenshot", {
    filePath: path.join(dir, "mcp-preview.png"),
  });
  await host.screenshot({ path: path.join(dir, "crew-host-only.png") });
  await writeFile(
    path.join(dir, "crew-window-capture.png"),
    Buffer.from(
      await electron.evaluate(async ({ BrowserWindow }) =>
        (await BrowserWindow.getAllWindows()[0].capturePage())
          .toPNG()
          .toString("base64"),
      ),
      "base64",
    ),
  );
  if (process.platform === "darwin") {
    const swift = path.join(dir, "window.swift");
    await writeFile(
      swift,
      `import CoreGraphics\nimport Foundation\nlet pid = Int32(CommandLine.arguments[1])!\nfor info in CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as! [[String: Any]] { if info[kCGWindowOwnerPID as String] as? Int32 == pid, let n = info[kCGWindowNumber as String] as? Int, info[kCGWindowLayer as String] as? Int == 0 { print(n); break } }\n`,
    );
    const { stdout } = await exec("/usr/bin/swift", [
      swift,
      String(electron.process().pid),
    ]);
    assert.ok(/^\d+\s*$/.test(stdout), "Native visible window id");
    await exec("/usr/sbin/screencapture", [
      "-x",
      "-o",
      "-l",
      stdout.trim(),
      path.join(dir, "crew-panel-native.png"),
    ]);
    evidence.nativeWindowId = stdout.trim();
  }
  // Native input dispatched through Electron's window, not CDP or DOM mutation.
  const rect = await host.locator("[data-browser-viewport]").boundingBox();
  const inputRect = await previewPage.locator("input").boundingBox();
  await electron.evaluate(
    ({ BrowserWindow }, { x, y }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.focus();
      w.webContents.mainFrame;
      w.contentView.children
        .find((v) => v.webContents && v.webContents !== w.webContents)
        .webContents.sendInputEvent({
          type: "mouseDown",
          x,
          y,
          button: "left",
          clickCount: 1,
        });
      w.contentView.children
        .find((v) => v.webContents && v.webContents !== w.webContents)
        .webContents.sendInputEvent({
          type: "mouseUp",
          x,
          y,
          button: "left",
          clickCount: 1,
        });
    },
    { x: Math.round(inputRect.x + 30), y: Math.round(inputRect.y + 15) },
  );
  await previewPage.keyboard.press("Meta+A");
  await previewPage.keyboard.type("Native visible edit");
  check(
    "Synthetic native user input is visible to MCP",
    text(await tool("take_snapshot")).includes("Native visible edit"),
  );
  await tool("navigate_page", { type: "url", url: previewOrigin + "/second" });
  await previewPage
    .getByRole("heading", { name: "Navigation works" })
    .waitFor();
  check("MCP navigation reaches visible second page");
  await host.getByRole("button", { name: "Browser back", exact: true }).click();
  await previewPage
    .getByRole("heading", { name: "One page, shared control" })
    .waitFor();
  await host
    .getByRole("button", { name: "Browser forward", exact: true })
    .click();
  await previewPage
    .getByRole("heading", { name: "Navigation works" })
    .waitFor();
  await host.getByRole("button", { name: "Reload browser page" }).click();
  await previewPage
    .getByRole("heading", { name: "Navigation works" })
    .waitFor();
  check("Panel back, forward and reload work");
  await host
    .getByRole("textbox", { name: "Browser address" })
    .fill(previewOrigin + "/");
  await host.getByRole("textbox", { name: "Browser address" }).press("Enter");
  await previewPage
    .getByRole("heading", { name: "One page, shared control" })
    .waitFor();
  await host.getByRole("textbox", { name: "Browser address" }).fill(origin);
  await host.getByRole("textbox", { name: "Browser address" }).press("Enter");
  await host
    .getByRole("alert")
    .filter({ hasText: "configured local preview origin" })
    .waitFor();
  check("Panel denies navigation to Crew host");
  check(
    "External content has no Crew bridge or Node",
    await previewPage.evaluate(
      () =>
        !window.crewBrowser &&
        !window.crewWorkspaces &&
        !window.crewWindow &&
        typeof require === "undefined" &&
        typeof process === "undefined",
    ),
  );
  const blocked = await tool("evaluate_script", {
    function: `async()=>{try {await fetch(${JSON.stringify(origin + "/api/settings")});return false;}catch{return true;}}`,
  });
  check(
    "MCP preview cannot fetch privileged Crew origin",
    text(blocked).includes("true"),
  );
  const navigation = await rpc("tools/call", {
    name: "navigate_page",
    arguments: { pageId, type: "url", url: origin },
  });
  check(
    "MCP navigation cannot load Crew host",
    navigation.isError || !previewPage.url().startsWith(origin),
  );
  await tool("navigate_page", { type: "url", url: previewOrigin });
  const redirect = await rpc("tools/call", {
    name: "navigate_page",
    arguments: { pageId, type: "url", url: previewOrigin + "/redirect-host" },
  });
  check(
    "Redirect cannot load Crew host",
    redirect.isError || !previewPage.url().startsWith(origin),
  );
  await tool("navigate_page", { type: "url", url: previewOrigin });
  await stopMcp();
  // Probe forbidden browser/target methods directly, including with a valid session.
  const ws = new WebSocket(endpoint);
  await once(ws, "open");
  let id = 0;
  async function cdp(method, params = {}, sessionId) {
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(Error("CDP timeout " + method)),
        5000,
      );
      const on = (bytes) => {
        const r = JSON.parse(bytes);
        if (r.id !== requestId) return;
        clearTimeout(timeout);
        ws.off("message", on);
        resolve(r);
      };
      ws.on("message", on);
      ws.send(
        JSON.stringify({
          id: requestId,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  }
  const targets = (await cdp("Target.getTargets")).result.targetInfos;
  check(
    "Scoped endpoint exposes exactly one preview target",
    targets.length === 1 && targets[0].url.startsWith(previewOrigin),
  );
  const session = (
    await cdp("Target.attachToTarget", {
      targetId: targets[0].targetId,
      flatten: true,
    })
  ).result.sessionId;
  for (const method of [
    "Browser.close",
    "Target.createTarget",
    "Target.createBrowserContext",
    "Target.getTargets",
    "SystemInfo.getInfo",
    "IO.read",
  ]) {
    const response = await cdp(method, {}, session);
    check("Scoped endpoint rejects " + method, Boolean(response.error));
  }
  check(
    "Foreign target attach rejected",
    Boolean(
      (
        await cdp("Target.attachToTarget", {
          targetId: "crew-host",
          flatten: true,
        })
      ).error,
    ),
  );
  check(
    "Foreign session rejected",
    Boolean(
      (await cdp("Runtime.evaluate", { expression: "1" }, "foreign")).error,
    ),
  );
  ws.close();
  await once(ws, "close");
  await startMcp(endpoint);
  check(
    "Fresh MCP client reconnects to same visible page",
    text(await tool("list_pages")).includes(previewOrigin),
  );
  await stopMcp();
  await host
    .getByRole("textbox", { name: "Browser address" })
    .fill(previewOrigin);
  await host.getByRole("textbox", { name: "Browser address" }).press("Enter");
  // Resize inside actual native window and verify clipped bounds/focus recovery.
  await electron.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(650, 700),
  );
  await until(
    () => host.locator("[data-browser-viewport]").boundingBox(),
    (r) => r?.width > 400,
    "narrow layout",
  );
  await host.screenshot({ path: path.join(dir, "crew-host-narrow-only.png") });
  if (evidence.nativeWindowId)
    await exec("/usr/sbin/screencapture", [
      "-x",
      "-o",
      "-l",
      evidence.nativeWindowId,
      path.join(dir, "crew-panel-narrow-native.png"),
    ]);
  await host.getByRole("button", { name: "Close project browser" }).click();
  await until(
    () =>
      electron.evaluate(
        ({ webContents }) =>
          webContents
            .getAllWebContents()
            .filter((w) => w.getURL().startsWith("http")).length,
      ),
    (n) => n === 1,
    "preview closes",
  );
  check("Closing panel releases preview WebContents");
  check(
    "Manager draft survives browser use",
    (await host
      .getByRole("textbox", { name: "Message your manager", exact: true })
      .inputValue()) === "Retained manager draft",
  );
  await host
    .getByRole("textbox", { name: "Message your manager", exact: true })
    .click();
  check(
    "Focus returns to manager composer",
    await host
      .getByRole("textbox", { name: "Message your manager", exact: true })
      .evaluate((el) => el === document.activeElement),
  );
  await assert.rejects(async () => {
    const sock = new WebSocket(endpoint);
    sock.on("error", () => {});
    await once(sock, "open");
  }, "closed endpoint");
  await host.getByRole("button", { name: "Browser", exact: true }).click();
  const fresh = await until(
    () => electron.evaluate(() => global.project.browserEndpoint()),
    Boolean,
    "reopen endpoint",
  );
  check("Reopen creates a fresh control capability", fresh !== endpoint);
  await host.getByRole("button", { name: "Close project browser" }).click();
  const proof = await fetch(origin + "/__proof").then((r) => r.json());
  evidence.backendProof = proof;
  check(
    "No voice/capture/worker calls in synthetic backend",
    !proof.calls.some((c) =>
      ["connect", "worker-action", "dispatch", "text"].includes(c.name),
    ) &&
      proof.media.calls === 0 &&
      proof.media.tracks.length === 0,
  );
  check("Single manager SSE retained", proof.sseConnections === 1);
  evidence.viewport = rect;
  evidence.hits = hits;
  evidence.passed = true;
  if (process.env.CREW_BROWSER_INSPECT === "1") {
    await electron.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1050, 850),
    );
    await host.getByRole("button", { name: "Browser", exact: true }).click();
    const inspectionEndpoint = await until(
      () => electron.evaluate(() => global.project.browserEndpoint()),
      Boolean,
      "inspection endpoint",
    );
    console.log(
      "Inspection: real Crew panel, synthetic backend; no agent runtime. Endpoint:",
      inspectionEndpoint,
    );
    console.log("Press Ctrl+C to close this disposable experiment.");
    await writeFile(
      path.join(dir, "evidence.json"),
      JSON.stringify(evidence, null, 2),
    );
    await new Promise((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
      electron.once("close", resolve);
    });
  }
} catch (error) {
  evidence.failure = error.stack;
  process.exitCode = 1;
  console.error(error);
} finally {
  await cleanup();
  await writeFile(
    path.join(dir, "evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log("Evidence:", dir);
}
