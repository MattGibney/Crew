import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FoundationStore } from "../src/agents/store.mts";
import { FoundationRecords } from "../src/agents/records.mts";

const owner = { type: "owner", userId: "owner" };
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "crew-archive-")));
  let store = await FoundationStore.open({
    directory: join(root, "foundation"),
    projectId: "project",
    ownerUserId: "owner",
  });
  const records = () =>
    new FoundationRecords(
      store,
      { checkCrew: async () => ({ allowed: true }) },
      { validate: async () => true },
    );
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    get store() {
      return store;
    },
    records,
    async reopen() {
      await store.close();
      store = await FoundationStore.open({
        directory: join(root, "foundation"),
        projectId: "project",
        ownerUserId: "owner",
      });
    },
    create: (name, reportsTo) =>
      records().createAgent(owner, {
        profile: {
          name,
          pictureRef: null,
          personality: "",
          systemPrompt: "Instructions",
        },
        modelAccessId: "model",
        configRef: "runtime",
        ...(reportsTo ? { reportsTo } : {}),
      }),
  };
}

test("archival and owner restore preserve identity, native chat, notes and actual last use", async (t) => {
  const f = await fixture(t);
  const agent = await f.create("Specialist");
  assert.match(agent.id, /^[0-9a-f-]{36}$/);
  assert.equal(agent.lastUsedAt, null);
  await f.store.update((state) => {
    const a = state.agents[0];
    a.runtime.threadId = "native-chat";
    a.lastUsedAt = "2026-10-22T20:00:00Z";
    a.scratchpad.markdown = "Private notes";
  });
  await f.records().archive(owner, agent.id);
  await assert.rejects(
    f
      .records()
      .restore({ type: "agent", caller: { agentId: agent.id } }, agent.id),
    /Only the owner/,
  );
  const restored = await f.records().restore(owner, agent.id);
  assert.equal(restored.archivedAt, null);
  assert.equal(restored.id, agent.id);
  assert.equal(restored.runtime.threadId, "native-chat");
  assert.equal(restored.runtime.session.observedState, "stopped");
  assert.equal(restored.lastUsedAt, "2026-10-22T20:00:00Z");
  assert.equal(restored.scratchpad.markdown, "Private notes");
  await assert.rejects(
    f.records().permanentlyDelete(owner, agent.id),
    /Only archived/,
  );
  await f.reopen();
  assert.equal(f.store.snapshot().agents[0].id, agent.id);
});

test("permanent deletion reparents children, unassigns jobs and preserves historical attribution", async (t) => {
  const f = await fixture(t);
  const agent = await f.create("Retired");
  const child = await f.create("Survivor", {
    type: "agent",
    agentId: agent.id,
  });
  const job = await f
    .records()
    .createJob(owner, {
      work: {
        type: "local",
        title: "Retained work",
        objective: "Keep history",
      },
      assignedToAgentId: agent.id,
    });
  await f.store.update((state) => {
    state.projectSettings.primaryAgentId = agent.id;
    state.projectSettings.contactAgentId = agent.id;
    state.jobs[0].progress.reportedByAgentId = agent.id;
    state.jobs[0].progress.reportedAt = "2026-10-22T20:00:00Z";
  });
  await f.records().archive(owner, agent.id);
  await assert.rejects(
    f
      .records()
      .permanentlyDelete(
        { type: "agent", caller: { agentId: child.id } },
        agent.id,
      ),
    /Only the owner/,
  );
  const deleted = await f.records().permanentlyDelete(owner, agent.id);
  assert.equal(deleted.agentId, agent.id);
  await f.reopen();
  const state = f.store.snapshot();
  assert.equal(state.agents.length, 1);
  assert.equal(state.agents[0].id, child.id);
  assert.deepEqual(state.agents[0].reportsTo, {
    type: "user",
    userId: "owner",
  });
  assert.equal(state.projectSettings.contactAgentId, null);
  assert.equal(state.projectSettings.primaryAgentId, null);
  assert.equal(state.jobs[0].id, job.id);
  assert.equal(state.jobs[0].assignment.assignedToAgentId, null);
  assert.equal(state.jobs[0].progress.reportedByAgentId, agent.id);
  assert.equal(
    state.jobs[0].assignmentHistory.at(-1).previousAgentId,
    agent.id,
  );
  assert.deepEqual(state.deletedAgents, [
    { id: agent.id, deletedAt: deleted.deletedAt },
  ]);
});
