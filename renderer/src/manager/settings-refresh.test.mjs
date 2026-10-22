import test from "node:test";
import assert from "node:assert/strict";
import { createSettingsRefresh } from "./settings-refresh.ts";
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const value = (projectId = "one", sequence = 1, source = "controller-one") => ({
  projectId,
  settingsRevision: { source, sequence },
});
test("coalesces invalidations, discards invalidated results and publishes only the fresh observation", async () => {
  const a = deferred(),
    b = deferred(),
    seen = [],
    errors = [];
  let reads = 0;
  const cache = createSettingsRefresh(
    () => [a, b][reads++].promise,
    (v) => seen.push(v),
    (e) => errors.push(e),
  );
  cache.bind("one");
  const first = cache.load();
  assert.equal(cache.load(), first);
  assert.equal(cache.invalidate("one"), first);
  a.resolve(value());
  await Promise.resolve();
  assert.equal(reads, 2);
  assert.deepEqual(seen, []);
  b.resolve(value("one", 2));
  await first;
  assert.equal(seen[0].settingsRevision.sequence, 2);
  assert.deepEqual(errors, []);
});
test("rejects cross-project and old revisions, retains previous snapshot on error, accepts a new controller epoch", async () => {
  let next = value(),
    reads = 0;
  const seen = [],
    errors = [];
  const cache = createSettingsRefresh(
    async () => {
      reads++;
      return next;
    },
    (v) => seen.push(v),
    (e) => errors.push(e),
  );
  cache.bind("one");
  await cache.load();
  await cache.invalidate("two");
  assert.equal(reads, 1);
  next = value("two", 2);
  await assert.rejects(cache.load(), /different project/);
  assert.equal(seen.length, 1);
  next = value("one", 0);
  await assert.rejects(cache.load(), /older Settings/);
  assert.equal(seen.length, 1);
  next = value("one", 1, "restarted-controller");
  await cache.load();
  assert.equal(seen.length, 2);
  assert.equal(errors.length, 2);
});
test("rebinding projects during a pending read refetches and disposal suppresses late UI writes", async () => {
  const a = deferred(),
    b = deferred(),
    seen = [];
  let reads = 0;
  const cache = createSettingsRefresh(
    () => [a, b][reads++].promise,
    (v) => seen.push(v),
    () => {},
  );
  cache.bind("one");
  const pending = cache.load();
  cache.bind("two");
  a.resolve(value());
  await Promise.resolve();
  b.resolve(value("two"));
  await pending;
  assert.equal(seen[0].projectId, "two");
  const late = deferred();
  const closed = createSettingsRefresh(
    () => late.promise,
    (v) => seen.push(v),
    () => {},
  );
  const request = closed.load();
  closed.dispose();
  late.resolve(value());
  await request;
  assert.equal(seen.length, 1);
});
test("a failed invalidated read retries once for the pending observation", async () => {
  const a = deferred(),
    seen = [],
    errors = [];
  let reads = 0;
  const cache = createSettingsRefresh(
    () => (++reads === 1 ? a.promise : Promise.resolve(value())),
    (v) => seen.push(v),
    (e) => errors.push(e),
  );
  const pending = cache.load();
  cache.load();
  a.reject(Error("old request failed"));
  await pending;
  assert.equal(reads, 2);
  assert.equal(seen.length, 1);
  assert.deepEqual(errors, []);
});
