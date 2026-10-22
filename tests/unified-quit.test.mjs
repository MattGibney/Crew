import test from "node:test";
import assert from "node:assert/strict";
import { createUnifiedQuit } from "../src/desktop/unified-quit.mts";
import { AgentFoundation } from "../src/agents/foundation.mts";

function fixture() {
  const calls = [],
    held = new Set();
  let notifications = 0,
    serial = 0;
  const projects = ["selected", "background"].map((id) => {
    const project = {
      id,
      name: id,
      preparation: null,
      readiness: "ready",
      refuse: false,
      failClose: false,
    };
    project.lifecycle = {
      async prepare(projectId, reason) {
        assert.equal(projectId, id);
        assert.equal(reason, "quit");
        calls.push(["prepare", id]);
        project.preparation = {
          reason,
          requestedAt: `request-${++serial}`,
          readiness: [
            {
              preparationId: `preparation-${serial}`,
              agentId: `agent-${id}`,
              sessionId: `session-${id}`,
              state: project.readiness,
              continuationSavedAt:
                project.readiness === "ready"
                  ? "2026-10-22T12:00:00.000Z"
                  : null,
              detail: null,
            },
          ],
        };
        return structuredClone(project.preparation.readiness);
      },
      async reserveExecution(projectId, reason) {
        assert.equal(projectId, id);
        assert.equal(reason, "quit");
        calls.push(["reserve", id]);
        if (project.refuse)
          return { state: "blocked", reason: "New work needs attention." };
        held.add(id);
        return {
          state: "reserved",
          reservation: {
            id: `reservation-${id}`,
            projectId: id,
            reason,
            acquiredAt: "2026-10-22T12:00:01.000Z",
          },
        };
      },
      async releaseExecution(reservationId) {
        assert.equal(reservationId, `reservation-${id}`);
        calls.push(["release", id]);
        held.delete(id);
      },
    };
    project.observePreparation = () => structuredClone(project.preparation);
    project.close = async (reservation) => {
      assert.equal(reservation.id, `reservation-${id}`);
      assert.deepEqual(
        [...held].sort(),
        ["background", "selected"],
        "every project is reserved before the first close",
      );
      calls.push(["close", id]);
      if (project.failClose) throw new Error("Shutdown unconfirmed");
    };
    return project;
  });
  const coordinator = createUnifiedQuit({
    projects: () => projects,
    changed: () => notifications++,
    finish: async () => {
      calls.push(["finish"]);
    },
  });
  return {
    coordinator,
    projects,
    calls,
    held,
    get notifications() {
      return notifications;
    },
  };
}

test("unified Quit reserves every current project before closing either composition", async () => {
  const f = fixture();
  await f.coordinator.prepare();
  await f.coordinator.quit();
  assert.deepEqual(f.calls, [
    ["prepare", "selected"],
    ["prepare", "background"],
    ["reserve", "selected"],
    ["reserve", "background"],
    ["close", "selected"],
    ["close", "background"],
    ["finish"],
  ]);
  assert.equal(f.coordinator.snapshot().recoveryRequired, false);
});

test("a final reservation refusal rolls back earlier reservations without closing projects", async () => {
  const f = fixture();
  await f.coordinator.prepare();
  f.projects[1].refuse = true;
  await f.coordinator.quit();
  assert.deepEqual(f.calls.slice(2), [
    ["reserve", "selected"],
    ["reserve", "background"],
    ["release", "selected"],
  ]);
  assert.equal(f.coordinator.snapshot().state, "blocked");
  assert.equal(f.coordinator.snapshot().recoveryRequired, false);
  assert.equal(f.coordinator.holding(), false);
  assert.equal(f.held.size, 0);
  await f.coordinator.cancel();
  assert.equal(f.coordinator.snapshot().state, "idle");
});

test("late readiness is observed for the same preparation without issuing duplicate requests", async () => {
  const f = fixture();
  f.projects[1].readiness = "pending";
  await f.coordinator.prepare();
  assert.equal(f.coordinator.snapshot().state, "blocked");
  Object.assign(f.projects[1].preparation.readiness[0], {
    state: "ready",
    continuationSavedAt: "2026-10-22T12:00:02.000Z",
  });
  const notifications = f.notifications;
  f.coordinator.observe();
  assert.equal(f.coordinator.snapshot().state, "ready");
  assert.equal(f.notifications, notifications);
  assert.equal(f.calls.filter(([action]) => action === "prepare").length, 2);
  f.projects[1].preparation.readiness[0].preparationId = "a-different-request";
  f.coordinator.observe();
  assert.equal(f.coordinator.snapshot().state, "blocked");
  await assert.rejects(f.coordinator.quit(), /Prepare all projects/);
  assert.equal(
    f.calls.some(([action]) => action === "close"),
    false,
  );
});

test("partial close failure retains reservations and retries only unresolved closures", async () => {
  const f = fixture();
  await f.coordinator.prepare();
  f.projects[1].failClose = true;
  await f.coordinator.quit();
  const failed = f.coordinator.snapshot();
  assert.equal(failed.state, "recovery");
  assert.equal(failed.recoveryRequired, true);
  assert.deepEqual(
    failed.projects.map((project) => project.closeState),
    ["closed", "unconfirmed"],
  );
  assert.match(failed.detail, /has not restarted/);
  assert.equal(f.coordinator.holding(), true);
  assert.deepEqual([...f.held].sort(), ["background", "selected"]);
  const calls = structuredClone(f.calls);
  for (const action of ["cancel", "prepare"])
    await assert.rejects(f.coordinator[action](), /recovery is required/i);
  f.coordinator.observe();
  assert.deepEqual(f.coordinator.snapshot(), failed);
  assert.deepEqual(f.calls, calls);
  assert.equal(
    f.calls.some(([action]) => action === "release" || action === "finish"),
    false,
  );
  // A still-failing retry does not reacquire or release any reservation.
  await f.coordinator.quit();
  assert.deepEqual(f.calls.slice(calls.length), [["close", "background"]]);
  assert.equal(f.coordinator.snapshot().recoveryRequired, true);
  f.projects[1].failClose = false;
  await f.coordinator.quit();
  assert.deepEqual(f.calls.slice(calls.length), [
    ["close", "background"],
    ["close", "background"],
    ["finish"],
  ]);
  assert.deepEqual(
    f.coordinator.snapshot().projects.map((row) => row.closeState),
    ["closed", "closed"],
  );
  assert.equal(f.coordinator.holding(), true, "retry never re-enables work");
});

test("Quit recovery refuses a changed project set without closing or releasing anything", async () => {
  const f = fixture();
  await f.coordinator.prepare();
  f.projects[1].failClose = true;
  await f.coordinator.quit();
  const calls = structuredClone(f.calls);
  f.projects.pop();
  await f.coordinator.quit();
  assert.deepEqual(f.calls, calls);
  assert.equal(f.coordinator.holding(), true);
});

test("failure after shutdown begins can retry finish without releasing the recovery hold", async () => {
  let attempts = 0;
  const coordinator = createUnifiedQuit({
    projects: () => [],
    changed() {},
    finish: async () => {
      if (++attempts === 1) throw new Error("App exit unconfirmed");
    },
  });
  await coordinator.prepare();
  await coordinator.quit();
  coordinator.observe();
  assert.equal(coordinator.snapshot().recoveryRequired, true);
  assert.equal(coordinator.holding(), true);
  await assert.rejects(coordinator.cancel(), /recovery is required/i);
  assert.equal(coordinator.snapshot().state, "recovery");
  await coordinator.quit();
  assert.equal(attempts, 2);
  assert.equal(coordinator.holding(), true);
});

test("completed shutdown clears only its exact reservation after admission closes, without pumping work", async () => {
  const state = {
    projectId: "project",
    agents: [],
    reservation: { id: "held" },
  };
  const events = [];
  const foundation = new AgentFoundation({
    store: {
      snapshot: () => structuredClone(state),
      update: async (mutate) => {
        assert.equal(
          foundation.executionAllowed({ projectId: "project" }),
          false,
        );
        mutate(state);
        events.push("cleared");
      },
      close: async () => {
        events.push("closed");
      },
    },
  });
  foundation.flush = async () => {
    assert.fail("Shutdown must never pump input");
  };
  await assert.rejects(foundation.dispose("different"), /does not match/);
  assert.equal(state.reservation.id, "held");
  assert.deepEqual(events, []);
  await foundation.dispose("held");
  assert.equal(state.reservation, null);
  assert.deepEqual(events, ["cleared", "closed"]);
});
