// GH-56 boundary tests: malicious CDP messages must never reach another target.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { WebSocket } from "ws";
import { createBrowserCdp } from "../runtime/desktop/browser-cdp.mjs";

async function fixture(t) {
  const debuggerApi = new EventEmitter();
  let attached = false;
  const calls = [],
    status = [];
  const observations = new EventEmitter();
  Object.assign(debuggerApi, {
    attach() {
      assert.equal(attached, false);
      attached = true;
    },
    detach() {
      attached = false;
      debuggerApi.emit("detach");
    },
    isAttached: () => attached,
    sendCommand: async (method, params) => {
      calls.push({ method, params });
      return { ok: true };
    },
  });
  const contents = new EventEmitter();
  Object.assign(contents, {
    debugger: debuggerApi,
    getURL: () => "http://127.0.0.1:8080/",
    getTitle: () => "Preview",
    isDestroyed: () => false,
    focus: () => {},
  });
  const endpoint = await createBrowserCdp(contents, (value) => {
    status.push(value);
    observations.emit("changed", value);
  });
  t.after(() => endpoint.close());
  const connect = async (url = endpoint.endpoint, options) => {
    const ws = new WebSocket(url, options);
    ws.on("error", () => {});
    await once(ws, "open");
    return ws;
  };
  const ws = await connect();
  let next = 0;
  function rpc(method, params = {}, sessionId) {
    const id = ++next;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(Error(method + " timed out")),
        2000,
      );
      const on = (bytes) => {
        const value = JSON.parse(bytes.toString());
        if (value.id !== id) return;
        clearTimeout(timeout);
        ws.off("message", on);
        resolve(value);
      };
      ws.on("message", on);
      ws.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  }
  return {
    endpoint,
    ws,
    rpc,
    connect,
    calls,
    status,
    debuggerApi,
    observations,
  };
}
test("browser facade exposes one target and rejects browser management and foreign identity", async (t) => {
  const f = await fixture(t);
  const targets = (await f.rpc("Target.getTargets")).result.targetInfos;
  assert.equal(targets.length, 1);
  const id = targets[0].targetId;
  const sessionId = (
    await f.rpc("Target.attachToTarget", { targetId: id, flatten: true })
  ).result.sessionId;
  for (const method of [
    "Browser.close",
    "Browser.grantPermissions",
    "Target.getTargets",
    "Target.createTarget",
    "Target.createBrowserContext",
    "Target.sendMessageToTarget",
    "SystemInfo.getInfo",
    "IO.read",
    "Storage.getCookies",
  ]) {
    assert.ok((await f.rpc(method, {}, sessionId)).error, method);
  }
  assert.ok(
    (await f.rpc("Target.attachToTarget", { targetId: "foreign" })).error,
  );
  assert.ok(
    (await f.rpc("Target.getTargetInfo", { targetId: "foreign" }, sessionId))
      .error,
  );
  assert.ok(
    (await f.rpc("Runtime.evaluate", { expression: "1" }, "foreign")).error,
  );
  assert.deepEqual(f.calls, []);
  await f.rpc("Runtime.evaluate", { expression: "1" }, sessionId);
  assert.deepEqual(f.calls, [
    { method: "Runtime.evaluate", params: { expression: "1" } },
  ]);
});
test("random endpoint denies browser-origin and second-client connections, then reconnects", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.connect(f.endpoint.endpoint.replace(/[^/]+$/, "wrong")),
  );
  await assert.rejects(
    f.connect(f.endpoint.endpoint, { origin: "http://127.0.0.1:8080" }),
  );
  await assert.rejects(f.connect());
  f.ws.close();
  await once(f.ws, "close");
  const second = await f.connect();
  assert.deepEqual(f.status, [true, false, true]);
  second.close();
  await once(second, "close");
});
test("malformed CDP payload closes only its client and leaves endpoint reusable", async (t) => {
  const f = await fixture(t);
  f.ws.send("null");
  await once(f.ws, "close");
  assert.deepEqual(f.calls, []);
  const second = await f.connect();
  second.send(
    JSON.stringify({ id: 1, method: "Runtime.evaluate", params: null }),
  );
  await once(second, "close");
  assert.deepEqual(f.calls, []);
});
test("debugger loss terminates the MCP connection and reports disconnection", async (t) => {
  const f = await fixture(t);
  const observed = once(f.observations, "changed");
  f.debuggerApi.detach();
  await once(f.ws, "close");
  await observed;
  assert.deepEqual(f.status, [true, false]);
});
