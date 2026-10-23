// Focused real permission-service check. No native model, browser, or execution.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessStore } from "../runtime/access/state.mjs";
import { ProjectAuthorizationService } from "../runtime/access/authorization.mjs";
const dir = await mkdtemp(join(tmpdir(), "crew-browser-discovery-"));
let store;
try {
  store = await AccessStore.create(join(dir, "access"), "fixture", "owner");
  const agent = {
    id: "agent",
    projectId: "fixture",
    archivedAt: null,
    runtime: {
      session: {
        sessionId: "session",
        desiredState: "started",
        observedState: "starting",
      },
    },
  };
  const auth = new ProjectAuthorizationService(
    store,
    {
      getAgent: async (id) => (id === agent.id ? agent : null),
      getJob: async () => null,
    },
    { hasOperation: async () => false },
  );
  const caller = {
    projectId: "fixture",
    agentId: "agent",
    sessionId: "session",
  };
  const owner = { type: "user", userId: "owner" };
  assert.equal(await auth.canDiscoverBrowser(caller), false);
  await auth.saveGroup(
    owner,
    {
      id: "browser",
      projectId: "fixture",
      name: "Browser",
      description: "",
      revision: 1,
      updatedAt: new Date().toISOString(),
      grants: {
        crew: [{ action: "browser.control" }],
        services: [],
        environmentPolicyIds: [],
      },
    },
    null,
  );
  await auth.setAssignments(owner, "agent", ["browser"], [], null);
  const before = await readFile(join(dir, "access/access.json"), "utf8");
  let notifications = 0;
  const unsubscribe = store.subscribe(() => notifications++);
  assert.equal(await auth.canDiscoverBrowser(caller), true);
  assert.equal(
    (await auth.checkCrew(caller, "browser.control", { type: "project" }))
      .state,
    "denied",
  );
  for (const patch of [
    { projectId: "foreign" },
    { agentId: "foreign" },
    { sessionId: "stale" },
  ])
    assert.equal(await auth.canDiscoverBrowser({ ...caller, ...patch }), false);
  for (const state of ["stopping", "stopped", "failed"]) {
    agent.runtime.session.observedState = state;
    assert.equal(await auth.canDiscoverBrowser(caller), false);
  }
  agent.runtime.session.observedState = "started";
  assert.equal(await auth.canDiscoverBrowser(caller), true);
  assert.equal(
    (await auth.checkCrew(caller, "browser.control", { type: "project" }))
      .state,
    "allowed",
  );
  agent.archivedAt = new Date().toISOString();
  assert.equal(await auth.canDiscoverBrowser(caller), false);
  agent.archivedAt = null;
  agent.runtime.session.desiredState = "stopped";
  assert.equal(await auth.canDiscoverBrowser(caller), false);
  agent.runtime.session.desiredState = "started";
  assert.equal(await readFile(join(dir, "access/access.json"), "utf8"), before);
  assert.equal(notifications, 0);
  unsubscribe();
  await auth.setAssignments(owner, "agent", [], [], 1);
  assert.equal(await auth.canDiscoverBrowser(caller), false);
  await auth.setAssignments(owner, "agent", ["browser"], [], 2);
  await auth.closeSession(caller, "stop");
  assert.equal(await auth.canDiscoverBrowser(caller), false);
  console.log(
    "Browser discovery: real group/session checks pass; starting execution denied; no discovery state writes or notifications",
  );
} finally {
  try {
    await store?.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
