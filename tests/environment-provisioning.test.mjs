import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessStore } from "../src/access/state.mts";
import { ProjectAuthorizationService } from "../src/access/authorization.mts";
import { FoundationStore } from "../src/agents/store.mts";
import { AgentFoundation } from "../src/agents/foundation.mts";
import { createFoundationAgentTools } from "../src/agents/tools.mts";
import { ProjectEnvironmentTemplateCatalogue } from "../src/agents/environment-templates.mts";
import { withEnvironmentTemplateProvisioning } from "../src/agents/environment-provisioning.mts";

const owner = { type: "user", userId: "owner" };
const ownerPrincipal = { type: "owner", userId: "owner" };
const profile = {
  name: "Worker",
  pictureRef: null,
  personality: "",
  systemPrompt: "",
};
const templateDraft = {
  name: "Approved runtime",
  description: "",
  tools: [],
  executableDirectories: [],
  readableDirectories: [],
  environment: {},
  capabilities: { packageDownloads: false, network: false, localhostPorts: [] },
  preparation: {
    instructions: "Prepare explicitly later",
    commands: [["never-run"]],
  },
};

async function fixture(t) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "crew-environment-provisioning-")),
  );
  let foundationStore,
    accessStore,
    catalogue,
    authorization,
    foundation,
    wrapped;
  const forbidden = new Proxy(
    {},
    {
      get() {
        assert.fail(
          "Provisioning must not invoke native runtime, credentials or execution",
        );
      },
    },
  );
  const f = {
    get store() {
      return foundationStore;
    },
    get access() {
      return authorization;
    },
    get catalogue() {
      return catalogue;
    },
    get foundation() {
      return foundation;
    },
    get wrapped() {
      return wrapped;
    },
    async open() {
      foundationStore = await FoundationStore.open({
        directory: join(root, "foundation"),
        projectId: "project",
        ownerUserId: "owner",
      });
      accessStore = await AccessStore.open(
        join(root, "access"),
        "project",
        "owner",
      );
      authorization = new ProjectAuthorizationService(
        accessStore,
        {
          getAgent: async (id) =>
            foundationStore.snapshot().agents.find((row) => row.id === id) ??
            null,
          getJob: async () => null,
        },
        {
          hasOperation: async () => {
            assert.fail("No remote discovery during provisioning");
          },
        },
      );
      catalogue = await ProjectEnvironmentTemplateCatalogue.open({
        directory: join(root, "templates"),
        projectId: "project",
        ownerUserId: "owner",
        protectedDirectories: [root],
        listAgents: async () => foundationStore.snapshot().agents,
        inspect: async () => {
          assert.fail("No inspection or preparation during provisioning");
        },
      });
      wrapped = withEnvironmentTemplateProvisioning(
        authorization,
        catalogue,
        owner,
      );
      f.configure(wrapped);
    },
    configure(provisioning, overrides = {}) {
      foundation = new AgentFoundation({
        store: foundationStore,
        provisioning,
        authorization,
        runtime: forbidden,
        access: forbidden,
        broker: forbidden,
        references: {
          validate: async (kind, id, projectId) =>
            projectId === "project" &&
            ((kind === "modelAccess" && id === "subscription") ||
              (kind === "runtimeConfig" && id === "runtime")),
        },
        configuration: async () => {
          assert.fail("No runtime configuration during provisioning");
        },
        admissionUsesFoundationBarrier: true,
        ...overrides,
      });
    },
    async close() {
      await catalogue.close();
      await accessStore.close();
      await foundationStore.close();
    },
    async reopen() {
      await f.close();
      await f.open();
    },
    async preset(id, environmentTemplate) {
      return authorization.savePreset(
        owner,
        {
          id,
          projectId: "project",
          revision: 1,
          name: id,
          enabled: true,
          profile,
          skills: [],
          modelAccessId: "subscription",
          configRef: "runtime",
          permissionGroupIds:
            id === "manager" ? ["create", "worker"] : ["worker"],
          serviceConnectionIds: [],
          ...(environmentTemplate === undefined ? {} : { environmentTemplate }),
        },
        null,
      );
    },
    async child(preset) {
      return foundation.createFromPreset(f.principal, {
        presetId: preset.id,
        expectedPresetRevision: preset.revision,
      });
    },
    input(agentId, preset) {
      return {
        actor: { type: "agent", agentId: f.manager.id },
        agentId,
        presetId: preset.id,
        expectedPresetRevision: preset.revision,
      };
    },
  };
  accessStore = await AccessStore.create(
    join(root, "access"),
    "project",
    "owner",
  );
  await accessStore.close();
  await f.open();
  t.after(async () => {
    await f.close();
    await rm(root, { recursive: true, force: true });
  });
  for (const [id, actions] of [
    ["create", ["agents.create"]],
    ["worker", ["environments.read"]],
  ])
    await authorization.saveGroup(
      owner,
      {
        id,
        projectId: "project",
        name: id,
        description: "",
        revision: 1,
        updatedAt: new Date().toISOString(),
        grants: {
          crew: actions.map((action) => ({
            action,
          })),
          services: [],
          environmentPolicyIds: [],
        },
      },
      null,
    );
  const managerPreset = await f.preset("manager");
  f.manager = await foundation.createFromPreset(ownerPrincipal, {
    presetId: managerPreset.id,
    expectedPresetRevision: 1,
  });
  assert.equal(
    catalogue.assignment(f.manager.id),
    null,
    "legacy preset remains unassigned",
  );
  // A controlled already-started identity enables the actual manager permission
  // path; this fixture never calls native Start or supplies model credentials.
  await foundationStore.update((state) => {
    Object.assign(
      state.agents.find((row) => row.id === f.manager.id).runtime.session,
      {
        sessionId: "manager-session",
        desiredState: "started",
        observedState: "started",
      },
    );
  });
  f.principal = {
    type: "agent",
    caller: {
      projectId: "project",
      agentId: f.manager.id,
      sessionId: "manager-session",
    },
  };
  return f;
}

test("real manager creation pins an exact template without preparation and retries do not restore access", async (t) => {
  const f = await fixture(t);
  const template = await f.catalogue.saveTemplate(owner, {
    id: null,
    expectedRevision: null,
    draft: templateDraft,
  });
  const pin = { id: template.id, revision: template.revision };
  const preset = await f.preset("worker-pinned", pin);
  await f.catalogue.saveTemplate(owner, {
    id: template.id,
    expectedRevision: 1,
    draft: { ...templateDraft, name: "New version" },
  });
  const child = await f.child(preset);
  assert.deepEqual(child.reportsTo, { type: "agent", agentId: f.manager.id });
  assert.equal(
    f.store.snapshot().provisioning.find((row) => row.agentId === child.id)
      .state,
    "ready",
  );
  const assignment = f.catalogue.assignment(child.id);
  assert.equal(assignment.templateRevision, 1);
  assert.equal(assignment.revision, 1);
  assert.deepEqual(child.access.permissionGroupIds, ["worker"]);
  await f.access.setAssignments(owner, child.id, [], [], 1);
  await f.reopen();
  const results = await Promise.all([
    f.wrapped.applyPreset(f.input(child.id, preset)),
    f.wrapped.applyPreset(f.input(child.id, preset)),
  ]);
  assert.deepEqual(
    results.map((row) => row.permissionGroupIds),
    [[], []],
  );
  assert.deepEqual(
    f.catalogue.assignment(child.id),
    assignment,
    "same pin retry does not increment assignment",
  );
  assert.deepEqual(
    (await f.wrapped.accessFor(child.id)).permissionGroupIds,
    [],
  );
  assert.deepEqual(await f.wrapped.listPresets(), await f.access.listPresets());
  await f.catalogue.assign(owner, {
    agentId: child.id,
    expectedRevision: 1,
    templateId: template.id,
    templateRevision: 2,
  });
  await assert.rejects(
    f.wrapped.applyPreset(f.input(child.id, preset)),
    /preserve the owner's current choice/,
  );
  assert.equal(f.catalogue.assignment(child.id).templateRevision, 2);
  assert.equal(f.catalogue.assignment(child.id).revision, 2);
});

test("failed and response-lost provisioning recover durably without overwriting owner choices", async (t) => {
  const f = await fixture(t);
  const template = await f.catalogue.saveTemplate(owner, {
    id: null,
    expectedRevision: null,
    draft: templateDraft,
  });
  const preset = await f.preset("recoverable", {
    id: template.id,
    revision: 1,
  });
  const assign = f.catalogue.assignPreset.bind(f.catalogue);
  f.catalogue.assignPreset = async () => {
    throw new Error("Controlled metadata write failure");
  };
  await assert.rejects(f.child(preset), /retained with failed provisioning/);
  const failed = f.store
    .snapshot()
    .provisioning.find((row) => row.state === "failed");
  assert.equal(f.catalogue.assignment(failed.agentId), null);
  assert.deepEqual(
    (await f.access.assignment(failed.agentId)).permissionGroupIds,
    ["worker"],
  );
  await f.access.setAssignments(owner, failed.agentId, [], [], 1);
  f.catalogue.assignPreset = assign;
  await f.reopen();
  await f.foundation.retryProvisioning(ownerPrincipal, failed.agentId);
  assert.equal(f.catalogue.assignment(failed.agentId).revision, 1);
  assert.deepEqual(
    (await f.access.accessFor(failed.agentId)).permissionGroupIds,
    [],
  );
  assert.equal(
    f.store
      .snapshot()
      .provisioning.find((row) => row.agentId === failed.agentId).state,
    "ready",
  );

  const realAssign = f.catalogue.assignPreset.bind(f.catalogue);
  f.catalogue.assignPreset = async (...args) => {
    await realAssign(...args);
    throw new Error("Controlled lost response");
  };
  await assert.rejects(f.child(preset), /retained with failed provisioning/);
  const lost = f.store
    .snapshot()
    .provisioning.find((row) => row.state === "failed");
  await f.catalogue.assign(owner, {
    agentId: lost.agentId,
    expectedRevision: 1,
    templateId: null,
    templateRevision: null,
  });
  await f.reopen();
  await assert.rejects(
    f.foundation.retryProvisioning(ownerPrincipal, lost.agentId),
    /preserve the owner's current choice/,
  );
  assert.equal(f.catalogue.assignment(lost.agentId).templateId, null);
  assert.equal(f.catalogue.assignment(lost.agentId).revision, 2);
  assert.equal(
    f.store.snapshot().provisioning.find((row) => row.agentId === lost.agentId)
      .state,
    "failed",
  );
});

test("pin prevalidation and assignment CAS prevent partial or conflicting template selection", async (t) => {
  const f = await fixture(t);
  const template = await f.catalogue.saveTemplate(owner, {
    id: null,
    expectedRevision: null,
    draft: templateDraft,
  });
  const unavailable = await f.preset("unavailable", {
    id: template.id,
    revision: 999,
  });
  await assert.rejects(
    f.child(unavailable),
    /retained with failed provisioning/,
  );
  const first = f.store
    .snapshot()
    .provisioning.find((row) => row.state === "failed");
  assert.equal(
    await f.access.assignment(first.agentId),
    null,
    "missing exact pin fails before access write",
  );

  const preset = await f.preset("cas", { id: template.id, revision: 1 });
  const delegate = {
    listPresets: (actor) => f.access.listPresets(actor),
    accessFor: (id) => f.access.accessFor(id),
    async applyPreset(input) {
      const access = await f.access.applyPreset(input);
      await f.catalogue.assign(owner, {
        agentId: input.agentId,
        expectedRevision: null,
        templateId: null,
        templateRevision: null,
      });
      return access;
    },
  };
  f.configure(
    withEnvironmentTemplateProvisioning(delegate, f.catalogue, owner),
  );
  await assert.rejects(f.child(preset), /retained with failed provisioning/);
  const raced = f.store
    .snapshot()
    .provisioning.find((row) => row.presetId === preset.id);
  assert.equal(f.catalogue.assignment(raced.agentId).templateId, null);
  assert.equal(
    f.catalogue.assignment(raced.agentId).revision,
    1,
    "owner assignment wins missing-assignment CAS",
  );
  await assert.rejects(
    f.wrapped.applyPreset({
      ...f.input(raced.agentId, preset),
      expectedPresetRevision: 2,
    }),
    /preset changed/,
  );
});

test("delegation discovers only current subset presets, never passes creation power, while owners retain all choices", async (t) => {
  const f = await fixture(t);
  const worker = await f.preset("worker");
  const manager = (await f.access.listPresets()).find(
    (row) => row.id === "manager",
  );
  const outside = await f.access.saveGroup(
    owner,
    {
      id: "outside",
      projectId: "project",
      name: "outside",
      description: "",
      revision: 1,
      updatedAt: new Date().toISOString(),
      grants: {
        crew: [{ action: "history.read" }],
        services: [],
        environmentPolicyIds: [],
      },
    },
    null,
  );
  const specialist = await f.access.savePreset(
    owner,
    {
      ...worker,
      id: "specialist",
      name: "specialist",
      permissionGroupIds: [outside.id],
    },
    null,
  );
  const actor = { type: "agent", agentId: f.manager.id };
  const tools = createFoundationAgentTools(f.foundation, f.principal.caller);
  assert.deepEqual(
    (await tools.call("agent_creation_presets", {})).map((row) => row.id),
    [worker.id],
  );
  assert.deepEqual(
    (await f.foundation.creationPresets(f.principal)).map((row) => row.id),
    [worker.id],
  );
  assert.deepEqual(
    (await f.wrapped.listPresets(actor)).map((row) => row.id),
    [worker.id],
  );
  assert.deepEqual(
    (await f.foundation.creationPresets()).map((row) => row.id).sort(),
    [manager.id, specialist.id, worker.id].sort(),
  );
  const before = f.store.snapshot().agents.length;
  await assert.rejects(f.child(manager), /unavailable/);
  await assert.rejects(f.child(specialist), /unavailable/);
  assert.equal(
    f.store.snapshot().agents.length,
    before,
    "preflight avoids ineligible orphan records",
  );
  const child = await f.child(worker);
  assert.deepEqual(child.access.permissionGroupIds, ["worker"]);
  assert.deepEqual(child.reportsTo, actor);
  const ownerCreated = await f.foundation.createFromPreset(ownerPrincipal, {
    presetId: manager.id,
    expectedPresetRevision: manager.revision,
  });
  assert.deepEqual(ownerCreated.access.permissionGroupIds, [
    "create",
    "worker",
  ]);
});

test("access transaction rejects stale subset, revoked creation and newly creation-capable child groups", async (t) => {
  for (const change of ["subset", "creation", "group-grant"]) {
    const f = await fixture(t);
    const preset = await f.preset(`worker-${change}`);
    f.configure({
      listPresets: (actor) => f.wrapped.listPresets(actor),
      accessFor: (id) => f.wrapped.accessFor(id),
      async applyPreset(input) {
        if (change === "group-grant") {
          await f.access.saveGroup(
            owner,
            {
              id: "worker",
              projectId: "project",
              name: "worker",
              description: "",
              revision: 1,
              updatedAt: new Date().toISOString(),
              grants: {
                crew: [{ action: "agents.create" }],
                services: [],
                environmentPolicyIds: [],
              },
            },
            1,
          );
        } else {
          await f.access.setAssignments(
            owner,
            f.manager.id,
            change === "subset" ? ["create"] : ["worker"],
            [],
            1,
          );
        }
        return f.wrapped.applyPreset(input);
      },
    });
    await assert.rejects(f.child(preset), /retained with failed provisioning/);
    const failed = f.store
      .snapshot()
      .provisioning.find((row) => row.presetId === preset.id);
    assert.equal(failed.state, "failed");
    assert.equal(await f.access.assignment(failed.agentId), null, change);
    assert.equal(
      f.store.snapshot().agents.find((row) => row.id === failed.agentId).runtime
        .threadId,
      null,
    );
  }
});

test("direct access provisioning independently rejects escalation after stale discovery", async (t) => {
  const f = await fixture(t);
  const preset = await f.preset("worker");
  const unprovisioned = await f.foundation.records.createAgent(f.principal, {
    profile,
    modelAccessId: "subscription",
    configRef: "runtime",
  });
  await f.access.saveGroup(
    owner,
    {
      id: "worker",
      projectId: "project",
      name: "worker",
      description: "",
      revision: 1,
      updatedAt: new Date().toISOString(),
      grants: {
        crew: [{ action: "agents.create" }],
        services: [],
        environmentPolicyIds: [],
      },
    },
    1,
  );
  await assert.rejects(
    f.access.applyPreset(f.input(unprovisioned.id, preset)),
    /cannot grant agents.create/,
  );
  assert.equal(await f.access.assignment(unprovisioned.id), null);
});

test("retirement stops only current children and retains notes, native identity and resources", async (t) => {
  const f = await fixture(t);
  await f.access.saveGroup(
    owner,
    {
      id: "create",
      projectId: "project",
      name: "create",
      description: "",
      revision: 1,
      updatedAt: new Date().toISOString(),
      grants: {
        crew: [{ action: "agents.create" }, { action: "agents.archive" }],
        services: [],
        environmentPolicyIds: [],
      },
    },
    1,
  );
  const preset = await f.preset("worker");
  const child = await f.child(preset);
  const specialist = await f.foundation.createFromPreset(ownerPrincipal, {
    presetId: preset.id,
    expectedPresetRevision: preset.revision,
  });
  const stops = [];
  let acknowledge = false;
  f.configure(f.wrapped, {
    runtime: {
      async stop(binding) {
        stops.push(binding);
        return acknowledge
          ? {
              state: "acknowledged",
              value: { stoppedAt: new Date().toISOString() },
            }
          : {
              state: "failed",
              error: {
                code: "runtime_error",
                message: "Controlled stop rejection",
              },
            };
      },
    },
    access: { release: async () => {} },
    broker: {
      settlement: async () => ({
        inFlightInvocationIds: [],
        uncertainInvocationIds: [],
      }),
    },
  });
  await f.store.update((state) => {
    const current = state.agents.find((row) => row.id === child.id);
    current.runtime.threadId = "retained-native-thread";
    Object.assign(current.runtime.session, {
      sessionId: "child-session",
      desiredState: "started",
      observedState: "started",
      activeTurnId: "child-turn",
    });
    current.scratchpad.markdown = "Retained handover notes";
    current.resources = [
      {
        id: "workspace",
        kind: "worktree",
        location: "/retained/workspace",
        metadata: {},
      },
    ];
  });
  const retained = f.store.snapshot().agents.find((row) => row.id === child.id);
  const tools = createFoundationAgentTools(f.foundation, f.principal.caller);
  await f.foundation.records.updateProfile(ownerPrincipal, child.id, 1, {
    reportsTo: owner,
  });
  await assert.rejects(
    tools.call("agent_archive", { agentId: child.id }),
    /permission denied/,
  );
  await f.foundation.records.updateProfile(ownerPrincipal, child.id, 2, {
    reportsTo: { type: "agent", agentId: f.manager.id },
  });
  await assert.rejects(
    tools.call("agent_archive", { agentId: specialist.id }),
    /permission denied/,
  );
  assert.equal(stops.length, 0);
  await assert.rejects(
    f.foundation.records.archive(f.principal, child.id),
    /confirmed stopped/,
  );
  await assert.rejects(
    tools.call("agent_archive", { agentId: child.id }),
    /confirmed Stop/,
  );
  assert.equal(
    f.store.snapshot().agents.find((row) => row.id === child.id).archivedAt,
    null,
  );
  acknowledge = true;
  const retired = await tools.call("agent_archive", { agentId: child.id });
  assert.ok(retired.archivedAt);
  assert.equal(retired.runtime.session.observedState, "stopped");
  assert.equal(retired.runtime.session.activeTurnId, null);
  assert.equal(retired.runtime.threadId, retained.runtime.threadId);
  assert.deepEqual(retired.scratchpad, retained.scratchpad);
  assert.deepEqual(retired.resources, retained.resources);
  assert.ok(
    (await f.foundation.archive(ownerPrincipal, specialist.id)).archivedAt,
    "owner can retire an unrelated specialist",
  );
  await f.reopen();
  const persisted = f.store
    .snapshot()
    .agents.find((row) => row.id === child.id);
  assert.ok(persisted.archivedAt);
  assert.equal(persisted.runtime.threadId, retained.runtime.threadId);
  assert.deepEqual(persisted.resources, retained.resources);
});
