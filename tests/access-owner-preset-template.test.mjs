import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessStore } from "../src/access/state.mts";
import { ProjectAuthorizationService } from "../src/access/authorization.mts";
import { createAccessOwnerApi } from "../src/access/owner-api.mts";
import { ProjectEnvironmentTemplateCatalogue } from "../src/agents/environment-templates.mts";

test("owner preset saves accept only a resolved exact environment pin and retain it durably", async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "crew-preset-template-")),
  );
  const owner = { type: "user", userId: "owner" };
  let store = await AccessStore.create(
    join(root, "access"),
    "project",
    "owner",
  );
  const catalogue = await ProjectEnvironmentTemplateCatalogue.open({
    directory: join(root, "templates"),
    projectId: "project",
    ownerUserId: "owner",
    protectedDirectories: [root],
    listAgents: async () => [],
    inspect: async () => {
      throw new Error("Preset save must not inspect or prepare");
    },
  });
  t.after(async () => {
    await store.close();
    await catalogue.close();
    await rm(root, { recursive: true, force: true });
  });
  const template = await catalogue.saveTemplate(owner, {
    id: null,
    expectedRevision: null,
    draft: {
      name: "Owner runtime",
      description: "",
      tools: [],
      executableDirectories: [],
      readableDirectories: [],
      environment: {},
      capabilities: {
        packageDownloads: false,
        network: false,
        localhostPorts: [],
      },
      preparation: {
        instructions: "Explicit preparation later",
        commands: [["never-run"]],
      },
    },
  });
  const identities = { getAgent: async () => null, getJob: async () => null };
  const authorization = new ProjectAuthorizationService(store, identities, {
    hasOperation: async () => false,
  });
  const options = {
    authorization,
    projectId: "project",
    ownerUserId: "owner",
    vault: new Proxy(
      {},
      {
        get() {
          throw new Error("Preset save must not read credentials");
        },
      },
    ),
    runtimeDefaults: { modelAccessId: "subscription", configRef: "runtime" },
    listAgents: async () => [],
    setupChoices: async () => [],
    catalogueSnapshot: () => {
      throw new Error("Preset save must not discover providers");
    },
  };
  const draft = {
    name: "Worker",
    enabled: true,
    profile: {
      name: "Worker",
      pictureRef: null,
      personality: "",
      systemPrompt: "",
    },
    skills: [],
    modelAccessId: "subscription",
    configRef: "runtime",
    permissionGroupIds: [],
    serviceConnectionIds: [],
  };
  const unsupported = createAccessOwnerApi(options, "owner");
  const old = await unsupported.command("savePreset", {
    id: null,
    expectedRevision: null,
    draft,
  });
  assert.equal(Object.hasOwn(old, "environmentTemplate"), false);
  const pin = { id: template.id, revision: template.revision };
  await assert.rejects(
    unsupported.command("savePreset", {
      id: null,
      expectedRevision: null,
      draft: { ...draft, environmentTemplate: pin },
    }),
    /Access change did not complete/,
  );
  const resolved = [];
  const api = createAccessOwnerApi(
    {
      ...options,
      resolveEnvironmentTemplate: async (value) => {
        resolved.push(structuredClone(value));
        catalogue.resolvePinned(value.id, value.revision);
      },
    },
    "owner",
  );
  for (const environmentTemplate of [
    { id: template.id, revision: 0 },
    { id: template.id, revision: null },
    { id: template.id, revision: 1, extra: true },
    { id: template.id, revision: 2 },
  ])
    await assert.rejects(
      api.command("savePreset", {
        id: null,
        expectedRevision: null,
        draft: { ...draft, environmentTemplate },
      }),
    );
  const saved = await api.command("savePreset", {
    id: old.id,
    expectedRevision: old.revision,
    draft: { ...draft, environmentTemplate: pin },
  });
  assert.deepEqual(saved.environmentTemplate, pin);
  assert.deepEqual(resolved.at(-1), pin);
  assert.equal(catalogue.assignment("worker"), null);
  await assert.rejects(
    api.command("savePreset", {
      id: old.id,
      expectedRevision: old.revision,
      draft: { ...draft, environmentTemplate: pin },
    }),
    /Access change did not complete/,
  );
  await store.close();
  store = await AccessStore.open(join(root, "access"), "project", "owner");
  const reopened = new ProjectAuthorizationService(store, identities, {
    hasOperation: async () => false,
  });
  assert.deepEqual((await reopened.listPresets())[0].environmentTemplate, pin);
});

test("template removal checks owner and revision, clears defaults and persists", async () => {
  const root = await mkdtemp(join(tmpdir(), "crew-remove-template-"));
  let store = await AccessStore.create(join(root, "access"), "project", "owner");
  const owner = { type: "user", userId: "owner" };
  const identities = { getAgent: async () => null, getJob: async () => null };
  const makeService = () => new ProjectAuthorizationService(store, identities, { hasOperation: async () => false });
  try {
    const service = makeService();
    const preset = await service.savePreset(owner, {
      id: "template", projectId: "project", revision: 1, name: "Worker", enabled: true,
      profile: { name: "Worker", pictureRef: null, personality: "", systemPrompt: "" },
      skills: [], modelAccessId: "subscription", configRef: "runtime", permissionGroupIds: [], serviceConnectionIds: [],
    }, null);
    const initial = await store.transaction((state) => state.creationDefaults.revision);
    const defaults = await service.setDefaultPreset(owner, preset.id, initial);
    await assert.rejects(service.removePreset({ type: "user", userId: "other" }, preset.id, preset.revision));
    await assert.rejects(service.removePreset(owner, preset.id, preset.revision + 1));
    assert.equal((await service.defaultPreset()).id, preset.id);
    await service.removePreset(owner, preset.id, preset.revision);
    const state = await store.transaction((state) => ({ presets: state.presets, defaults: state.creationDefaults, audit: state.audit }));
    assert.equal(state.presets.length, 0);
    assert.equal(state.defaults.presetId, null);
    assert.equal(state.defaults.revision, defaults.revision + 1);
    assert.equal(state.audit.at(-1).action, "preset.removed");
    await store.close();
    store = await AccessStore.open(join(root, "access"), "project", "owner");
    assert.equal(await makeService().defaultPreset(), null);
    assert.equal(await store.transaction((state) => state.presets.length), 0);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
