import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FoundationStore } from "../src/agents/store.mts";
import { FoundationRecords } from "../src/agents/records.mts";
import { AgentFileStorage } from "../src/agents/agent-storage.mts";

const owner = { type: "owner", userId: "owner" };
const ownerActor = { type: "user", userId: "owner" };
const identity = { projectId: "project", ownerUserId: "owner" };
const bytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function fixture(t) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "crew-agent-folders-")),
  );
  const directory = join(root, "foundation");
  let store = await FoundationStore.open({ directory, ...identity });
  const f = {
    root,
    directory,
    get store() {
      return store;
    },
    async close() {
      if (store) {
        await store.close();
        store = null;
      }
    },
    async reopen() {
      await f.close();
      store = await FoundationStore.open({ directory, ...identity });
      return store;
    },
    async create(name, reportsTo = ownerActor) {
      const records = new FoundationRecords(
        store,
        {
          checkCrew: async () => {
            assert.fail(
              "Owner persistence requires no agent permission/network check",
            );
          },
        },
        { validate: async () => true },
      );
      return records.createAgent(owner, {
        profile: {
          name,
          pictureRef: "existing/image-ref",
          personality: "",
          systemPrompt: `Instructions for ${name}`,
          voice: "marin",
        },
        modelAccessId: "subscription",
        configRef: "native-runtime",
        reportsTo,
      });
    },
    async index() {
      return JSON.parse(
        await readFile(join(directory, "foundation.json"), "utf8"),
      );
    },
    core(ref) {
      return join(directory, ref.directory, ref.file);
    },
  };
  t.after(async () => {
    await f.close();
    await rm(root, { recursive: true, force: true });
  });
  return f;
}

function nextIndex(previous, state) {
  return {
    ...state,
    schema: 2,
    agents: state.agents.map((agent) => ({
      id: agent.id,
      directory:
        previous.agents.find((ref) => ref.id === agent.id)?.directory ??
        `agents/${agent.id}`,
      file: "agent.json",
      sha256: sha256(bytes(agent)),
    })),
  };
}
async function pending(f, previousBytes, nextState) {
  const journal = {
    schema: 1,
    transactionId: "controlled-recovery-transaction",
    previousIndexSha256: previousBytes === null ? null : sha256(previousBytes),
    nextState,
  };
  await writeFile(
    join(f.directory, "foundation.pending.json"),
    JSON.stringify(journal),
    { mode: 0o600 },
  );
  return journal;
}
async function stageCore(f, ref, agent) {
  await mkdir(dirname(f.core(ref)), { recursive: true, mode: 0o700 });
  await mkdir(join(dirname(f.core(ref)), "assets"), { mode: 0o700 }).catch(
    (error) => {
      if (error.code !== "EEXIST") throw error;
    },
  );
  await writeFile(f.core(ref), bytes(agent), { mode: 0o600 });
}

test("agents have independent peer folders; index holds only pointers and reparent/archive retain paths and assets", async (t) => {
  const f = await fixture(t);
  const empty = await f.index();
  assert.equal(empty.schema, 2);
  assert.deepEqual(empty.agents, []);
  const specialist = await f.create("Marketing");
  const child = await f.create("Campaign worker", {
    type: "agent",
    agentId: specialist.id,
  });
  const other = await f.create("Development");
  const before = await f.index();
  assert.equal(before.agents.length, 3);
  for (const ref of before.agents) {
    assert.deepEqual(Object.keys(ref).sort(), [
      "directory",
      "file",
      "id",
      "sha256",
    ]);
    assert.equal(ref.directory, `agents/${ref.id}`);
    assert.equal(ref.file, "agent.json");
    assert.equal((await lstat(dirname(f.core(ref)))).mode & 0o777, 0o700);
    assert.equal(
      (await lstat(join(dirname(f.core(ref)), "assets"))).mode & 0o777,
      0o700,
    );
    assert.equal((await lstat(f.core(ref))).mode & 0o777, 0o600);
    assert.equal(sha256(await readFile(f.core(ref))), ref.sha256);
  }
  const childRef = before.agents.find((ref) => ref.id === child.id);
  const asset = join(dirname(f.core(childRef)), "assets", "retained.txt");
  await writeFile(asset, "private agent asset", { mode: 0o600 });
  const unchangedRef = before.agents.find((ref) => ref.id === other.id);
  const unchangedBefore = await lstat(f.core(unchangedRef), { bigint: true });
  const changedBefore = await lstat(f.core(childRef), { bigint: true });
  await f.store.update((state) => {
    const agent = state.agents.find((entry) => entry.id === child.id);
    agent.reportsTo = { type: "agent", agentId: other.id };
    agent.archivedAt = new Date().toISOString();
    agent.scratchpad.markdown = "Retained private notes";
  });
  const after = await f.index();
  assert.equal(
    after.agents.find((ref) => ref.id === child.id).directory,
    childRef.directory,
  );
  assert.notEqual(
    (await lstat(f.core(childRef), { bigint: true })).ino,
    changedBefore.ino,
  );
  const unchangedAfter = await lstat(f.core(unchangedRef), { bigint: true });
  assert.equal(unchangedAfter.ino, unchangedBefore.ino);
  assert.equal(unchangedAfter.mtimeNs, unchangedBefore.mtimeNs);
  assert.equal(await readFile(asset, "utf8"), "private agent asset");
  const saved = f.store.snapshot();
  await f.reopen();
  assert.deepEqual(f.store.snapshot(), saved);
  assert.equal(await readFile(asset, "utf8"), "private agent asset");
});

test("legacy inline state migrates with an exact immutable private backup and retained references", async (t) => {
  const f = await fixture(t);
  const parent = await f.create("Assistant");
  await f.create("Worker", { type: "agent", agentId: parent.id });
  const originalState = f.store.snapshot();
  await f.close();
  await rm(join(f.directory, "agents"), { recursive: true });
  const originalBytes = Buffer.from(
    `${JSON.stringify(originalState, null, 4)}\n`,
  );
  await writeFile(join(f.directory, "foundation.json"), originalBytes, {
    mode: 0o600,
  });
  await f.reopen();
  assert.deepEqual(f.store.snapshot(), originalState);
  const index = await f.index();
  assert.equal(index.schema, 2);
  assert.equal(index.agents[0].profile, undefined);
  const backups = (await readdir(f.directory)).filter((name) =>
    name.startsWith("foundation.legacy-"),
  );
  assert.deepEqual(backups, [
    `foundation.legacy-${sha256(originalBytes)}.json`,
  ]);
  const backupPath = join(f.directory, backups[0]);
  assert.deepEqual(await readFile(backupPath), originalBytes);
  assert.equal((await lstat(backupPath)).mode & 0o777, 0o600);
  const backupInode = (await lstat(backupPath)).ino;
  await f.reopen();
  assert.equal((await lstat(backupPath)).ino, backupInode);
  assert.equal(
    f.store.snapshot().agents[0].profile.pictureRef,
    "existing/image-ref",
  );
});

test("IDs cannot choose paths or alias another folder on case-insensitive volumes", async (t) => {
  const f = await fixture(t);
  const template = await f.create("Template");
  const source = f.store.snapshot().agents[0];
  await f.store.update((state) => {
    state.agents = [
      "simple-worker",
      "../escaped",
      "Marketing",
      "marketing",
      "sha256-reserved",
    ].map((id) => ({ ...structuredClone(source), id }));
  });
  const index = await f.index();
  assert.equal(index.agents[0].directory, "agents/simple-worker");
  assert.equal(index.agents[3].directory, "agents/marketing");
  for (const ref of index.agents.filter((ref) =>
    ["../escaped", "Marketing", "sha256-reserved"].includes(ref.id),
  ))
    assert.equal(ref.directory, `agents/sha256-${sha256(Buffer.from(ref.id))}`);
  assert.equal(
    new Set(index.agents.map((ref) => ref.directory.toLowerCase())).size,
    5,
  );
  await f.reopen();
  assert.equal(f.store.snapshot().agents.length, 5);
  assert.ok(
    await lstat(join(f.directory, "agents", template.id)),
    "unreferenced historical folder is retained",
  );
});

test("missing, tampered, aliased or unsafe persisted records fail closed without resetting state", async (t) => {
  for (const change of [
    "missing",
    "hash",
    "path",
    "duplicate",
    "schema",
    "core-id",
    "core-project",
    "owner",
    "assets-mode",
    "assets-symlink",
    "core-symlink",
    "hardlink",
    "file-mode",
  ]) {
    await t.test(change, async (t) => {
      const f = await fixture(t);
      await f.create("Assistant");
      const index = await f.index();
      const ref = index.agents[0];
      await f.close();
      if (change === "missing") await unlink(f.core(ref));
      else if (change === "hash")
        await writeFile(f.core(ref), "{}", { mode: 0o600 });
      else if (change === "path") ref.directory = "../../outside";
      else if (change === "duplicate") index.agents.push({ ...ref });
      else if (change === "schema") index.schema = 999;
      else if (change === "owner") index.ownerUserId = "different-owner";
      else if (change === "assets-mode")
        await chmod(join(dirname(f.core(ref)), "assets"), 0o777);
      else if (change === "file-mode") await chmod(f.core(ref), 0o644);
      else if (change === "hardlink")
        await link(f.core(ref), join(f.root, "linked-agent"));
      else if (change === "assets-symlink") {
        await rename(
          join(dirname(f.core(ref)), "assets"),
          join(f.root, "saved-assets"),
        );
        await symlink(
          join(f.root, "saved-assets"),
          join(dirname(f.core(ref)), "assets"),
        );
      } else if (change === "core-symlink") {
        await rename(f.core(ref), join(f.root, "saved-agent.json"));
        await symlink(join(f.root, "saved-agent.json"), f.core(ref));
      } else {
        const core = JSON.parse(await readFile(f.core(ref), "utf8"));
        if (change === "core-id") core.id = "wrong-id";
        else core.projectId = "wrong-project";
        const changed = bytes(core);
        await writeFile(f.core(ref), changed, { mode: 0o600 });
        ref.sha256 = sha256(changed);
      }
      const invalidIndex = bytes(index);
      await writeFile(join(f.directory, "foundation.json"), invalidIndex, {
        mode: 0o600,
      });
      await assert.rejects(f.reopen(), /could not be opened safely/);
      assert.deepEqual(
        await readFile(join(f.directory, "foundation.json")),
        invalidIndex,
      );
    });
  }
});

test("prepared journal replays partial core writes before exposing the next complete snapshot", async (t) => {
  const f = await fixture(t);
  await f.create("First");
  await f.create("Second");
  const previous = await f.index();
  const previousBytes = await readFile(join(f.directory, "foundation.json"));
  const next = f.store.snapshot();
  next.agents[0].profile.name = "Changed first";
  next.agents[1].scratchpad.markdown = "Changed second notes";
  next.agents.push({
    ...structuredClone(next.agents[0]),
    id: "new-child",
    reportsTo: { type: "agent", agentId: next.agents[1].id },
  });
  const desired = nextIndex(previous, next);
  await f.close();
  await pending(f, previousBytes, next);
  await stageCore(f, desired.agents[0], next.agents[0]);
  await f.reopen();
  assert.deepEqual(f.store.snapshot(), next);
  assert.deepEqual(await f.index(), desired);
  await assert.rejects(lstat(join(f.directory, "foundation.pending.json")), {
    code: "ENOENT",
  });
  await f.reopen();
  assert.deepEqual(f.store.snapshot(), next);
});

test("committed journal only cleans up after verifying every committed core", async (t) => {
  const f = await fixture(t);
  await f.create("Before");
  const previous = await f.index();
  const previousBytes = await readFile(join(f.directory, "foundation.json"));
  const next = f.store.snapshot();
  next.agents[0].profile.name = "Committed";
  const desired = nextIndex(previous, next);
  await f.close();
  await pending(f, previousBytes, next);
  await stageCore(f, desired.agents[0], next.agents[0]);
  const inode = (await lstat(f.core(desired.agents[0]))).ino;
  await writeFile(join(f.directory, "foundation.json"), bytes(desired), {
    mode: 0o600,
  });
  await f.reopen();
  assert.deepEqual(f.store.snapshot(), next);
  assert.equal((await lstat(f.core(desired.agents[0]))).ino, inode);
  await assert.rejects(lstat(join(f.directory, "foundation.pending.json")), {
    code: "ENOENT",
  });
});

test("journal recovery refuses divergent index, corrupt staged core and corrupt committed core", async (t) => {
  for (const change of [
    "index",
    "staged-core",
    "committed-core",
    "invalid-state",
  ]) {
    await t.test(change, async (t) => {
      const f = await fixture(t);
      await f.create("Before");
      const previous = await f.index();
      const previousBytes = await readFile(
        join(f.directory, "foundation.json"),
      );
      const next = f.store.snapshot();
      next.agents[0].profile.name = "After";
      const desired = nextIndex(previous, next);
      await f.close();
      if (change === "invalid-state")
        next.agents[0].reportsTo = { type: "agent", agentId: "missing-parent" };
      await pending(f, previousBytes, next);
      if (change === "index") {
        previous.projectSettings.revision++;
        await writeFile(join(f.directory, "foundation.json"), bytes(previous), {
          mode: 0o600,
        });
      } else if (change === "staged-core") {
        await writeFile(f.core(previous.agents[0]), "{}", { mode: 0o600 });
      } else if (change === "committed-core") {
        await writeFile(join(f.directory, "foundation.json"), bytes(desired), {
          mode: 0o600,
        });
        await unlink(f.core(previous.agents[0]));
      }
      const prepared = await readFile(
        join(f.directory, "foundation.pending.json"),
      );
      const boundary = await readFile(join(f.directory, "foundation.json"));
      await assert.rejects(f.reopen(), /could not be opened safely/);
      assert.deepEqual(
        await readFile(join(f.directory, "foundation.pending.json")),
        prepared,
      );
      assert.deepEqual(
        await readFile(join(f.directory, "foundation.json")),
        boundary,
      );
    });
  }
});

test("lost writer ownership after prepare retains recovery journal and never reports an in-memory commit", async (t) => {
  const f = await fixture(t);
  await f.create("Before");
  const before = f.store.snapshot();
  const next = structuredClone(before);
  next.agents[0].profile.name = "After recovery";
  await f.close();
  let denyAfterPrepare = false;
  const storage = new AgentFileStorage(
    f.directory,
    identity,
    (value) => {
      assert.equal(value.schema, 1);
      assert.equal(value.projectId, "project");
      assert.equal(value.ownerUserId, "owner");
    },
    async () => {
      if (!denyAfterPrepare) return true;
      return !(await lstat(join(f.directory, "foundation.pending.json")).catch(
        () => null,
      ));
    },
  );
  assert.deepEqual(await storage.load(), before);
  denyAfterPrepare = true;
  await assert.rejects(storage.persist(next), /writer ownership was lost/);
  assert.ok(await lstat(join(f.directory, "foundation.pending.json")));
  await assert.rejects(storage.persist(before), /writer ownership was lost/);
  await f.reopen();
  assert.deepEqual(f.store.snapshot(), next);
});

test("root ancestor aliases and legacy 0755 root remain supported while new agent folders stay private", async (t) => {
  const f = await fixture(t);
  const agent = await f.create("Assistant");
  await f.close();
  await chmod(f.directory, 0o755);
  const alias = join(f.root, "alias");
  await symlink(f.root, alias);
  const aliased = await FoundationStore.open({
    directory: join(alias, "foundation"),
    ...identity,
  });
  assert.equal(aliased.snapshot().agents[0].id, agent.id);
  await aliased.close();
});

test("missing project index never resets retained agent folders or migration backups", async (t) => {
  const f = await fixture(t);
  await f.create("Retained");
  const index = await f.index();
  const core = await readFile(f.core(index.agents[0]));
  await f.close();
  await unlink(join(f.directory, "foundation.json"));
  await assert.rejects(f.reopen(), /could not be opened safely/);
  assert.deepEqual(await readFile(f.core(index.agents[0])), core);
  await assert.rejects(lstat(join(f.directory, "foundation.json")), {
    code: "ENOENT",
  });
  await rm(join(f.directory, "agents"), { recursive: true });
  const backup = join(f.directory, `foundation.legacy-${sha256(core)}.json`);
  await writeFile(backup, core, { mode: 0o600 });
  await assert.rejects(f.reopen(), /could not be opened safely/);
  assert.deepEqual(await readFile(backup), core);
});

test("genuinely empty agent directory permits initialization and prepared initial transactions recover without an index", async (t) => {
  const f = await fixture(t);
  await f.close();
  await unlink(join(f.directory, "foundation.json"));
  await mkdir(join(f.directory, "agents"), { mode: 0o700 });
  await f.reopen();
  assert.deepEqual(f.store.snapshot().agents, []);
  await f.create("Prepared initial agent");
  const next = f.store.snapshot();
  await f.close();
  await unlink(join(f.directory, "foundation.json"));
  await rm(join(f.directory, "agents"), { recursive: true });
  await pending(f, null, next);
  await f.reopen();
  assert.deepEqual(f.store.snapshot(), next);
});
