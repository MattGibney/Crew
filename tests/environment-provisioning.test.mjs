import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessStore } from "../src/access/state.mts";
import { ProjectAuthorizationService } from "../src/access/authorization.mts";
import { FoundationStore } from "../src/agents/store.mts";
import { AgentFoundation } from "../src/agents/foundation.mts";
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
    configure(provisioning) {
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
          permissionGroupIds: [id === "manager" ? "create" : "worker"],
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
    listPresets: () => f.access.listPresets(),
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
