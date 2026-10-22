import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAgentSetup } from "../src/desktop/agent-setup.mts";
import { createFoundationAgentTools } from "../src/agents/tools.mts";

test("folder self-addressing preserves authenticated identity and target authorization", async () => {
  const caller = {
    projectId: "project",
    agentId: "current-agent",
    sessionId: "session",
  };
  const admitted = [];
  const foundation = {
    executionAllowed: () => true,
    records: {
      authorize: async (principal, action, target) => {
        assert.deepEqual(principal.caller, caller);
        if (target.agentId !== caller.agentId) throw new Error("Denied target");
        admitted.push({ action, target });
      },
    },
    store: { snapshot: () => ({ agents: [{ id: caller.agentId }] }) },
    environmentList: async (_principal, agentId) => ({ agentId }),
    environment: async (principal, input) => {
      await foundation.records.authorize(
        principal,
        `environments.${input.action}`,
        { type: "agent", agentId: input.agentId },
      );
      return input;
    },
  };
  const tools = createFoundationAgentTools(foundation, caller);
  assert.deepEqual(await tools.call("environments_read", { agentId: "self" }), {
    agentId: caller.agentId,
  });
  const result = await tools.call("environment_action", {
    agentId: "self",
    action: "attach",
    requestId: "one",
    arguments: { policyId: "approved" },
  });
  assert.equal(result.agentId, caller.agentId);
  assert.equal(admitted.length, 2);
  await assert.rejects(
    tools.call("environments_read", { agentId: "another-agent" }),
    /Denied target/,
  );
  await assert.rejects(
    tools.call("environment_action", {
      agentId: "another-agent",
      action: "attach",
      requestId: "two",
      arguments: { policyId: "approved" },
    }),
    /Denied target/,
  );
});

const copy = (value) => structuredClone(value);
async function fixture(t, failure = null) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "crew-setup-")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const directory = join(temp, "source");
  await mkdir(directory, { mode: 0o700 });
  const owner = {
    projectId: "project",
    ownerId: "owner",
    agents: [],
    provisioning: [],
    projectSettings: { revision: 1, primaryAgentId: null },
  };
  const access = {
    projectId: "project",
    groups: [],
    presets: [],
    assignments: [],
    connections: [],
    environmentPolicies: [],
    capabilities: [],
    crewCapabilities: [],
    runtimeDefaults: { modelAccessId: "model", configRef: "config" },
  };
  const environments = { workspaces: [], environments: [], operations: [] };
  let creates = 0;
  const application = {
    subscription: { status: async () => ({ state: "signed_in" }) },
    accessOwnerApi: {
      snapshot: async () => copy(access),
      command: async (name, args) => {
        if (name === "saveGroup" || name === "savePreset") {
          const rows = name === "saveGroup" ? access.groups : access.presets;
          assert.equal(args.expectedRevision, null);
          assert.ok(!rows.some((row) => row.id === args.id));
          const row = {
            id: args.id,
            projectId: "project",
            revision: 1,
            ...copy(args.draft),
            ...(name === "saveGroup" ? { updatedAt: "now" } : {}),
          };
          rows.push(row);
          return copy(row);
        }
        if (name === "saveAssignment") {
          const old = access.assignments.find(
            (row) => row.agentId === args.agentId,
          );
          assert.equal(old?.revision ?? null, args.expectedRevision);
          const row = {
            agentId: args.agentId,
            revision: (old?.revision ?? 0) + 1,
            permissionGroupIds: copy(args.permissionGroupIds),
            serviceConnectionIds: copy(args.serviceConnectionIds),
          };
          if (old) Object.assign(old, row);
          else access.assignments.push(row);
          return copy(row);
        }
        throw new Error(`Unexpected access command ${name}`);
      },
    },
    environmentOwnerApi: {
      snapshot: () => copy(environments),
      prepareFolderAccess: async (input) => {
        assert.equal(input.access, "none");
        return {
          canonicalPath: directory,
          access: "none",
          policy: null,
          requiredGrants: { crew: [], services: [], environmentPolicyIds: [] },
        };
      },
    },
    ownerApi: {
      snapshot: async () => copy(owner),
      command: async (name, args) => {
        if (name === "createAgent") {
          creates++;
          if (failure === "before")
            throw new Error("Reply lost with unknown dispatch");
          const preset = access.presets.find(
            (row) => row.id === args.input.presetId,
          );
          const agent = {
            id: `agent-${creates}`,
            archivedAt: null,
            profile: { ...copy(preset.profile), revision: 1 },
            reportsTo: args.input.reportsTo ?? {
              type: "user",
              userId: "owner",
            },
          };
          owner.agents.push(agent);
          owner.provisioning.push({
            agentId: agent.id,
            presetId: preset.id,
            presetRevision: preset.revision,
            creator: { type: "user", userId: "owner" },
            state: "ready",
            error: null,
          });
          access.assignments.push({
            agentId: agent.id,
            revision: 1,
            permissionGroupIds: copy(preset.permissionGroupIds),
            serviceConnectionIds: copy(preset.serviceConnectionIds),
          });
          if (failure === "after")
            throw new Error("Reply lost after successful creation");
          return copy(agent);
        }
        if (name === "setPrimaryAgent") {
          assert.equal(args.expectedRevision, owner.projectSettings.revision);
          owner.projectSettings = {
            revision: args.expectedRevision + 1,
            primaryAgentId: args.agentId,
          };
          return copy(owner.projectSettings);
        }
        throw new Error(`Unexpected owner command ${name}`);
      },
    },
  };
  const options = {
    directory: join(temp, "setup"),
    project: { id: "project", name: "Example", directory },
    application,
  };
  return {
    owner,
    access,
    application,
    options,
    open: () => openAgentSetup(options),
    creates: () => creates,
  };
}
async function reviewed(setup) {
  const initial = await setup.command("setup.new", {
    expectedRevision: null,
    mode: "create",
  });
  assert.equal(initial.draft.name, "Manager");
  assert.equal(initial.draft.makePrimary, true);
  assert.deepEqual(initial.draft.crewActions, []);
  return setup.command("setup.review", { expectedRevision: initial.revision });
}

test("lost create response recovers exact retained agent, makes primary, and never starts", async (t) => {
  const f = await fixture(t, "after"),
    setup = await f.open();
  const review = await reviewed(setup);
  const result = await setup.command("setup.complete", {
    expectedRevision: review.revision,
  });
  assert.equal(result.phase, "complete");
  assert.equal(result.error, null);
  assert.equal(result.result.agentId, "agent-1");
  assert.equal(result.result.primary, true);
  const reopened = await f.open();
  const replay = await reopened.command("setup.complete", {
    expectedRevision: result.revision,
  });
  assert.deepEqual(replay, result);
  assert.equal(f.creates(), 1);
});

test("unknown creation with no provenance stays blocked across reload without duplicate create", async (t) => {
  const f = await fixture(t, "before"),
    setup = await f.open();
  const review = await reviewed(setup);
  const failed = await setup.command("setup.complete", {
    expectedRevision: review.revision,
  });
  assert.equal(failed.phase, "applying");
  assert.match(failed.error, /provable single agent/);
  const reopened = await f.open();
  const retry = await reopened.command("setup.complete", {
    expectedRevision: failed.revision,
  });
  assert.match(retry.error, /prior creation outcome is uncertain/);
  assert.equal(f.creates(), 1);
  await assert.rejects(
    reopened.command("setup.new", {
      expectedRevision: retry.revision,
      mode: "create",
    }),
    /Reconcile/,
  );
});

test("folder preparation failure leaves choices editable before access mutations", async (t) => {
  const f = await fixture(t),
    setup = await f.open();
  const prepare = f.application.environmentOwnerApi.prepareFolderAccess;
  f.application.environmentOwnerApi.prepareFolderAccess = async () => {
    throw new Error("Untrusted provider failure details");
  };
  const review = await reviewed(setup);
  let state = await setup.command("setup.complete", {
    expectedRevision: review.revision,
  });
  assert.equal(state.phase, "draft");
  assert.equal(state.review, null);
  assert.match(state.error, /before access changes began/);
  assert.deepEqual(state.draft, review.draft);
  assert.equal(f.access.groups.length, 0);
  assert.equal(f.access.presets.length, 0);
  assert.equal(f.creates(), 0);
  const reopened = await f.open();
  state = await reopened.command("setup.save", {
    expectedRevision: state.revision,
    draft: { ...state.draft, name: "Corrected manager" },
  });
  f.application.environmentOwnerApi.prepareFolderAccess = prepare;
  state = await reopened.command("setup.review", {
    expectedRevision: state.revision,
  });
  state = await reopened.command("setup.complete", {
    expectedRevision: state.revision,
  });
  assert.equal(state.phase, "complete");
  assert.equal(f.creates(), 1);
});

test("lost group-save response stays locked and recovers the exact committed group", async (t) => {
  const f = await fixture(t),
    setup = await f.open();
  const command = f.application.accessOwnerApi.command;
  let lost = false;
  f.application.accessOwnerApi.command = async (name, args) => {
    const result = await command(name, args);
    if (name === "saveGroup" && !lost) {
      lost = true;
      throw new Error("Response lost after group commit");
    }
    return result;
  };
  const review = await reviewed(setup);
  let state = await setup.command("setup.complete", {
    expectedRevision: review.revision,
  });
  assert.equal(state.phase, "applying");
  assert.equal(f.access.groups.length, 1);
  assert.equal(f.creates(), 0);
  const reopened = await f.open();
  await assert.rejects(
    reopened.command("setup.save", {
      expectedRevision: state.revision,
      draft: { ...state.draft, name: "Unsafe replacement" },
    }),
    /reconcile/,
  );
  state = await reopened.command("setup.complete", {
    expectedRevision: state.revision,
  });
  assert.equal(state.phase, "complete");
  assert.equal(f.access.groups.length, 1);
  assert.equal(f.creates(), 1);
});

test("reviewed group revision conflict rejects before any creation", async (t) => {
  const f = await fixture(t),
    setup = await f.open();
  f.access.groups.push({
    id: "existing",
    projectId: "project",
    revision: 1,
    name: "Team",
    description: "",
    updatedAt: "now",
    grants: { crew: [], services: [], environmentPolicyIds: [] },
  });
  let state = await setup.command("setup.new", {
    expectedRevision: null,
    mode: "create",
  });
  state = await setup.command("setup.save", {
    expectedRevision: state.revision,
    draft: { ...state.draft, groupMode: "existing", groupIds: ["existing"] },
  });
  state = await setup.command("setup.review", {
    expectedRevision: state.revision,
  });
  f.access.groups[0].revision++;
  await assert.rejects(
    setup.command("setup.complete", { expectedRevision: state.revision }),
    /changed/,
  );
  assert.equal(f.creates(), 0);
});

test("repair retains current memberships and refuses a draft that would restore revocation", async (t) => {
  const f = await fixture(t),
    setup = await f.open();
  f.owner.agents.push({
    id: "retained",
    archivedAt: null,
    profile: {
      name: "Manager",
      systemPrompt: "Saved instructions",
      revision: 2,
    },
  });
  f.access.groups.push({
    id: "team",
    projectId: "project",
    revision: 1,
    name: "Team",
    description: "",
    updatedAt: "now",
    grants: { crew: [], services: [], environmentPolicyIds: [] },
  });
  f.access.connections.push({
    id: "service",
    name: "Chosen service",
    revision: 1,
  });
  f.access.assignments.push({
    agentId: "retained",
    revision: 4,
    permissionGroupIds: ["team"],
    serviceConnectionIds: ["service"],
  });
  let state = await setup.command("setup.new", {
    expectedRevision: null,
    mode: "repair",
    agentId: "retained",
  });
  assert.deepEqual(state.draft.groupIds, ["team"]);
  assert.deepEqual(state.draft.serviceConnectionIds, ["service"]);
  f.access.assignments[0] = {
    agentId: "retained",
    revision: 5,
    permissionGroupIds: [],
    serviceConnectionIds: [],
  };
  await assert.rejects(
    setup.command("setup.review", { expectedRevision: state.revision }),
    /access changed while/,
  );
  await assert.rejects(
    setup.command("setup.save", {
      expectedRevision: state.revision,
      draft: state.draft,
    }),
    /access changed while/,
  );
  state = await setup.command("setup.new", {
    expectedRevision: state.revision,
    mode: "repair",
    agentId: "retained",
  });
  assert.deepEqual(state.draft.groupIds, []);
  assert.deepEqual(state.draft.serviceConnectionIds, []);
  state = await setup.command("setup.review", {
    expectedRevision: state.revision,
  });
  state = await setup.command("setup.complete", {
    expectedRevision: state.revision,
  });
  assert.equal(state.phase, "complete");
  assert.equal(f.creates(), 0);
  assert.deepEqual(f.access.assignments[0].permissionGroupIds, []);
  assert.deepEqual(f.access.assignments[0].serviceConnectionIds, []);
});
