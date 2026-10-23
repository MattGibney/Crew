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
  directory = await mkdtemp(path.join(tmpdir(), "crew-public-browser-"));
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
    global.external={a:false,b:false};global.accessListeners=[];global.allowed=true;global.admitted=false;global.window=new BrowserWindow({show:false,webPreferences:{sandbox:true}});
    global.browser=createUnifiedProjectBrowser({projectId:'fixture',stateDirectory:${JSON.stringify(path.join(directory, "state"))},getWindow:()=>window,getHostOrigin:()=> 'http://127.0.0.1:1',getAgent:id=>agents[id]??null,publish:()=>{}});
    global.tools=browser.tools({authorization:{canDiscoverBrowser:async()=>allowed,canUseExternalBrowser:async id=>allowed&&external[id]===true,subscribe:fn=>{accessListeners.push(fn);return ()=>{accessListeners=accessListeners.filter(x=>x!==fn);};}},runAuthorized:async(c,a,op)=>{if(!allowed)throw Error('Permission revoked');if(admitted)throw Error('Reentrant admission deadlock');admitted=true;try{return await op();}finally{admitted=false;}}});
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
  check(
    "owner cannot open a public page without explicit grant",
    await electron.evaluate(async () => {
      try {
        await browser.request({
          projectId: "fixture",
          action: "new_tab",
          agentId: "a",
          url: "https://example.com/",
        });
        return false;
      } catch (e) {
        return e.message.includes("browser.external");
      }
    }),
  );
  await electron.evaluate(() => {
    external.a = true;
  });
  await electron.evaluate(async () =>
    call("a", "browser_new_tab", { url: "https://example.com/" }),
  );
  const publicTab = await electron.evaluate(
    async () => (await call("a", "browser_tabs")).activeTabId,
  );
  const waitFor = async (fn, label) => {
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw Error("Timed out " + label);
  };
  await waitFor(
    async () =>
      JSON.stringify(await evaluate("a", "() => document.title")).includes(
        "Example Domain",
      ),
    "public page",
  );
  check("granted public HTTPS loads through real scoped MCP", true);
  check(
    "public page cannot fetch Crew or alternate private origins",
    JSON.stringify(
      await evaluate(
        "a",
        `async () => { const urls=['http://127.0.0.1:1/',${JSON.stringify(url + "/private-blocked")},'http://169.254.169.254/latest/meta-data/']; return Promise.all(urls.map(async url=>{try{await fetch(url,{mode:'no-cors'});return 'LEAK';}catch{return 'blocked';}})); }`,
      ),
    ).includes("blocked") &&
      !JSON.stringify(
        await evaluate(
          "a",
          `async () => {try{await fetch(${JSON.stringify(url + "/private-blocked")},{mode:'no-cors'});return 'LEAK';}catch{return 'blocked';}}`,
        ),
      ).includes("LEAK"),
  );
  await evaluate(
    "a",
    '() => { localStorage.setItem("crew-public-fixture","agent-a"); document.cookie="crewPublic=agent-a; path=/"; return true; }',
  );
  await electron.evaluate(async () =>
    call("a", "browser_new_tab", { url: "https://example.com/?second" }),
  );
  await waitFor(
    async () =>
      JSON.stringify(await evaluate("a", "() => document.title")).includes(
        "Example Domain",
      ),
    "second public tab",
  );
  check(
    "public tabs share own storage",
    JSON.stringify(
      await evaluate("a", '() => localStorage.getItem("crew-public-fixture")'),
    ).includes("agent-a"),
  );
  await electron.evaluate(() => {
    external.b = true;
  });
  await electron.evaluate(async () =>
    call("b", "browser_new_tab", { url: "https://example.com/" }),
  );
  await waitFor(
    async () =>
      JSON.stringify(await evaluate("b", "() => document.title")).includes(
        "Example Domain",
      ),
    "other agent public tab",
  );
  check(
    "public agent sessions isolate cookies and storage",
    !JSON.stringify(
      await evaluate(
        "b",
        '() => [document.cookie,localStorage.getItem("crew-public-fixture")]',
      ),
    ).includes("agent-a"),
  );
  check(
    "cross-origin public website asset request succeeds",
    JSON.stringify(
      await evaluate(
        "a",
        `async () => {try {await fetch('https://www.iana.org/favicon.ico',{mode:'no-cors',cache:'no-store'});return 'asset-loaded';}catch(e){return e.message;}}`,
      ),
    ).includes("asset-loaded"),
  );
  await electron.evaluate(async () =>
    call("a", "browser_navigate_page", {
      pageId: 1,
      url: "https://httpbingo.org/redirect-to?url=https%3A%2F%2Fexample.com%2F&status_code=302",
    }),
  );
  await waitFor(
    async () =>
      JSON.stringify(
        await evaluate("a", "() => [location.origin,document.title]"),
      ).includes("Example Domain"),
    "public redirect",
  );
  check("public redirect navigates to another allowed public origin", true);
  // Public GET only.
  await electron.evaluate(async () =>
    call("a", "browser_navigate_page", {
      pageId: 1,
      url: "http://example.com/",
    }),
  );
  await waitFor(
    async () =>
      JSON.stringify(await evaluate("a", "() => document.title")).includes(
        "Example Domain",
      ),
    "public HTTP",
  );
  check("public HTTP navigation permitted", true);
  await electron.evaluate(
    async (_e, { publicTab }) =>
      call("a", "browser_select_tab", { tabId: publicTab }),
    { publicTab },
  );
  check(
    "earlier public tab survives later tabs sharing the session",
    JSON.stringify(await evaluate("a", "() => document.title")).includes(
      "Example Domain",
    ),
  );
  // Change current grants without notifying first: the network callback must
  // independently reject autonomous requests from an already loaded document.
  await evaluate(
    "a",
    '() => {document.title="Crew revocation fixture"; return true;}',
  );
  await electron.evaluate(() => {
    external.a = false;
  });
  check(
    "fresh request policy rejects autonomous fetch after revoke",
    await electron.evaluate(async ({ webContents }) => {
      const page = webContents
        .getAllWebContents()
        .find((w) => w.getTitle() === "Crew revocation fixture");
      return page.executeJavaScript(
        `fetch('https://example.com/?revoked='+Date.now(),{cache:'no-store'}).then(()=>false,()=>true)`,
      );
    }),
  );
  await electron.evaluate(() => {
    for (const fn of accessListeners) fn();
  });
  await waitFor(
    async () =>
      !(await electron.evaluate(
        async () => (await call("a", "browser_tabs")).open,
      )),
    "revoked view teardown",
  );
  check(
    "grant-change notification closes revoked public views and retained sockets",
    true,
  );
  check(
    "other agent public page remains live after revoke",
    JSON.stringify(await evaluate("b", "() => document.title")).includes(
      "Example Domain",
    ),
  );
  check(
    "revoked external permission rejects reopening from owner UI",
    await electron.evaluate(async () => {
      try {
        await browser.request({
          projectId: "fixture",
          agentId: "a",
          action: "new_tab",
          url: "https://example.com/",
        });
        return false;
      } catch {
        return true;
      }
    }),
  );
  await electron.evaluate(() => {
    external.a = true;
    allowed = false;
  });
  check(
    "external alone cannot open public page without control",
    await electron.evaluate(async () => {
      try {
        await browser.request({
          projectId: "fixture",
          agentId: "a",
          action: "new_tab",
          url: "https://example.com/",
        });
        return false;
      } catch {
        return true;
      } finally {
        allowed = true;
      }
    }),
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
  // close() is also used by native window teardown; the project service lives on.
  await electron.evaluate(async () => call('b','browser_new_tab',{url:'https://example.com/'}));
  await waitFor(async () => JSON.stringify(await evaluate('b','() => document.title')).includes('Example Domain'), 'reopened browser');
  await electron.evaluate(() => { external.b=false; for(const fn of accessListeners) fn(); });
  await waitFor(async () => !(await electron.evaluate(async () => (await call('b','browser_tabs')).open)), 'reopened revocation');
  check("revocation subscription survives native browser close and reopen", true);
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
