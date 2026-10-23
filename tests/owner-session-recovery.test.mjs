import test from "node:test";
import assert from "node:assert/strict";
import { createOwnerApi } from "../src/agents/owner-api.mts";
const acknowledged = { state: "acknowledged", value: null };
const failed = {
  state: "failed",
  error: { code: "disconnected", message: "Old native peer is unavailable." },
};
function fixture({ state = "unknown", exited = true, liveStop = false } = {}) {
  const agent = {
    id: "manager",
    runtime: {
      threadId: "same-native-chat",
      session: { sessionId: "old-session", observedState: state },
    },
  };
  const calls = [];
  let recovered = false;
  const foundation = {
    store: {
      snapshot: () => ({
        ownerUserId: "owner",
        agents: [structuredClone(agent)],
      }),
    },
    start: async (id) => {
      calls.push(["start", id]);
      return recovered
        ? {
            state: "acknowledged",
            value: { binding: { threadId: agent.runtime.threadId } },
          }
        : failed;
    },
    restart: async (id) => {
      calls.push(["restart", id]);
      return recovered
        ? {
            state: "acknowledged",
            value: { binding: { threadId: agent.runtime.threadId } },
          }
        : failed;
    },
    stop: async (id) => {
      calls.push(["stop", id]);
      return liveStop ? acknowledged : failed;
    },
    recoverSession: async (principal, id) => {
      calls.push(["recover", principal, id]);
      if (!exited)
        return {
          state: "failed",
          error: {
            code: "disconnected",
            message: "The recorded native PID still exists.",
          },
        };
      recovered = true;
      agent.runtime.session.observedState = "stopped";
      return acknowledged;
    },
  };
  const api = createOwnerApi({ foundation }, "owner");
  return { api, calls, agent };
}
for (const action of ["start", "restart"])
  test(`${action} recovers an exited retained session and keeps native chat identity`, async () => {
    const f = fixture();
    const r = await f.api.command("lifecycle", { agentId: "manager", action });
    assert.equal(r.state, "acknowledged");
    assert.equal(r.value.binding.threadId, "same-native-chat");
    assert.deepEqual(f.calls, [
      [action, "manager"],
      ["recover", { type: "owner", userId: "owner" }, "manager"],
      [action, "manager"],
    ]);
  });
test("Stop settles an exited session without retrying a missing native peer", async () => {
  const f = fixture({ state: "error" });
  assert.equal(
    (await f.api.command("lifecycle", { agentId: "manager", action: "stop" }))
      .state,
    "acknowledged",
  );
  assert.deepEqual(
    f.calls.map((c) => c[0]),
    ["stop", "recover"],
  );
});
test("a live peer gets ordinary Stop and never goes through exit recovery", async () => {
  const f = fixture({ state: "error", exited: false, liveStop: true });
  assert.equal(
    (await f.api.command("lifecycle", { agentId: "manager", action: "stop" }))
      .state,
    "acknowledged",
  );
  assert.deepEqual(f.calls, [["stop", "manager"]]);
});
test("live or unverified exit proof prevents a second Start and retains chat reference", async () => {
  const f = fixture({ exited: false });
  const r = await f.api.command("lifecycle", {
    agentId: "manager",
    action: "start",
  });
  assert.equal(r.state, "failed");
  assert.equal(r.retainedThreadId, "same-native-chat");
  assert.match(r.error.message, /PID still exists/);
  assert.deepEqual(
    f.calls.map((c) => c[0]),
    ["start", "recover"],
  );
  assert.equal(f.agent.runtime.session.observedState, "unknown");
});
test("normal stopped-session failures are not mistaken for interrupted ownership", async () => {
  const f = fixture({ state: "stopped" });
  assert.equal(
    (await f.api.command("lifecycle", { agentId: "manager", action: "start" }))
      .state,
    "failed",
  );
  assert.deepEqual(f.calls, [["start", "manager"]]);
});
