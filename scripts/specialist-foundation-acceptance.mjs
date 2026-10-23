// Bounded real stores/foundation/resource tools. No installed profile/model/microphone.
import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FoundationStore } from "../runtime/agents/store.mjs";
import { AgentFoundation } from "../runtime/agents/foundation.mjs";
import {
  ProjectResourceCatalogue,
  projectResources,
} from "../runtime/resources/catalogue.mjs";
import { createProjectResourceTools } from "../runtime/resources/tools.mjs";
const root = await realpath(
  await mkdtemp(join(tmpdir(), "crew-specialist-foundation-")),
);
const checks = [];
const pass = (name) => {
  checks.push(name);
  console.log("PASS", name);
};
const owner = { type: "owner", userId: "owner" };
let voiceBlocked = false,
  store,
  catalogue;
const forbidden = new Proxy(
  {},
  {
    get() {
      throw Error(
        "This check must never start a native runtime, audio or service operation.",
      );
    },
  },
);
try {
  store = await FoundationStore.open({
    directory: join(root, "foundation"),
    projectId: "project",
    ownerUserId: "owner",
  });
  const foundation = new AgentFoundation({
    store,
    runtime: forbidden,
    access: forbidden,
    broker: forbidden,
    authorization: { checkCrew: async () => ({ state: "allowed" }) },
    references: { validate: async () => true },
    configuration: async () => {
      throw Error("No model config needed for selection");
    },
    admissionUsesFoundationBarrier: true,
    privateInputBlocked: () => voiceBlocked,
  });
  const create = (name) =>
    foundation.records.createAgent(owner, {
      profile: {
        name,
        pictureRef: null,
        personality: name,
        systemPrompt: "Editable specialist guidance",
      },
      modelAccessId: "subscription",
      configRef: "runtime",
    });
  const pa = await create("Personal assistant"),
    engineer = await create("Engineer");
  await store.update((state) => {
    for (const agent of state.agents) {
      agent.runtime.threadId = "thread-" + agent.id;
      agent.runtime.session = {
        ...agent.runtime.session,
        sessionId: "session-" + agent.id,
        desiredState: "started",
        observedState: "started",
        startedAt: new Date().toISOString(),
      };
    }
  });
  await foundation.setPrimary(
    owner,
    pa.id,
    store.snapshot().projectSettings.revision,
  );
  const before = store.snapshot();
  await foundation.setContact(
    owner,
    engineer.id,
    before.projectSettings.revision,
  );
  const after = store.snapshot();
  assert.equal(after.projectSettings.primaryAgentId, pa.id);
  assert.equal(after.projectSettings.contactAgentId, engineer.id);
  assert.deepEqual(after.agents, before.agents);
  assert.deepEqual(after.messages, before.messages);
  pass(
    "Selecting a specialist preserves primary manager, agents and chats without runtime work",
  );
  await assert.rejects(
    foundation.setContact(
      {
        type: "agent",
        caller: {
          projectId: "project",
          agentId: pa.id,
          sessionId: "session-" + pa.id,
        },
      },
      pa.id,
      after.projectSettings.revision,
    ),
  );
  await assert.rejects(
    foundation.setContact(owner, pa.id, before.projectSettings.revision),
  );
  pass("Owner identity and selection revision enforced");
  voiceBlocked = true;
  await assert.rejects(
    foundation.setContact(owner, pa.id, after.projectSettings.revision),
    /Disconnect voice/,
  );
  voiceBlocked = false;
  pass("Active voice cannot silently move to another agent");
  const binding = (id) => ({
    projectId: "project",
    agentId: id,
    sessionId: "session-" + id,
    threadId: "thread-" + id,
  });
  assert.equal(foundation.publicVoiceAllowed(binding(engineer.id)), true);
  assert.equal(foundation.publicVoiceAllowed(binding(pa.id)), false);
  await foundation.recordPublicVoiceTurn(binding(engineer.id), {
    voiceSessionId: "voice",
    realtimeSessionId: "realtime",
    turnId: "turn",
    nativeItemId: "item",
  });
  pass("Voice promotion follows selected specialist rather than manager role");
  await store.close();
  store = await FoundationStore.open({
    directory: join(root, "foundation"),
    projectId: "project",
    ownerUserId: "owner",
  });
  assert.equal(store.snapshot().projectSettings.contactAgentId, engineer.id);
  assert.equal(
    store.snapshot().agents.find((a) => a.id === engineer.id).runtime.threadId,
    "thread-" + engineer.id,
  );
  pass("Contact and same native chat survive durable reopen");
  catalogue = await ProjectResourceCatalogue.open(
    join(root, "resources"),
    "project",
  );
  const marketing = await catalogue.save({
    expectedRevision: null,
    name: "Brand assets",
    category: "marketing",
    description: "Project shared assets",
    url: "https://example.com/brand",
  });
  await assert.rejects(
    catalogue.save({
      id: marketing.id,
      expectedRevision: 0,
      name: "stale",
      category: "other",
      description: "",
      url: "https://example.com",
    }),
    /changed/,
  );
  await assert.rejects(
    catalogue.save({
      expectedRevision: null,
      name: "credential",
      category: "other",
      description: "",
      url: "https://user:password@example.com",
    }),
  );
  pass("Reference saves are revision checked and reject embedded credentials");
  const all = {
    references: catalogue.list(),
    workspaces: [
      {
        policy: { id: "source" },
        workspace: { path: "/approved/source" },
        writable: true,
      },
    ],
    connections: [
      {
        id: "github",
        name: "Engineering identity",
        service: "github",
        identity: { displayName: "team" },
      },
    ],
  };
  let groups = [
    {
      grants: {
        crew: [{ action: "resources.read" }],
        resourceIds: [],
        environmentPolicyIds: ["source"],
        services: [{ connectionId: "github", capabilities: ["issues.read"] }],
      },
    },
  ];
  let allowed = true;
  const tools = createProjectResourceTools({
    run: async (_caller, op) => {
      if (!allowed) throw Error("revoked");
      return op();
    },
    list: async () => projectResources({ ...all, groups }),
    subscribe: () => () => {},
  });
  const caller = {
    projectId: "project",
    agentId: engineer.id,
    sessionId: "session-" + engineer.id,
  };
  const visible = await tools.call(caller, "project_resources", {});
  assert.deepEqual(
    visible.resources.map((r) => r.kind),
    ["workspace", "service"],
  );
  assert.equal(visible.resources[1].location, null);
  await assert.rejects(
    tools.call(caller, "project_resource_read", { resourceId: marketing.id }),
  );
  pass(
    "Group-projected resources reveal only approved folders/services/references without credentials",
  );
  groups[0].grants.resourceIds.push(marketing.id);
  assert.equal(
    (
      await tools.call(caller, "project_resource_read", {
        resourceId: marketing.id,
      })
    ).resource.name,
    "Brand assets",
  );
  groups = [];
  await assert.rejects(
    tools.call(caller, "project_resource_read", { resourceId: marketing.id }),
  );
  allowed = false;
  await assert.rejects(tools.call(caller, "project_resources", {}), /revoked/);
  pass("Resource membership and capability revocation apply to the next call");
  await catalogue.close();
  catalogue = await ProjectResourceCatalogue.open(
    join(root, "resources"),
    "project",
  );
  assert.equal(catalogue.list()[0].id, marketing.id);
  pass("Business resource catalogue persists without a repository requirement");
  await writeFile(
    join(root, "proof.json"),
    JSON.stringify(
      { passed: true, checks, physicalMic: false, nativeModel: false },
      null,
      2,
    ),
  );
  console.log("Evidence:", root);
} finally {
  await catalogue?.close();
  await store?.close();
}
