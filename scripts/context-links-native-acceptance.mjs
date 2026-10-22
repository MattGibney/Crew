// GH-66: exact compiled project window/preload + synthetic backend, real clipboard.
// Optional CREW_LINK_BASELINE=1 runs the unchanged 0.17.3 reproduction.
// No project controller, provider, live profile, shared ledger or microphone.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
const { _electron } = await import(
  process.env.CREW_PLAYWRIGHT_MODULE || "playwright-core"
);
const root = path.resolve(process.env.CREW_ACCEPTANCE_ROOT || process.cwd());
const baseline = process.env.CREW_LINK_BASELINE === "1";
const dir = await mkdtemp(path.join(tmpdir(), "crew66-native-"));
const port = Number(process.env.CREW_ACCEPTANCE_PORT || 59666);
const origin = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  AI_MANAGER_CONFIG: path.join(dir, "unused-config.json"),
  CREW_GLOBAL_CAPACITY_DIR: path.join(dir, "capacity"),
  CREW_APP_DATA: path.join(dir, "app-data"),
};
for (const name of ["AI_MANAGER_PORT", "VOICE_PORT", "ELECTRON_RUN_AS_NODE"])
  delete env[name];
const fixture = spawn(
  process.execPath,
  [path.join(root, "tests/browser-fixture.mjs"), String(port)],
  { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
);
let electron, page;
const hits = [];
const proofServer = http.createServer((req, res) => {
  hits.push({ url: req.url, agent: req.headers["user-agent"] });
  res.writeHead(200, {
    "Content-Type": "text/html",
    "Cache-Control": "no-store",
  });
  res.end(
    "<!doctype html><title>Crew issue 66 disposable link check</title><p>Crew external link verification. No microphone or application actions.</p>",
  );
});
// Cleanup is registered before the first observation wait.
async function cleanup() {
  const results = await Promise.allSettled([
    electron?.close(),
    (async () => {
      if (fixture.exitCode === null && fixture.signalCode === null) {
        fixture.kill("SIGTERM");
        await once(fixture, "exit");
      }
    })(),
    new Promise((resolve) => proofServer.close(resolve)),
  ]);
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      "Fixture cleanup failed",
    );
}
async function until(fn, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error(`Timed out: ${label}`);
}
try {
  await new Promise((resolve, reject) => {
    fixture.stdout.once("data", resolve);
    fixture.once("error", reject);
    fixture.once("exit", (code) => reject(Error(`fixture exited ${code}`)));
  });
  await new Promise((resolve) => proofServer.listen(0, "127.0.0.1", resolve));
  const external = `http://127.0.0.1:${proofServer.address().port}`;
  const main = path.join(dir, "main.cjs");
  await writeFile(
    main,
    `const {app,BrowserWindow,ipcMain,clipboard,Menu}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(dir, "profile"))});
const build=Menu.buildFromTemplate.bind(Menu);Menu.buildFromTemplate=(items)=>{const menu=build(items);global.editMenu=menu;return menu;};
app.whenReady().then(async()=>{
const {createProjectWindow}=await import(${JSON.stringify(path.join(root, "runtime/desktop/project-window.mjs"))});
global.project=createProjectWindow({root:${JSON.stringify(path.join(root, "runtime"))},desktopData:${JSON.stringify(dir)},key:'issue66',configPath:'fixture',isSelected:()=>true,ready:()=>true,projectName:()=> 'Crew issue 66 isolated acceptance',getOrigin:()=>${JSON.stringify(origin)},getError:()=>null,isQuitting:()=>false,disconnect:async()=>{},openSetup:async()=>{},statusChanged:async()=>{},safe:String});
ipcMain.handle('crew:clipboard-write',(event,text)=>{if(!global.project.accepts(event)||typeof text!=='string'||text.length>1000000)throw Error('Rejected');clipboard.writeText(text);});
global.project.configurePermissions();await global.project.open();
});`,
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
    timeout: 30000,
  });
  page = await electron.firstWindow();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.waitForURL(origin + "/**");
  await page.getByRole("tab", { name: "Text", exact: true }).waitFor();
  await until(
    async () =>
      (await (await page.request.get(origin + "/__proof")).json())
        .sseConnections > 0,
    "renderer SSE",
  );
  const defaultBrowser = await electron.evaluate(({ app }) =>
    app.getApplicationNameForProtocol("https:"),
  );
  const text = `Selected read-only words. [Example markdown](${external}/markdown) and ${external}/plain.\n\n[Unsafe](javascript:alert(1)) [Local](file:///tmp/private) [Data](data:text/html,hello) [Credentials](https://user:secret@example.com/)`;
  const messages = [
    { id: "issue66-manager", role: "assistant", text },
    {
      id: "issue66-user",
      role: "user",
      text: `[User link](${external}/user) and ${external}/user-plain`,
    },
  ];
  await page.request.post(origin + "/__control", {
    data: {
      work: {
        status: "idle",
        managerConnected: true,
        approvals: [],
        items: [],
        messages,
      },
    },
  });
  const manager = page.locator('article[data-message-id="issue66-manager"]');
  const user = page.locator('article[data-message-id="issue66-user"]');
  await manager.waitFor();
  await page.evaluate(() =>
    window.addEventListener(
      "contextmenu",
      (e) => {
        window.__context = {
          selection: getSelection().toString(),
          x: e.clientX,
          y: e.clientY,
          tag: e.target.tagName,
          text: e.target.textContent?.slice(0, 80),
        };
      },
      true,
    ),
  );
  await page.bringToFront();
  await electron.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].focus(),
  );
  await until(
    () => page.evaluate(() => document.hasFocus()),
    "native renderer focus",
  );
  if (baseline) {
    await manager
      .getByText("Selected read-only words.", { exact: false })
      .first()
      .click({ button: "right" });
    const observed = {
      baseline: "0.17.3 isolated source equivalent",
      defaultBrowser,
      readOnlyMenus: await page.getByRole("menu").count(),
      managerLinks: await manager.locator("a").count(),
      userLinks: await user.locator("a").count(),
    };
    assert.equal(observed.readOnlyMenus, 0);
    assert.equal(observed.userLinks, 0);
    await page.screenshot({ path: path.join(dir, "baseline.png") });
    console.log(JSON.stringify({ dir, ...observed }, null, 2));
  } else {
    assert.equal(await manager.locator("a").count(), 2);
    assert.equal(await user.locator("a").count(), 2);
    assert.equal(
      await manager
        .locator(
          'a[href^="javascript:"],a[href^="file:"],a[href^="data:"],a[href*="secret"]',
        )
        .count(),
      0,
    );
    const clipboard = () =>
      electron.evaluate(({ clipboard }) => clipboard.readText());
    // Select actual DOM text, then right-click through Chromium's real input path.
    const paragraph = manager
      .locator("p")
      .filter({ hasText: "Selected read-only words." })
      .first();
    await page.screenshot({ path: path.join(dir, "initial-render.png") });
    await page.getByRole("tab", { name: "Text", exact: true }).click();
    await page.waitForTimeout(500);
    await paragraph.evaluate((el) => {
      const r = document.createRange();
      r.setStart(el.firstChild, 0);
      r.setEnd(el.firstChild, "Selected read-only words.".length);
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
    });
    const selectedPoint = await page.evaluate(() => {
      const box = getSelection().getRangeAt(0).getBoundingClientRect();
      return { x: box.x + 5, y: box.y + box.height / 2 };
    });
    await page.mouse.click(selectedPoint.x, selectedPoint.y, {
      button: "right",
    });
    await page.getByRole("menuitem", { name: "Copy", exact: true }).click();
    await until(
      async () => (await clipboard()) === "Selected read-only words.",
      "real selected text clipboard",
    );
    assert.equal(
      await page.getByRole("menuitem", { name: "Cut", exact: true }).count(),
      0,
    );
    await page.evaluate(() => getSelection().removeAllRanges());
    const link = manager.getByRole("link", {
      name: "Example markdown",
      exact: true,
    });
    await link.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Copy link", exact: true })
      .click();
    await until(
      async () => (await clipboard()) === `${external}/markdown`,
      "real link clipboard",
    );
    await link.evaluate((el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
    });
    await link.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Copy", exact: true }).waitFor();
    await page
      .getByRole("menuitem", { name: "Copy link", exact: true })
      .waitFor();
    await page.screenshot({ path: path.join(dir, "selected-link-menu.png") });
    await page.keyboard.press("Escape");
    assert.equal(
      await page.evaluate(() => getSelection().toString()),
      "Example markdown",
    );
    await page.evaluate(() => getSelection().removeAllRanges());
    // Native menu availability and real shortcuts retain editing, React state and undo.
    await page.getByRole("tab", { name: "Text", exact: true }).click();
    const editor = page.locator("#manager-composer textarea");
    await editor.fill("Draft survives context menus");
    await editor.selectText();
    await page.keyboard.press("Meta+c");
    await until(
      async () => (await clipboard()) === "Draft survives context menus",
      "keyboard copy",
    );
    await editor.click({ button: "right", position: { x: 20, y: 15 } });
    await until(
      () =>
        electron.evaluate(() =>
          Boolean(global.editMenu?.items.some((item) => item.role === "cut")),
        ),
      "native editing menu",
    );
    const menuRoles = await electron.evaluate(() =>
      global.editMenu.items.map((item) => ({
        role: item.role,
        enabled: item.enabled,
      })),
    );
    for (const role of ["undo", "redo", "cut", "copy", "paste", "selectall"])
      assert.ok(
        menuRoles.some((item) => item.role === role),
        JSON.stringify(menuRoles),
      );
    assert.equal(menuRoles.find((item) => item.role === "cut").enabled, true);
    await electron.evaluate(() => global.editMenu.closePopup());
    await editor.focus();
    await page.keyboard.press("Meta+x");
    await until(
      async () => (await editor.inputValue()) === "",
      "keyboard cut with native menu dismissed",
    );
    assert.equal(await clipboard(), "Draft survives context menus");
    await page.keyboard.press("Meta+v");
    await until(
      async () =>
        (await editor.inputValue()) === "Draft survives context menus",
      "keyboard paste updates draft",
    );
    await page.keyboard.press("Meta+z");
    await until(async () => (await editor.inputValue()) === "", "native undo");
    await page.keyboard.press("Meta+Shift+z");
    await until(
      async () =>
        (await editor.inputValue()) === "Draft survives context menus",
      "native redo",
    );
    // Focus returns to a keyboard-opened link; menu keyboard navigation works.
    await link.focus();
    await page.keyboard.press("Shift+F10");
    await page.getByRole("menu").waitFor();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    await until(
      () => link.evaluate((el) => document.activeElement === el),
      "focus restored after keyboard menu closes",
    );
    assert.equal(await editor.inputValue(), "Draft survives context menus");
    // Real Safari opens, witnessed by an HTTP request bearing Safari's actual UA.
    // Two different paths distinguish activation from the link context action.
    await link.click();
    await until(
      () =>
        hits.some(
          (hit) =>
            hit.url === "/markdown" &&
            /Version\/.*Safari\//.test(hit.agent || ""),
        ),
      "Safari click request",
    );
    const plain = manager.getByRole("link", {
      name: `${external}/plain`,
      exact: true,
    });
    await plain.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Open in Safari", exact: true })
      .click();
    await until(
      () =>
        hits.some(
          (hit) =>
            hit.url === "/plain" && /Version\/.*Safari\//.test(hit.agent || ""),
        ),
      "Safari context-menu request",
    );
    assert.equal(page.url(), origin + "/");
    assert.equal(
      await electron.evaluate(({ app }) =>
        app.getApplicationNameForProtocol("https:"),
      ),
      defaultBrowser,
    );
    // Narrow project window and link menus remain within the viewport.
    await page.setViewportSize({ width: 540, height: 740 });
    await link.click({ button: "right" });
    const box = await page.getByRole("menu").boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 540);
    await page.screenshot({ path: path.join(dir, "narrow-menu.png") });
    await page.keyboard.press("Escape");
    assert.equal(await editor.inputValue(), "Draft survives context menus");
    await page.setViewportSize({ width: 390, height: 844 });
    await link.click({ button: "right" });
    const mobileBox = await page.getByRole("menu").boundingBox();
    assert.ok(mobileBox.x >= 0 && mobileBox.x + mobileBox.width <= 390);
    await page.screenshot({ path: path.join(dir, "mobile-menu.png") });
    await page.keyboard.press("Escape");
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    // Delay only this fixture's send response and preserve a newly typed draft
    // while another link menu is used and the previous submission settles.
    let releaseSend;
    await page.route("**/api/work", async (route) => {
      const response = await route.fetch();
      await new Promise((resolve) => {
        releaseSend = resolve;
      });
      await route.fulfill({ response });
    });
    await editor.fill("Submitted fixture message");
    await editor.press("Enter");
    await until(
      () => typeof releaseSend === "function",
      "pending-send response interception",
    );
    await editor.fill("New draft typed while sending");
    await link.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Copy link", exact: true })
      .click();
    const sendResponse = page.waitForResponse((response) =>
      response.url().endsWith("/api/work"),
    );
    releaseSend();
    await sendResponse;
    await page.unroute("**/api/work");
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await until(
      async () =>
        (await editor.inputValue()) === "New draft typed while sending",
      "new draft retained after send",
    );
    // Worker manager instructions and worker replies reuse the same link path.
    await page.request.post(origin + "/__control", {
      data: {
        workerDetail: {
          taskId: "fixture-task-1",
          conversation: [
            {
              id: "i66-dispatch",
              actor: "manager",
              kind: "instruction",
              message: `[Manager instruction](${external}/instruction)`,
              runId: "fixture-run-1",
            },
            {
              id: "i66-reply",
              actor: "worker",
              kind: "reply",
              message: `${external}/worker-reply`,
              runId: "fixture-run-1",
            },
          ],
        },
      },
    });
    await page.setViewportSize({ width: 1400, height: 950 });
    await page.locator('[data-worker-id="fixture-task-1"]').click();
    await page
      .getByRole("link", { name: "Manager instruction", exact: true })
      .waitFor();
    await page
      .getByRole("link", { name: `${external}/worker-reply`, exact: true })
      .waitFor();
    await page
      .getByRole("link", { name: "Manager instruction", exact: true })
      .click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Copy link", exact: true })
      .click();
    await until(
      async () => (await clipboard()) === `${external}/instruction`,
      "worker instruction link clipboard",
    );
    await page.screenshot({ path: path.join(dir, "worker-links.png") });
    assert.equal(await page.evaluate(() => window.__crewMedia.calls), 0);
    // Explicit self-target navigation is prevented and redirected to Safari.
    await page.evaluate((url) => {
      const a = document.createElement("a");
      a.href = url;
      a.textContent = "navigation check";
      document.body.append(a);
      a.click();
      a.remove();
    }, external + "/navigation");
    await until(
      () =>
        hits.some(
          (hit) =>
            hit.url === "/navigation" &&
            /Version\/.*Safari\//.test(hit.agent || ""),
        ),
      "foreign navigation Safari request",
    );
    assert.equal(page.url(), origin + "/");
    for (const url of [
      "file:///tmp/crew66-not-readable",
      "data:text/html,not-allowed",
      "javascript:window.__unsafeExecuted=true",
    ])
      await page.evaluate((url) => {
        window.open(url, "_blank");
      }, url);
    assert.equal(
      await electron.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      ),
      1,
    );
    assert.equal(await page.evaluate(() => window.__unsafeExecuted), undefined);
    // Admin/test navigation to a foreign document must not grant Crew's bridge
    // or permit that document to open another OS browser window.
    await page.goto(external + "/foreign-document");
    await page.evaluate(
      (url) => window.open(url, "_blank"),
      external + "/denied-foreign-popup",
    );
    await page.waitForTimeout(250);
    assert.equal(
      hits.some((hit) => hit.url === "/denied-foreign-popup"),
      false,
    );
    assert.equal(
      await electron.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      ),
      1,
    );
    assert.equal(
      await page.evaluate(async () => {
        try {
          await window.crewWindow.copyText("forbidden");
          return false;
        } catch {
          return true;
        }
      }),
      true,
    );
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify(
        {
          dir,
          defaultBrowser,
          nativeSafariRequests: hits.filter((hit) =>
            /Version\/.*Safari\//.test(hit.agent || ""),
          ),
          checks: [
            "selected text actual clipboard",
            "link actual clipboard",
            "selection in links",
            "read-only no Cut",
            "native editable menu roles and keyboard cut",
            "keyboard copy/paste/undo/redo",
            "keyboard context menu/focus",
            "draft retention",
            "manager/user/worker Markdown and plain links",
            "unsafe schemes/credential URLs inert",
            "540px and 390px menu bounds / no horizontal overflow",
            "submitted and newly typed drafts",
            "foreign navigation redirected, unsafe popups and foreign-origin IPC denied",
            "Safari click and context open",
            "unchanged default browser",
            "no renderer takeover",
            "zero media calls",
          ],
        },
        null,
        2,
      ),
    );
  }
} catch (error) {
  console.error(
    "failure diagnostics",
    dir,
    await page?.evaluate(() => ({
      context: window.__context,
      selection: getSelection().toString(),
      menus: [...document.querySelectorAll('[role="menu"]')].map(
        (x) => x.textContent,
      ),
      active: document.activeElement?.outerHTML.slice(0, 200),
    })),
  );
  await page?.screenshot({ path: path.join(dir, "failure.png") });
  throw error;
} finally {
  await cleanup();
}
