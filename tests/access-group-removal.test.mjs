import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessStore } from "../src/access/state.mts";
import { ProjectAuthorizationService } from "../src/access/authorization.mts";

test("group deletion checks owner/revision and removes only its memberships durably", async () => {
  const root = await mkdtemp(join(tmpdir(), "crew-delete-group-"));
  let store = await AccessStore.create(
    join(root, "access"),
    "project",
    "owner",
  );
  const actor = { type: "user", userId: "owner" };
  const identities = { getAgent: async () => null, getJob: async () => null };
  const service = new ProjectAuthorizationService(store, identities, {
    hasOperation: async () => false,
    hasSkill: async () => true,
  });
  try {
    const groups = [];
    for (const id of ["engineering", "coordination"])
      groups.push(
        await service.saveGroup(
          actor,
          {
            id,
            projectId: "project",
            revision: 1,
            updatedAt: new Date().toISOString(),
            name: id,
            description: "",
            grants: {
              crew: [],
              services: [],
              environmentPolicyIds: [],
              skillIds: [id],
            },
          },
          null,
        ),
      );
    await store.transaction((state) => {
      state.assignments.push({
        agentId: "worker",
        permissionGroupIds: groups.map((group) => group.id),
        serviceConnectionIds: [],
        revision: 1,
      });
      state.assignments.push({
        agentId: "unrelated",
        permissionGroupIds: [groups[1].id],
        serviceConnectionIds: [],
        revision: 1,
      });
    });
    const preset = await service.savePreset(
      actor,
      {
        id: "worker-template",
        projectId: "project",
        revision: 1,
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
        permissionGroupIds: groups.map((group) => group.id),
        serviceConnectionIds: [],
      },
      null,
    );
    await assert.rejects(
      service.removeGroup(
        { type: "user", userId: "other" },
        groups[0].id,
        groups[0].revision,
      ),
    );
    await assert.rejects(
      service.removeGroup(actor, groups[0].id, groups[0].revision + 1),
    );
    assert.equal((await service.snapshot(actor)).groups.length, 2);
    await service.removeGroup(actor, groups[0].id, groups[0].revision);
    await store.close();
    store = await AccessStore.open(join(root, "access"), "project", "owner");
    const state = await store.transaction((state) => state);
    assert.deepEqual(
      state.groups.map((group) => group.id),
      ["coordination"],
    );
    assert.deepEqual(state.assignments[0].permissionGroupIds, ["coordination"]);
    assert.equal(state.assignments[0].revision, 2);
    assert.equal(state.assignments[1].revision, 1);
    assert.deepEqual(state.presets[0].permissionGroupIds, ["coordination"]);
    assert.deepEqual(state.presets[0].skills, [
      { skillId: "coordination", enabled: true },
    ]);
    assert.equal(state.presets[0].revision, preset.revision + 1);
    assert.equal(state.audit.at(-1).action, "group.removed");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
