import assert from "node:assert/strict";
import test from "node:test";
import { createSubscriptionUsageOwnerAdapter } from "../src/application/subscription-usage.mts";
import { validSubscriptionUsageState } from "../renderer/src/agents/SubscriptionUsagePanel.tsx";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function snapshot(usedPercent = 25) {
  return {
    observedAt: "2026-10-22T12:00:00.000Z",
    ordinaryUsageAllowed: null,
    limits: [
      {
        limitId: "codex",
        limitName: null,
        normalModelSlug: null,
        primary: { usedPercent, windowDurationMins: 15, resetsAt: null },
        secondary: null,
      },
    ],
    resetCredits: {
      availableCount: 2,
      credits: [
        {
          resetType: "codexRateLimits",
          status: "available",
          grantedAt: null,
          expiresAt: 1,
          title: null,
          description: null,
        },
      ],
    },
  };
}

function fixture(read) {
  let notify;
  let reads = 0,
    unsubscribed = 0;
  const adapter = createSubscriptionUsageOwnerAdapter({
    usage: () => {
      reads++;
      return read();
    },
    subscribeUsage: (listener) => {
      notify = listener;
      return () => {
        unsubscribed++;
      };
    },
  });
  return {
    adapter,
    emit: (value) => notify(value),
    reads: () => reads,
    unsubscribed: () => unsubscribed,
  };
}

test("owner usage keeps nullable and expired details and retains the successful snapshot on errors", async () => {
  const successful = snapshot(null);
  let result = { state: "acknowledged", value: successful };
  const f = fixture(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  try {
    const initial = await f.adapter.read();
    assert.equal(validSubscriptionUsageState(initial), true);
    assert.equal(initial.snapshot.limits[0].primary.usedPercent, null);
    assert.equal(initial.snapshot.limits[0].secondary, null);
    assert.equal(initial.snapshot.resetCredits.availableCount, 2);
    assert.equal(initial.snapshot.resetCredits.credits.length, 1);
    assert.equal(initial.snapshot.resetCredits.credits[0].expiresAt, 1);

    for (const [failure, status] of [
      [
        {
          state: "failed",
          error: { code: "unsupported", message: "Unavailable" },
        },
        "unsupported",
      ],
      [
        {
          state: "failed",
          error: { code: "disconnected", message: "Unavailable" },
        },
        "disconnected",
      ],
      [new Error("Untrusted native error details"), "error"],
    ]) {
      result = failure;
      const stale = await f.adapter.read();
      assert.equal(stale.status, status);
      assert.equal(validSubscriptionUsageState(stale), true);
      assert.deepEqual(stale.snapshot, successful);
      assert.equal("error" in stale, false);
    }
    const invalid = structuredClone(initial);
    invalid.snapshot.limits[0].primary.resetsAt = Infinity;
    assert.equal(validSubscriptionUsageState(invalid), false);
  } finally {
    f.adapter.dispose();
  }
});

test("a newer usage event wins an in-flight read and disposal stops later reads and notifications", async () => {
  const first = deferred(),
    second = deferred();
  const pending = [first, second];
  const f = fixture(() => pending.shift().promise);
  const published = [];
  f.adapter.subscribe((value) => published.push(value));

  const read = f.adapter.read();
  const newer = snapshot(40);
  f.emit(newer);
  first.resolve({ state: "acknowledged", value: snapshot(20) });
  const result = await read;
  assert.equal(result.snapshot.limits[0].primary.usedPercent, 40);
  assert.equal(published.length, 1);

  const duringDispose = f.adapter.read();
  f.adapter.dispose();
  second.resolve({ state: "acknowledged", value: snapshot(60) });
  f.emit(snapshot(70));
  const retained = await duringDispose;
  assert.equal(retained.snapshot.limits[0].primary.usedPercent, 40);
  assert.equal(published.length, 1);
  assert.equal(f.unsubscribed(), 1);
  const afterDispose = await f.adapter.read();
  assert.equal(f.reads(), 2);
  assert.deepEqual(afterDispose, retained);
});

test("concurrent owner readers share one native read and receive independent snapshots", async () => {
  const native = deferred();
  const f = fixture(() => native.promise);
  try {
    const first = f.adapter.read(),
      second = f.adapter.read();
    assert.equal(f.reads(), 1);
    native.resolve({ state: "acknowledged", value: snapshot(35) });
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, b);
    a.snapshot.limits[0].primary.usedPercent = 99;
    assert.equal(b.snapshot.limits[0].primary.usedPercent, 35);
  } finally {
    f.adapter.dispose();
  }
});
