// Disposable real Electron/CDP/MCP fixture: no subscription/model, installed app,
// credentials, owner state or physical microphone is used.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
const { _electron } = await import(
  process.env.CREW_PLAYWRIGHT_MODULE || "playwright-core"
);
const root = process.cwd(),
  directory = await mkdtemp(path.join(tmpdir(), "crew-agent-tabs-"));
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(`<!doctype html><title>${req.url}</title><h1>${req.url}</h1>`);
});
let electron;
const checks = [];
const check = (name, value) => {
  assert.ok(value, name);
  checks.push(name);
  console.log("PASS", name);
};
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const main = path.join(directory, "main.cjs");
  await writeFile(
    main,
    `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(directory, "native"))});app.whenReady().then(async()=>{
    const {createUnifiedProjectBrowser}=await import(${JSON.stringify(path.join(root, "runtime/browser/unified-browser.mjs"))});
    global.agents=Object.fromEntries(['a','b'].map(id=>[id,{id,archivedAt:null,runtime:{session:{sessionId:id+'-1',desiredState:'started',observedState:'started'}}}]));
    global.allowed=true;global.admitted=false;global.window=new BrowserWindow({show:false,webPreferences:{sandbox:true}});
    global.browser=createUnifiedProjectBrowser({projectId:'fixture',stateDirectory:${JSON.stringify(path.join(directory, "state"))},getWindow:()=>window,getHostOrigin:()=> 'http://127.0.0.1:1',getAgent:id=>agents[id]??null,publish:()=>{}});
    global.tools=browser.tools({authorization:{canDiscoverBrowser:async()=>allowed},runAuthorized:async(c,a,op)=>{if(!allowed)throw Error('Permission revoked');if(admitted)throw Error('Reentrant admission deadlock');admitted=true;try{return await op();}finally{admitted=false;}}});
    global.call=(agentId,name,args={})=>tools.call({projectId:'fixture',agentId,sessionId:agents[agentId].runtime.session.sessionId},name,args);
    await window.loadURL('about:blank');global.fixtureReady=true;
  });`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  electron = await _electron.launch({
    executablePath: path.join(
      root,
      "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    ),
    args: [main],
    env,
  });
  await electron.evaluate(async () => {
    while (!global.fixtureReady) await new Promise((r) => setTimeout(r, 20));
  });
  const names = await electron.evaluate(async () =>
    (
      await tools.list({ projectId: "fixture", agentId: "a", sessionId: "a-1" })
    ).map((t) => t.name),
  );
  check(
    "all 19 browser tools discover before any browser exists",
    names.length === 19 && names.includes("browser_new_tab"),
  );
  await electron.evaluate(
    async (_electron, { url }) => {
      await browser.request({
        projectId: "fixture",
        action: "open",
        agentId: "a",
        url: url + "/a1",
      });
    },
    { url },
  );
  const a1 = await electron.evaluate(() => browser.state().activeTabId);
  await electron.evaluate(
    async (_electron, { url }) =>
      call("a", "browser_new_tab", { url: url + "/a2" }),
    { url },
  );
  const a2 = await electron.evaluate(() => browser.state().activeTabId);
  await electron.evaluate(
    async (_electron, { url }) => {
      await browser.request({
        projectId: "fixture",
        action: "open",
        agentId: "b",
        url: url + "/b1",
      });
      await call("b", "browser_new_tab", { url: url + "/b2" });
    },
    { url },
  );
  const b2 = await electron.evaluate(() => browser.state().activeTabId);
  check(
    "two agents retain two distinct tabs",
    await electron.evaluate(
      async () =>
        (await call("a", "browser_tabs")).tabs.length === 2 &&
        (await call("b", "browser_tabs")).tabs.length === 2,
    ),
  );
  check(
    "agent tools do not change owner selected browser",
    await electron.evaluate(async () => {
      await call("a", "browser_tabs");
      return browser.state().ownerAgentId === "b";
    }),
  );
  check(
    "foreign tab selection rejected",
    await electron.evaluate(
      async (_electron, { a1 }) => {
        try {
          await call("b", "browser_select_tab", { tabId: a1 });
          return false;
        } catch {
          return true;
        }
      },
      { a1 },
    ),
  );
  async function evaluate(agentId, fn) {
    const pages = await electron.evaluate(
      async (_electron, { agentId }) => call(agentId, "browser_list_pages"),
      { agentId },
    );
    const text = JSON.stringify(pages);
    const pageId = Number(text.match(/(?:\\n|\n|\s)(\d+):/)?.[1] ?? 1);
    return electron.evaluate(
      async (_electron, { agentId, fn, pageId }) =>
        call(agentId, "browser_evaluate_script", {
          pageId,
          function: fn,
          waitForStableDom: false,
        }),
      { agentId, fn, pageId },
    );
  }
  const shot = await electron.evaluate(async () =>
    call("a", "browser_take_screenshot", { pageId: 1 }),
  );
  const shotImage = shot.crewMcpResult?.content?.find(
    (c) => c.type === "image",
  );
  const pixels = Buffer.from(shotImage?.data ?? "", "base64");
  check(
    "hidden agent tab retains a nonempty screenshot viewport",
    pixels.length > 100 &&
      pixels.readUInt32BE(16) > 0 &&
      pixels.readUInt32BE(20) > 0,
  );
  const resultA = await evaluate(
    "a",
    '() => {document.cookie="crewfixture=agent-a; path=/"; return location.pathname;}',
  );
  check(
    "background agent CDP resolves its active page",
    JSON.stringify(resultA).includes("/a2"),
  );
  await electron.evaluate(
    async (_electron, { a1 }) => call("a", "browser_select_tab", { tabId: a1 }),
    { a1 },
  );
  check(
    "same agent tabs share cookies",
    JSON.stringify(await evaluate("a", "() => document.cookie")).includes(
      "agent-a",
    ),
  );
  check(
    "different agent tabs isolate cookies",
    !JSON.stringify(await evaluate("b", "() => document.cookie")).includes(
      "agent-a",
    ),
  );
  check(
    "annotation cannot target another agent",
    await electron.evaluate(async () => {
      try {
        await browser.request({
          projectId: "fixture",
          action: "annotation",
          agentId: "a",
          annotationScope: "page",
          comment: "fixture",
          recipientAgentId: "b",
        });
        return false;
      } catch {
        return true;
      }
    }),
  );
  await electron.evaluate(async () =>
    browser.request({ projectId: "fixture", action: "new_tab", agentId: "a" }),
  );
  check(
    "blank logical tab keeps native-page state closed",
    await electron.evaluate(
      () => browser.state().open === false && browser.state().tabs.length === 3,
    ),
  );
  await electron.evaluate(
    async (_electron, { url }) =>
      call("a", "browser_navigate_page", {
        pageId: 1,
        url: url + "/blank-opened",
      }),
    { url },
  );
  check(
    "agent can navigate a logical blank tab",
    JSON.stringify(await evaluate("a", "() => location.pathname")).includes(
      "/blank-opened",
    ),
  );
  await electron.evaluate(async () =>
    call("a", "browser_close_tab", { tabId: browser.state().activeTabId }),
  );
  await electron.evaluate(() => {
    agents.a.runtime.session.sessionId = "a-2";
  });
  check(
    "restart preserves stable ownership and tabs",
    await electron.evaluate(
      async () => (await call("a", "browser_tabs")).tabs.length === 2,
    ),
  );
  check(
    "old native session rejected",
    await electron.evaluate(async () => {
      try {
        await tools.call(
          { projectId: "fixture", agentId: "a", sessionId: "a-1" },
          "browser_tabs",
          {},
        );
        return false;
      } catch {
        return true;
      }
    }),
  );
  check(
    "revoked permission blocks actual tool calls",
    await electron.evaluate(async () => {
      allowed = false;
      try {
        await call("a", "browser_tabs");
        return false;
      } catch {
        return true;
      } finally {
        allowed = true;
      }
    }),
  );
  await electron.evaluate(async () =>
    browser.request({ projectId: "fixture", action: "close", agentId: "b" }),
  );
  check(
    "owner close only closes selected agent browser",
    await electron.evaluate(
      async () =>
        (await call("b", "browser_tabs")).tabs.length === 0 &&
        (await call("a", "browser_tabs")).tabs.length === 2,
    ),
  );
  await electron.evaluate(async () => {
    await browser.close();
  });
  check(
    "global close releases all tabs",
    await electron.evaluate(
      async () => (await call("a", "browser_tabs")).tabs.length === 0,
    ),
  );
  console.log(JSON.stringify({ directory, checks }, null, 2));
} finally {
  await electron
    ?.evaluate(async () => {
      await global.browser?.close();
    })
    .catch(() => {});
  await electron?.close();
  await new Promise((resolve) => server.close(resolve));
}
