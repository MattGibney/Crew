// Disposable #124 authorization and retained-state acceptance. No model/auth/media.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessStore } from "../runtime/access/state.mjs";
import { ProjectAuthorizationService } from "../runtime/access/authorization.mjs";
const dir = await mkdtemp(join(tmpdir(), "crew-group-capabilities-"));
const directory = join(dir, "access");
let store;
const owner = { type: "user", userId: "owner" };
const agents = ["one", "two"].map((id) => ({
  id,
  projectId: "fixture",
  archivedAt: null,
  runtime: {
    session: {
      sessionId: `session-${id}`,
      desiredState: "started",
      observedState: "started",
    },
  },
}));
const caller = {
  projectId: "fixture",
  agentId: "one",
  sessionId: "session-one",
};
const makeAuth = () =>
  new ProjectAuthorizationService(
    store,
    {
      getAgent: async (id) =>
        agents.find((agent) => agent.id === id) ??
        (id === "foreign" ? { ...agents[0], id, projectId: "other" } : null),
      getJob: async () => null,
    },
    {
      hasOperation: async (connection, operation) =>
        connection === "service" && operation === "read",
    },
  );
const group = (id, actions) => ({
  id,
  projectId: "fixture",
  name: id,
  description: "",
  revision: 1,
  updatedAt: new Date().toISOString(),
  grants: {
    crew: actions.map((action) => ({ action })),
    services: [],
    environmentPolicyIds: [],
  },
});
const target = { type: "agent", agentId: "two" };
try {
  store = await AccessStore.create(directory, "fixture", "owner");
  let auth = makeAuth();
  await auth.saveGroup(owner, group("read", ["agents.read"]), null);
  await auth.saveGroup(
    owner,
    group("browser", ["browser.control", "agents.update", "groups.assign"]),
    null,
  );
  assert.equal(
    (await auth.checkCrew(caller, "agents.read", target)).state,
    "denied",
  );
  await assert.rejects(
    auth.saveGroup(
      owner,
      {
        ...group("legacy", ["agents.read"]),
        grants: {
          crew: [{ action: "agents.read", scope: { type: "self" } }],
          services: [],
          environmentPolicyIds: [],
        },
      },
      null,
    ),
    /Invalid access group/,
  );
  await assert.rejects(
    auth.setAssignments(
      { type: "agent", agentId: "one" },
      "one",
      ["read"],
      [],
      null,
    ),
  );
  await auth.setAssignments(owner, "one", ["read"], [], null);
  assert.equal(
    (await auth.checkCrew(caller, "agents.read", target)).state,
    "allowed",
  );
  assert.equal(
    (await auth.checkCrew(caller, "agents.update", target)).state,
    "denied",
  );
  await auth.setAssignments(owner, "one", ["read", "browser"], [], 1);
  assert.equal(
    (await auth.checkCrew(caller, "agents.update", target)).state,
    "allowed",
  );
  assert.equal(
    (await auth.checkCrew(caller, "groups.assign", target)).state,
    "denied",
  );
  assert.equal(await auth.canDiscoverBrowser(caller), true);
  for (const patch of [{ projectId: "other" }, { sessionId: "stale" }])
    assert.equal(
      (await auth.checkCrew({ ...caller, ...patch }, "agents.read", target))
        .state,
      "denied",
    );
  assert.equal(
    (
      await auth.checkCrew(caller, "agents.read", {
        type: "agent",
        agentId: "foreign",
      })
    ).state,
    "denied",
  );
  await auth.setAssignments(owner, "one", ["browser"], [], 2);
  assert.equal(
    (await auth.checkCrew(caller, "agents.read", target)).state,
    "denied",
  );
  assert.equal(
    (await auth.checkCrew(caller, "agents.update", target)).state,
    "allowed",
  );
  await auth.setAssignments(owner, "one", [], [], 3);
  assert.equal(await auth.canDiscoverBrowser(caller), false);
  const edited = { ...group("read", []), revision: 1 };
  await auth.saveGroup(owner, edited, 1);
  await assert.rejects(auth.saveGroup(owner, edited, 1), /revision|changed/i);
  await auth.setAssignments(owner, "one", ["read"], [], 4);
  await store.close();
  store = await AccessStore.open(directory, "fixture", "owner");
  auth = makeAuth();
  assert.equal(
    (await auth.checkCrew(caller, "agents.read", target)).state,
    "denied",
  );
  await auth.saveConnection(
    owner,
    {
      id: "service",
      projectId: "fixture",
      name: "Fixture service",
      service: "fixture",
      revision: 1,
      identity: {
        displayName: "Synthetic account",
        externalAccountId: null,
        emailAddress: null,
      },
      transport: { type: "mcp", serverConfigRef: "fixture-config" },
      authentication: { method: "none" },
      observedState: "connected",
      lastVerifiedAt: null,
    },
    null,
  );
  await auth.saveGroup(
    owner,
    {
      ...group("service-group", []),
      grants: {
        crew: [],
        services: [{ connectionId: "service", capabilities: ["read"] }],
        environmentPolicyIds: [],
      },
    },
    null,
  );
  const serviceCaller = {
    projectId: "fixture",
    agentId: "two",
    sessionId: "session-two",
  };
  const operation = (id) => ({
    caller: serviceCaller,
    jobId: null,
    operation: {
      invocationId: id,
      connectionId: "service",
      operation: "read",
      arguments: {},
      argumentsFingerprint: "a".repeat(64),
    },
  });
  await auth.setAssignments(owner, "two", ["service-group"], [], null);
  assert.equal(
    (await auth.authorizeAndReserve(operation("unassigned"))).state,
    "denied",
  );
  await auth.setAssignments(owner, "two", ["service-group"], ["service"], 1);
  assert.equal(
    (await auth.authorizeAndReserve(operation("assigned"))).state,
    "allowed",
  );
  await auth.setAssignments(owner, "two", [], ["service"], 2);
  assert.equal(
    (await auth.authorizeAndReserve(operation("revoked"))).state,
    "approval_required",
  );
  await store.close();
  const file = join(directory, "access.json");
  const legacy = JSON.parse(await readFile(file, "utf8"));
  legacy.version = 1;
  legacy.groups[0].grants.crew = [
    { action: "agents.read", scope: { type: "self" } },
    { action: "agents.update", scope: { type: "agents", agentIds: ["two"] } },
    { action: "history.read", scope: { type: "agents", agentIds: [] } },
  ];
  legacy.groups[1].grants.crew = [
    { action: "browser.control", scope: { type: "project" } },
  ];
  const originalAudit = structuredClone(legacy.audit);
  await writeFile(file, JSON.stringify(legacy), { mode: 0o600 });
  await assert.rejects(AccessStore.open(directory, "foreign", "owner"));
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), legacy);
  // Simulate interruption after a complete recovery snapshot, before journal commit.
  const backup = join(directory, "access-v1-before-group-capabilities.json");
  await writeFile(backup, JSON.stringify(legacy), { mode: 0o600 });
  store = await AccessStore.open(directory, "fixture", "owner");
  auth = makeAuth();
  const migrated = JSON.parse(await readFile(file, "utf8"));
  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.groups[0].grants.crew, [
    { action: "agents.read" },
    { action: "agents.update" },
    { action: "history.read" },
  ]);
  assert.deepEqual(migrated.assignments, legacy.assignments);
  assert.deepEqual(
    migrated.audit.slice(0, originalAudit.length),
    originalAudit,
  );
  assert.equal(migrated.groups[0].revision, legacy.groups[0].revision + 1);
  assert.equal(
    (await auth.checkCrew(caller, "agents.read", target)).state,
    "allowed",
  );
  assert.equal(
    (await auth.checkCrew(caller, "history.read", target)).state,
    "allowed",
  );
  assert.deepEqual(JSON.parse(await readFile(backup, "utf8")), legacy);
  await store.close();
  store = await AccessStore.open(directory, "fixture", "owner");
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), migrated);
  console.log(
    "Group capabilities: create/edit/save/reload, additive membership/removal, owner/project/session boundaries, browser discovery, strict writes, scoped v1 conversion, interrupted conversion retry and preserved history pass.",
  );
} finally {
  await store?.close();
  await rm(dir, { recursive: true, force: true });
}
