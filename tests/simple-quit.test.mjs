import test from "node:test";
import assert from "node:assert/strict";
import { createSimpleQuit } from "../src/desktop/simple-quit.mts";

function fixture(overrides = {}) {
  let turns = [];
  const calls = [];
  const flow = createSimpleQuit({
    activeTurns: () => turns,
    seal: () => calls.push("seal"),
    shutdown: async () => {
      calls.push("shutdown");
    },
    finish: async () => {
      calls.push("finish");
    },
    changed() {},
    timeoutMs: 10,
    ...overrides,
  });
  return {
    flow,
    calls,
    turns(value) {
      turns = value;
    },
  };
}
const active = [
  {
    projectId: "project",
    projectName: "Studio",
    agentId: "worker",
    agentName: "Website worker",
  },
];

test("no active turns proceeds without preparation even when sessions are open", async () => {
  const f = fixture();
  await f.flow.request();
  assert.deepEqual(f.calls, ["seal", "shutdown", "finish"]);
  assert.equal(f.flow.snapshot().state, "quitting");
});

test("active turns warn without sealing or shutting down; cancel preserves work", async () => {
  const f = fixture();
  f.turns(active);
  await f.flow.request();
  assert.deepEqual(f.flow.snapshot(), {
    state: "confirmation",
    activeTurns: active,
  });
  assert.deepEqual(f.calls, []);
  f.flow.cancel();
  assert.equal(f.flow.snapshot().state, "idle");
  assert.equal(f.flow.holding(), false);
});

test("continue interrupts without readiness and repeated clicks finish once", async () => {
  const f = fixture();
  f.turns(active);
  await f.flow.request();
  await Promise.all([f.flow.request(true), f.flow.request(true)]);
  assert.deepEqual(f.calls, ["seal", "shutdown", "finish"]);
});

test("new active turns are checked on each request; completed turns no longer warn", async () => {
  const f = fixture();
  f.turns(active);
  await f.flow.request();
  f.flow.cancel();
  f.turns([]);
  await f.flow.request();
  assert.deepEqual(f.calls, ["seal", "shutdown", "finish"]);
});

test("cleanup failure and a hanging transport cannot prevent owner quit", async () => {
  for (const shutdown of [
    async () => {
      throw Error("lost connection");
    },
    () => new Promise(() => {}),
  ]) {
    let finished = false;
    const f = fixture({
      shutdown,
      finish: async () => {
        finished = true;
      },
    });
    await f.flow.request();
    assert.equal(finished, true);
  }
});

test("installer failure is surfaced and explicit retry is possible", async () => {
  let attempts = 0;
  const f = fixture({
    finish: async () => {
      if (++attempts === 1) throw Error("installer failed");
    },
  });
  await assert.rejects(f.flow.request(), /installer failed/);
  assert.equal(f.flow.snapshot().state, "idle");
  await f.flow.request();
  assert.equal(attempts, 2);
});

// Exercise the real owned transport shutdown without a native model or microphone.
import { CodexAgentRuntime } from "../src/agents/codex-runtime.mts";
import { AgentFoundation } from "../src/agents/foundation.mts";
test("quit closes owned peers without resolving approvals or waiting for an idle turn", async () => {
  const runtime = Object.create(CodexAgentRuntime.prototype);
  const events = [];
  const session = {
    stopping: false,
    activeTurnId: "working",
    peer: {
      close: async () => {
        events.push("close");
      },
    },
    observers: new Set([
      {
        end() {
          events.push("end");
        },
      },
    ]),
  };
  runtime.sessions = new Map([["owned", session]]);
  await runtime.closeForQuit();
  assert.equal(session.stopping, true);
  assert.deepEqual(events, ["close", "end"]);
  const result = await runtime.start({
    thread: { mode: "resume", threadId: "saved-chat" },
  });
  assert.equal(result.state, "failed");
  assert.equal(result.retainedThreadId, "saved-chat");
});
test("sealing owner quit immediately blocks foundation execution without a preparation request", () => {
  const foundation = new AgentFoundation({
    store: {
      snapshot: () => ({
        projectId: "project",
        reservation: null,
        agents: [
          {
            id: "agent",
            runtime: {
              session: {
                sessionId: "session",
                observedState: "started",
                desiredState: "started",
              },
            },
          },
        ],
      }),
    },
  });
  const caller = {
    projectId: "project",
    agentId: "agent",
    sessionId: "session",
  };
  assert.equal(foundation.executionAllowed(caller), true);
  foundation.beginQuit();
  assert.equal(foundation.executionAllowed(caller), false);
});

import { EventEmitter } from "node:events";
import { createExplicitUpdateController } from "../src/desktop/unified-updates.mts";
function updateFixture() {
  const app = new EventEmitter();
  app.getVersion = () => "0.18.0";
  const updater = new EventEmitter(),
    calls = [];
  updater.checkForUpdates = async () =>
    updater.emit("update-available", { version: "0.19.0" });
  updater.downloadUpdate = async () =>
    updater.emit("update-downloaded", { version: "0.19.0" });
  updater.quitAndInstall = () => {
    calls.push("install");
    app.emit("before-quit");
  };
  let turns = [],
    scan = async () => [];
  const flow = createExplicitUpdateController(
    {
      updatesDirectory: "/unused-fixture",
      changed() {},
      activeTurns: () => turns,
      seal: () => calls.push("seal"),
      shutdown: async () => {
        calls.push("shutdown");
      },
      beforeInstall: async () => {
        calls.push("beforeInstall");
      },
    },
    {
      app,
      updater,
      support: { supported: true, error: null },
      lease: {
        acquire: async () => {
          calls.push("lease");
          return async () => {
            calls.push("release");
          };
        },
      },
      otherInstances: () => scan(),
    },
  );
  return {
    flow,
    updater,
    calls,
    turns(value) {
      turns = value;
    },
    scan(value) {
      scan = value;
    },
  };
}
test("explicit update installs with no active turns and no preparation or automatic install", async () => {
  const f = updateFixture();
  assert.equal(f.updater.autoInstallOnAppQuit, false);
  await f.flow.check();
  await f.flow.download();
  assert.deepEqual(f.calls, []);
  await f.flow.install();
  assert.deepEqual(f.calls, [
    "lease",
    "seal",
    "shutdown",
    "beforeInstall",
    "install",
  ]);
});
test("update active-turn warning can be canceled or explicitly continued without readiness", async () => {
  const f = updateFixture();
  f.turns(active);
  await f.flow.check();
  await f.flow.download();
  await f.flow.install();
  assert.equal(f.flow.snapshot().confirmation.state, "confirmation");
  assert.deepEqual(f.calls, []);
  await f.flow.cancel();
  assert.equal(f.flow.snapshot().confirmation.state, "idle");
  assert.deepEqual(f.calls, []);
  await f.flow.install();
  await f.flow.install(true);
  assert.deepEqual(f.calls, [
    "lease",
    "seal",
    "shutdown",
    "beforeInstall",
    "install",
  ]);
});
test("a turn starting during installer checks opens the warning before any shutdown", async () => {
  const f = updateFixture();
  await f.flow.check();
  await f.flow.download();
  f.scan(async () => {
    f.turns(active);
    return [];
  });
  await f.flow.install();
  assert.equal(f.flow.snapshot().confirmation.state, "confirmation");
  assert.deepEqual(f.calls, ["lease", "release"]);
});
