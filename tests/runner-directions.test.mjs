// GH-50: durable steering boundary and failure recovery, independent of model behavior.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createTask,
  updateTask,
  readTask,
  requestWorkerFollowup,
} from "../runtime/orchestration/store.mjs";
import { createRunnerDirections } from "../runtime/workers/runner-directions.mjs";
async function fixture(t, steer) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "crew-steer-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const taskId = "steering-fixture",
    runId = "steering-run";
  await createTask(stateDir, {
    requestId: taskId,
    ticket: "GH-50",
    brief: "Original bounded assignment",
  });
  await updateTask(stateDir, taskId, (n) => {
    n.runId = runId;
    n.threadId = "thread";
    n.status = "running";
  });
  const live = {
    threadId: "thread",
    turnId: "turn",
    acknowledged: true,
    ending: false,
  };
  let calls = [];
  const options = {
    stateDir,
    taskId,
    runId,
    snapshot: () => ({ ...live }),
    steer: async (input) => {
      calls.push(input);
      return steer ? steer(input) : { turnId: input.expectedTurnId };
    },
  };
  return {
    stateDir,
    taskId,
    runId,
    live,
    calls,
    options,
    observer: createRunnerDirections(options),
    read: () => readTask(stateDir, taskId),
    follow: (requestId = "first-direction") =>
      requestWorkerFollowup(stateDir, {
        taskId,
        requestId,
        brief: "Correction " + requestId,
      }),
  };
}
test("ordered live steering waits for start acknowledgement and preserves task/run/question correlation", async (t) => {
  const f = await fixture(t);
  await f.follow();
  await f.follow("second-direction");
  await updateTask(f.stateDir, f.taskId, (n) => {
    n.question = {
      id: "question",
      runId: f.runId,
      message: "Exact pending question",
    };
  });
  const before = await f.read();
  f.live.acknowledged = false;
  await f.observer.observe();
  assert.equal(f.calls.length, 0);
  f.live.acknowledged = true;
  await Promise.all([f.observer.observe(), f.observer.observe()]);
  await f.observer.observe();
  const after = await f.read();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(
    f.calls.map((c) => c.requestId),
    ["first-direction", "second-direction"],
  );
  assert.equal(after.runId, before.runId);
  assert.equal(after.currentAssignmentId, before.currentAssignmentId);
  assert.deepEqual(after.question, before.question);
  assert.equal(after.result, undefined);
  assert.deepEqual(
    after.assignments.slice(1).map((a) => a.status),
    ["steered", "steered"],
  );
  assert.deepEqual(
    after.assignments[1].deliveryHistory.map((d) => d.state),
    ["attempted", "acknowledged"],
  );
  await createRunnerDirections(f.options).observe();
  assert.equal(
    f.calls.length,
    2,
    "reconstructed observer never replays accepted input",
  );
});
for (const [label, steer, state] of [
  [
    "channel closed before send",
    async () => {
      throw Object.assign(Error("closed"), { nativeNotSent: true });
    },
    "rejected",
  ],
  [
    "lost acknowledgement",
    async () => {
      throw Error("pipe closed");
    },
    "uncertain",
  ],
  [
    "wrong turn acknowledgement",
    async () => ({ turnId: "different" }),
    "uncertain",
  ],
  [
    "definite unsupported protocol",
    async () => {
      throw Object.assign(Error("method not found"), { nativeRejected: true });
    },
    "failed",
  ],
  [
    "turn-ending race",
    async () => {
      throw Object.assign(Error("no active turn to steer"), {
        nativeRejected: true,
      });
    },
    "rejected",
  ],
])
  test(label + " is durable and never blindly replays", async (t) => {
    const f = await fixture(t, steer);
    await f.follow();
    await f.follow("second-direction");
    await f.observer.observe();
    const task = await f.read();
    assert.equal(task.assignments[1].delivery.state, state);
    assert.equal(task.assignments[1].status, "queued");
    assert.ok(task.followupWait);
    await f.observer.observe();
    await createRunnerDirections(f.options).observe();
    assert.equal(f.calls.length, 1);
    assert.equal(task.assignments[2].delivery.state, "pending");
  });
test("unacknowledged durable attempt survives observer recovery without duplicate delivery", async (t) => {
  const f = await fixture(t);
  await f.follow();
  await updateTask(f.stateDir, f.taskId, (n) => {
    n.assignments[1].delivery = {
      state: "attempted",
      at: new Date().toISOString(),
      runId: f.runId,
      threadId: "thread",
      turnId: "turn",
    };
  });
  await f.observer.observe();
  assert.equal(f.calls.length, 0);
  assert.equal((await f.read()).assignments[1].delivery.state, "attempted");
});
test("stale run, mismatched thread, ending turn and pending lifecycle cannot steer", async (t) => {
  const f = await fixture(t);
  await f.follow();
  f.live.ending = true;
  await f.observer.observe();
  f.live.ending = false;
  f.live.threadId = "other";
  await f.observer.observe();
  f.live.threadId = "thread";
  await updateTask(f.stateDir, f.taskId, (n) => {
    n.lifecycleRequests = [
      {
        id: "pause-request",
        action: "pause",
        status: "pending",
        at: new Date().toISOString(),
      },
    ];
  });
  await f.observer.observe();
  await updateTask(f.stateDir, f.taskId, (n) => {
    n.lifecycleRequests = [];
    n.runId = "newer-run";
  });
  await f.observer.observe();
  assert.equal(f.calls.length, 0);
});

test("closed-connection recovery preserves uncertain input and only definite rejection permits idle continuation", async (t) => {
  const { createWorkerDirections } =
    await import("../runtime/workers/worker-directions.mjs");
  for (const prior of ["attempted", "uncertain", "failed", "rejected"]) {
    const f = await fixture(t);
    await f.follow();
    await updateTask(f.stateDir, f.taskId, (n) => {
      n.worktree = "/disposable/retained-worktree";
      n.assignments[1].delivery = {
        state: prior,
        at: new Date().toISOString(),
        runId: f.runId,
        threadId: "thread",
        turnId: "turn",
      };
    });
    const directions = createWorkerDirections({
      stateDir: f.stateDir,
      launches: new Set(),
      operations: new Set(),
      ownedRunnerAlive: async () => false,
      getProcessSnapshot: () => new Map(),
      admissionHeld: async () => false,
    });
    await directions.activateFollowup(await f.read());
    const result = await f.read();
    if (prior === "rejected") {
      assert.equal(result.currentAssignmentId, "first-direction");
      assert.equal(result.status, "resume_queued");
      assert.equal(
        result.runId,
        f.runId,
        "selection itself never starts a native turn",
      );
    } else {
      assert.equal(result.currentAssignmentId, "initial");
      assert.equal(
        result.assignments[1].delivery.state,
        prior === "attempted" ? "uncertain" : prior,
      );
      assert.ok(result.followupWait);
    }
  }
});

test("durable preparation holds ordinary steering until cancellation, then the same turn can receive it", async (t) => {
  const { beginPreparation, cancelPreparation } =
    await import("../runtime/preparation/store.mjs");
  const f = await fixture(t);
  await beginPreparation(f.stateDir, {
    id: "steering-preparation",
    projectId: "fixture",
    purpose: "update",
    participants: [],
  });
  await f.follow();
  await f.observer.observe();
  assert.equal(f.calls.length, 0);
  assert.equal((await f.read()).assignments[1].delivery.state, "pending");
  await cancelPreparation(f.stateDir, "steering-preparation");
  await f.observer.observe();
  assert.equal(f.calls.length, 1);
  assert.equal((await f.read()).assignments[1].delivery.state, "acknowledged");
});

test("shared admission holds steering before a project preparation journal exists and releases on explicit return", async (t) => {
  const { configureGlobalCapacity } =
    await import("../runtime/orchestration/capacity.mjs");
  const f = await fixture(t),
    globalCapacityDir = path.join(f.stateDir, "shared-capacity");
  const observer = createRunnerDirections({ ...f.options, globalCapacityDir });
  await f.follow();
  await observer.observe();
  assert.equal(
    f.calls.length,
    0,
    "configured missing shared state is unknown and held",
  );
  await configureGlobalCapacity({
    dir: globalCapacityDir,
    limit: 1,
    stateDirs: [f.stateDir],
    admissionPaused: true,
  });
  await observer.observe();
  assert.equal(
    f.calls.length,
    0,
    "global hold precedes the child preparation journal",
  );
  await configureGlobalCapacity({
    dir: globalCapacityDir,
    admissionPaused: false,
  });
  await observer.observe();
  assert.equal(f.calls.length, 1);
  assert.equal((await f.read()).assignments[1].delivery.state, "acknowledged");
});

test("saved-profile failure sends nothing, retains recovery and never blindly retries the direction", async (t) => {
  const f = await fixture(t);
  await f.follow();
  const observer = createRunnerDirections({
    ...f.options,
    prepareText: async () => {
      throw Error("saved profile unreadable");
    },
  });
  await observer.observe();
  assert.equal(f.calls.length, 0);
  const task = await f.read();
  assert.equal(task.assignments[1].delivery.state, "failed");
  assert.match(
    task.followupWait,
    /no direction was sent.*Restore saved Settings/i,
  );
  await createRunnerDirections(f.options).observe();
  assert.equal(f.calls.length, 0);
});

// REL-0.18.0: the saved-profile read must not extend a durable send claim
// across a new hold or invalidate the captured native/task identity.
const profileRaces = {
  capacity: async (f) => {
    const { configureGlobalCapacity } =
      await import("../runtime/orchestration/capacity.mjs");
    await configureGlobalCapacity({
      dir: f.options.globalCapacityDir,
      admissionPaused: true,
    });
    return () =>
      configureGlobalCapacity({
        dir: f.options.globalCapacityDir,
        admissionPaused: false,
      });
  },
  update: async (f) => {
    const { createUpdatePlan } = await import("../runtime/updates/plan.mjs");
    const engine = createUpdatePlan({
      stateDir: f.stateDir,
      version: "0.18.0",
      getView: async () => ({ tasks: [] }),
      getManager: async () => ({
        status: "ready",
        workStarting: false,
        approvals: [],
      }),
      stopVoice: async () => {},
      interruptManager: async () => {},
      requestAction: async () => {},
      activity: async () => ({ safe: false, reasons: ["Disposable hold"] }),
    });
    await engine.ready;
    await engine.begin({ targetVersion: "0.18.1" });
    return async () => {
      await engine.cancel();
      await engine.releaseForReview();
    };
  },
  preparation: async (f) => {
    const { beginPreparation, cancelPreparation } =
      await import("../runtime/preparation/store.mjs");
    await beginPreparation(f.stateDir, {
      id: "profile-read-race",
      projectId: "fixture",
      purpose: "update",
      participants: [],
    });
    return () => cancelPreparation(f.stateDir, "profile-read-race");
  },
  archive: async (f) => {
    await updateTask(f.stateDir, f.taskId, (n) => {
      n.lifecycleRequests = [
        {
          id: "archive-during-profile",
          action: "archive",
          status: "pending",
          at: new Date().toISOString(),
        },
      ];
    });
    return () =>
      updateTask(f.stateDir, f.taskId, (n) => {
        n.lifecycleRequests = [];
      });
  },
  archived: async (f) => {
    await updateTask(f.stateDir, f.taskId, (n) => {
      n.status = "archived";
    });
    return () =>
      updateTask(f.stateDir, f.taskId, (n) => {
        n.status = "running";
      });
  },
  ending: async (f) => {
    f.live.ending = true;
    return async () => {
      f.live.ending = false;
    };
  },
  turn: async (f) => {
    f.live.turnId = "newer-turn";
    return async () => {
      f.live.turnId = "turn";
    };
  },
  acknowledgement: async (f) => {
    f.live.acknowledged = false;
    return async () => {
      f.live.acknowledged = true;
    };
  },
  run: async (f) => {
    await updateTask(f.stateDir, f.taskId, (n) => {
      n.runId = "newer-run";
    });
    return () =>
      updateTask(f.stateDir, f.taskId, (n) => {
        n.runId = f.runId;
      });
  },
  thread: async (f) => {
    await updateTask(f.stateDir, f.taskId, (n) => {
      n.threadId = "newer-thread";
    });
    return () =>
      updateTask(f.stateDir, f.taskId, (n) => {
        n.threadId = "thread";
      });
  },
};
for (const [name, hold] of Object.entries(profileRaces))
  test(`profile-read race: ${name} prevents native send and preserves the ordered pending direction`, async (t) => {
    const f = await fixture(t);
    const { configureGlobalCapacity } =
      await import("../runtime/orchestration/capacity.mjs");
    f.options.globalCapacityDir = path.join(f.stateDir, "capacity");
    await configureGlobalCapacity({
      dir: f.options.globalCapacityDir,
      admissionPaused: false,
    });
    await f.follow();
    await f.follow("second-direction");
    let enter, release;
    const entered = new Promise((r) => (enter = r)),
      gate = new Promise((r) => (release = r));
    t.after(() => release());
    let reads = 0;
    const observer = createRunnerDirections({
      ...f.options,
      prepareText: async (text) => {
        reads++;
        enter();
        await gate;
        return "CURRENT PROFILE\n" + text;
      },
    });
    const delivering = observer.observe();
    await entered;
    let clear;
    try {
      clear = await hold(f);
    } finally {
      release();
      await delivering;
    }
    assert.equal(
      f.calls.length,
      0,
      "No native input may cross the new hold/identity boundary",
    );
    let task = await f.read();
    assert.equal(task.assignments[1].delivery.state, "pending");
    assert.equal(task.assignments[2].delivery.state, "pending");
    assert.equal(
      task.assignments[1].deliveryHistory,
      undefined,
      "Preparation alone is not a delivery attempt",
    );
    await clear();
    await observer.observe();
    await observer.observe();
    assert.deepEqual(
      f.calls.map((c) => c.requestId),
      ["first-direction", "second-direction"],
    );
    assert.ok(f.calls.every((c) => c.text.startsWith("CURRENT PROFILE\n")));
    task = await f.read();
    assert.ok(
      task.assignments
        .slice(1)
        .every((a) => a.delivery.state === "acknowledged"),
    );
    assert.equal(
      reads,
      3,
      "The held direction rereads the saved profile before its later attempt",
    );
    await createRunnerDirections(f.options).observe();
    assert.equal(f.calls.length, 2, "Acknowledged input is never replayed");
  });

test("hold after native send retains acknowledgement and never replays accepted input", async (t) => {
  const f = await fixture(t);
  await f.follow();
  let enter, release;
  const entered = new Promise((r) => (enter = r)),
    gate = new Promise((r) => (release = r));
  t.after(() => release());
  const observer = createRunnerDirections({
    ...f.options,
    steer: async (input) => {
      f.calls.push(input);
      enter();
      await gate;
      return { turnId: input.expectedTurnId };
    },
  });
  const delivering = observer.observe();
  await entered;
  const { beginPreparation, cancelPreparation } =
    await import("../runtime/preparation/store.mjs");
  try {
    await beginPreparation(f.stateDir, {
      id: "after-send-hold",
      projectId: "fixture",
      purpose: "update",
      participants: [],
    });
  } finally {
    release();
    await delivering;
  }
  assert.equal((await f.read()).assignments[1].delivery.state, "acknowledged");
  await observer.observe();
  await cancelPreparation(f.stateDir, "after-send-hold");
  await createRunnerDirections(f.options).observe();
  assert.equal(f.calls.length, 1);
});

test("concurrent profile preparation still permits only one durable native attempt", async (t) => {
  const f = await fixture(t);
  await f.follow();
  let release, bothReady;
  const gate = new Promise((r) => (release = r)),
    entered = new Promise((r) => (bothReady = r));
  t.after(() => release());
  let readers = 0;
  const options = {
    ...f.options,
    prepareText: async (text) => {
      if (++readers === 2) bothReady();
      await gate;
      return text;
    },
  };
  const one = createRunnerDirections(options),
    two = createRunnerDirections(options);
  const attempts = [one.observe(), two.observe()];
  await entered;
  assert.equal((await f.read()).assignments[1].delivery.state, "pending");
  release();
  await Promise.all(attempts);
  const task = await f.read();
  assert.equal(f.calls.length, 1);
  assert.equal(task.assignments[1].delivery.state, "acknowledged");
  assert.deepEqual(
    task.assignments[1].deliveryHistory.map((d) => d.state),
    ["attempted", "acknowledged"],
  );
  await createRunnerDirections(f.options).observe();
  assert.equal(f.calls.length, 1);
});
