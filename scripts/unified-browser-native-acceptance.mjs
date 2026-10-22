// GH56 bounded real-native UI/CDP and authenticated-tool-host fixture.
// Agent/session and owner message receipt are synthetic; no model or sign-in starts.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const { _electron } = await import(
  process.env.CREW_PLAYWRIGHT_MODULE || "playwright-core"
);
const root = process.cwd(),
  dir = await mkdtemp(path.join(tmpdir(), "crew56-unified-"));
let electron, client;
const checks = [];
const check = (name, value = true) => {
  assert.ok(value, name);
  checks.push(name);
  console.log("PASS", name);
};
const until = async (read, test, label) => {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const v = await read();
    if (test(v)) return v;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw Error("Timed out " + label);
};
const server = http.createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(
    '<!doctype html><title>Unified shared preview</title><style>body{font:18px system-ui;padding:35px;background:#eef7f1}input,button{font:inherit;padding:12px}label{display:block;margin:15px 0}</style><h1 id="heading">Unified browser preview</h1><label>Preview note <input aria-label="Preview note"></label><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Apply note</button><output></output>',
  );
});
// Register owned cleanup before first wait; no installed state or physical media.
async function cleanup() {
  await client?.close();
  if (electron) {
    await electron.evaluate(async () => global.cleanup?.()).catch(() => {});
    await electron.close();
  }
  await new Promise((r) => server.close(r));
}
try {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const main = path.join(dir, "main.cjs");
  await writeFile(
    main,
    `const {app,ipcMain}=require('electron');app.setPath('userData',${JSON.stringify(path.join(dir, "native"))});app.whenReady().then(async()=>{
const root=${JSON.stringify(path.join(root, "runtime"))};
const {startDesktopRenderer}=await import(root+'/desktop/unified-renderer.mjs');const {createUnifiedWindow}=await import(root+'/desktop/unified-window.mjs');const {createUnifiedProjectBrowser}=await import(root+'/browser/unified-browser.mjs');const {startAgentMcpHost}=await import(root+'/agents/session-host.mjs');
const now=new Date().toISOString();global.agent={id:'fixture-agent',projectId:'fixture',createdAt:now,updatedAt:now,archivedAt:null,profile:{revision:1,name:'Browser fixture agent',pictureRef:null,personality:'',systemPrompt:'Synthetic fixture; no native model.'},skills:[],access:{permissionGroupIds:[],serviceConnectionIds:[],inheritPersonalServiceCredentials:false},runtime:{provider:'codex',modelAccessId:'fixture',configRef:'fixture',threadId:'fixture-thread',session:{sessionId:'fixture-session',desiredState:'started',observedState:'started',activeTurnId:null,startedAt:now,lastObservedAt:now,lastError:null,appliedConfiguration:null}},scratchpad:{markdown:'',revision:1,updatedAt:now},reportsTo:{type:'user',userId:'fixture-owner'},resources:[]};
const owner={projectId:'fixture',projectName:'GH56 disposable browser',ownerId:'fixture-owner',primaryAgentId:agent.id,agents:[agent],jobs:[],skills:[],pendingMessages:[],receipts:[],helpRequests:[],ownerInbox:[],nativeApprovals:[],readiness:[],creationPresets:[]};
global.messages=[];global.permission=true;global.caller={projectId:'fixture',agentId:agent.id,sessionId:'fixture-session'};
const renderer=await startDesktopRenderer(root+'/renderer-dist');global.surface=createUnifiedWindow({root,desktopDirectory:${JSON.stringify(path.join(dir, "desktop"))},origin:renderer.origin,isQuitting:()=>false,disconnectVoice:async()=>{},closed:()=>{}});
global.browser=createUnifiedProjectBrowser({projectId:'fixture',stateDirectory:${JSON.stringify(path.join(dir, "state"))},getWindow:()=>surface.native(),getHostOrigin:()=>renderer.origin,getAgent:id=>id===agent.id?agent:null,publish:e=>surface.notify(e)});
const extension=browser.tools({authorization:{checkCrew:async()=>({state:permission?'allowed':'denied'})},runAuthorized:async(c,a,op)=>{if(!permission||c.agentId!==agent.id||c.sessionId!==agent.runtime.session.sessionId)throw Error('Denied fixture access');return op();}});
const foundation={store:{snapshot:()=>({projectId:'fixture',agents:[agent]}),subscribe:()=>()=>{}},executionAllowed:c=>c.sessionId===agent.runtime.session.sessionId};
global.host=await startAgentMcpHost({privateDirectory:${JSON.stringify(path.join(dir, "transport"))},foundation,broker:{},additionalTools:extension});extension.subscribe(()=>void host.refreshTools());global.binding=await host.bind(caller);
ipcMain.handle('crew:unified',async(event,method,value)=>{if(!surface.accepts(event))return {ok:false,error:{message:'Rejected'}};try{let result;if(method==='snapshot')result={projects:[{id:'fixture',name:owner.projectName,directory:'Disposable fixture'}],selectedId:'fixture',quit:{state:'idle',recoveryRequired:false,detail:null,projects:[]},updates:null};else if(method==='ownerSnapshot')result=owner;else if(method==='browser')result=await browser.request(value);else if(method==='ownerCommand'){const {command,args}=value;if(command==='readHistory')result={state:'acknowledged',value:{items:[],nextCursor:null}};else if(command==='voice.list')result={voices:[],defaultVoice:'',selectedVoice:null};else if(command==='sendMessage'){messages.push({sender:{type:'user',userId:'fixture-owner'},...args.input});result={id:'fixture-message',state:'queued'};}else throw Error('Unsupported fixture command '+command);}else throw Error('Unsupported fixture action');return {ok:true,value:result};}catch(error){return {ok:false,error:{message:error.message}};}});
global.cleanup=async()=>{await browser.close();await host.close();await renderer.close();};await surface.open();});`,
  );
  const env = {
    ...process.env,
    CREW_APP_DATA: path.join(dir, "app"),
    CREW_GLOBAL_CAPACITY_DIR: path.join(dir, "capacity"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  electron = await _electron.launch({
    executablePath: path.join(
      root,
      "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    ),
    args: [main],
    env,
  });
  const page = await electron.firstWindow();
  page.setDefaultTimeout(15000);
  await page.getByRole("button", { name: "Browser", exact: true }).click();
  await page.getByRole("textbox", { name: "Page address" }).fill(url);
  await page.getByRole("button", { name: "Open browser", exact: true }).click();
  const preview = await until(
    async () =>
      electron
        .context()
        .pages()
        .find((p) => p.url().startsWith(url)),
    Boolean,
    "visible embedded target",
  );
  await preview
    .getByRole("heading", { name: "Unified browser preview" })
    .waitFor();
  check("Actual unified Crew renderer and native preview open");
  const binding = await electron.evaluate(() => global.binding);
  client = new Client(
    { name: "crew56-fixture-agent-tools", version: "1" },
    { capabilities: {} },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(binding.foundationUrl), {
      requestInit: {
        headers: { Authorization: "Bearer " + binding.bearerToken },
      },
    }),
  );
  const tools = await client.listTools();
  check(
    "Authenticated selected session discovers browser tools",
    tools.tools.some((t) => t.name === "browser_take_snapshot"),
  );
  const tool = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError, JSON.stringify(r));
    return r;
  };
  const text = (r) =>
    r.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  const pages = text(await tool("browser_list_pages"));
  check("Agent tools discover only shared page", pages.includes(url));
  const pageId = Number(pages.match(/(\d+):/)?.[1]);
  assert.ok(pageId);
  const snapshot = text(await tool("browser_take_snapshot", { pageId }));
  const input = snapshot.match(
      /uid=([\w.:-]+)[^\n]*textbox[^\n]*Preview note/,
    )?.[1],
    button = snapshot.match(/uid=([\w.:-]+)[^\n]*button[^\n]*Apply note/)?.[1];
  assert.ok(input && button, snapshot);
  await tool("browser_fill", {
    pageId,
    uid: input,
    value: "Tool-host controlled value",
  });
  await tool("browser_click", { pageId, uid: button });
  await preview
    .getByText("Tool-host controlled value", { exact: true })
    .waitFor();
  check("Authenticated browser fill/click changes exact visible page");
  const screenshot = await tool("browser_take_screenshot", { pageId });
  check(
    "Screenshot returns native MCP image content",
    screenshot.content.some((c) => c.type === "image"),
  );
  await page
    .getByRole("button", { name: "Select element", exact: true })
    .click();
  await preview
    .getByRole("heading", { name: "Unified browser preview" })
    .click({ force: true });
  await until(
    () => electron.evaluate(() => browser.state().selection),
    Boolean,
    "element capture",
  );
  await page
    .getByRole("textbox", { name: "Feedback for Browser fixture agent" })
    .fill("Please improve this heading.");
  await page
    .getByRole("button", { name: "Send annotation", exact: true })
    .click();
  const messages = await until(
    () => electron.evaluate(() => messages),
    (m) => m.length === 1,
    "annotation queued",
  );
  check(
    "Annotation uses owner sender and captured selected recipient",
    messages[0].sender.type === "user" &&
      messages[0].recipientAgentId === "fixture-agent",
  );
  const annotation = messages[0].content.find((c) => c.type === "data").value
    .browserAnnotation;
  check(
    "Annotation carries page element bounds and screenshot context",
    annotation.url.startsWith(url) &&
      annotation.selection.selector === "#heading" &&
      annotation.selection.rect.width > 0 &&
      annotation.screenshotRef,
  );
  const historical = await tool("browser_annotation_image", {
    screenshotRef: annotation.screenshotRef,
  });
  check(
    "Historical annotation screenshot delivered as MCP image",
    historical.content.some((c) => c.type === "image"),
  );
  const image = historical.content.find((c) => c.type === "image");
  await writeFile(
    path.join(dir, "annotation-page.png"),
    Buffer.from(image.data, "base64"),
  );
  await writeFile(
    path.join(dir, "annotation.json"),
    JSON.stringify(messages[0], null, 2),
  );
  let nativeWindowId;
  if (process.platform === "darwin") {
    const swift = path.join(dir, "window.swift");
    await writeFile(
      swift,
      `import CoreGraphics\nimport Foundation\nlet pid=Int32(CommandLine.arguments[1])!\nfor info in CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as! [[String:Any]] { if info[kCGWindowOwnerPID as String] as? Int32 == pid, info[kCGWindowLayer as String] as? Int == 0, let id=info[kCGWindowNumber as String] as? Int { print(id);break } }\n`,
    );
    const { stdout } = await exec("/usr/bin/swift", [
      swift,
      String(electron.process().pid),
    ]);
    assert.match(stdout.trim(), /^\d+$/);
    nativeWindowId = stdout.trim();
    await exec("/usr/sbin/screencapture", [
      "-x",
      "-o",
      "-l",
      stdout.trim(),
      path.join(dir, "unified-browser-native.png"),
    ]);
  }

  await electron.evaluate(() => surface.native().setSize(650, 700));
  await until(
    () => page.locator(".project-browser-viewport").boundingBox(),
    (r) => r && r.width > 500,
    "narrow viewport",
  );
  check(
    "Narrow annotation controls remain within the native window",
    await page
      .getByRole("button", { name: "Send annotation", exact: true })
      .evaluate((el) => el.getBoundingClientRect().bottom <= innerHeight),
  );
  if (nativeWindowId)
    await exec("/usr/sbin/screencapture", [
      "-x",
      "-o",
      "-l",
      nativeWindowId,
      path.join(dir, "unified-browser-narrow.png"),
    ]);

  await electron.evaluate(() => (global.permission = false));
  check(
    "Revoking permission removes discovery",
    (await client.listTools()).tools.every(
      (t) => !t.name.startsWith("browser_"),
    ),
  );
  const denied = await client.callTool({
    name: "browser_list_pages",
    arguments: {},
  });
  check("Revoked permission rejects retained tool invocation", denied.isError);
  await electron.evaluate(() => {
    global.permission = true;
    agent.runtime.session.sessionId = "new-session";
  });
  await assert.rejects(
    client.callTool({ name: "browser_list_pages", arguments: {} }),
  );
  check("Old logical session cannot continue browser control");
  await page.screenshot({ path: path.join(dir, "renderer-only.png") });
  await writeFile(
    path.join(dir, "checks.json"),
    JSON.stringify(
      { checks, syntheticSession: true, actualModel: false },
      null,
      2,
    ),
  );
  console.log("Evidence:", dir);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await cleanup();
}
