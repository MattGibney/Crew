import test from "node:test";
import assert from "node:assert/strict";
import { createAgentConfiguration } from "../src/application/agent-configuration.mts";
import { createVoiceOwnerCommands } from "../src/application/agent-voice.mts";

const binding = (agentId) => ({
  projectId: "project",
  agentId,
  sessionId: "session",
  threadId: "retained-chat",
});
function fixture() {
  const state = {
    projectId: "project",
    projectSettings: { primaryAgentId: "first" },
    agents: [
      {
        id: "first",
        archivedAt: null,
        profile: { revision: 1, name: "First" },
        skills: [],
        runtime: {
          threadId: "first-chat",
          session: { observedState: "stopped" },
        },
      },
      {
        id: "second",
        archivedAt: null,
        profile: { revision: 4, name: "Second", voice: "ember" },
        skills: [],
        runtime: {
          threadId: "second-chat",
          session: { observedState: "stopped" },
        },
      },
    ],
  };
  const saves = [];
  const application = {
    foundation: { store: { snapshot: () => structuredClone(state) } },
    setupDefaults: { modelAccessId: "model", configRef: "runtime" },
    runtime: {
      listRealtimeVoices: async () => {
        throw new Error("No session may be started");
      },
    },
    ownerApi: {
      command: async (name, args) => {
        assert.equal(name, "saveProfile");
        const agent = state.agents.find((row) => row.id === args.agentId);
        assert.equal(args.input.expectedRevision, agent.profile.revision);
        saves.push(args);
        Object.assign(agent.profile, args.input.profile, {
          revision: agent.profile.revision + 1,
        });
      },
    },
  };
  return {
    state,
    saves,
    application,
    configuration: createAgentConfiguration(application),
  };
}

test("legacy voice moves only to the existing primary and role changes read the chosen agent", async () => {
  const f = fixture();
  let retired = 0;
  await f.configuration.migrateLegacyVoice("cedar", async () => {
    retired++;
  });
  assert.equal(retired, 1);
  assert.equal(f.saves.length, 1);
  assert.equal(f.saves[0].agentId, "first");
  assert.equal(f.configuration.selectedVoice(binding("first")), "cedar");
  f.state.projectSettings.primaryAgentId = "second";
  assert.equal(f.configuration.selectedVoice(binding("second")), "ember");
  assert.equal(f.configuration.selectedVoice(binding("first")), "cedar");
  assert.equal(
    f.configuration.selectedVoice({ ...binding("second"), projectId: "other" }),
    null,
  );
  assert.deepEqual(
    f.state.agents.map((agent) => agent.runtime.threadId),
    ["first-chat", "second-chat"],
  );
  const options = await f.configuration.options();
  assert.equal(options.voices.state, "unavailable");
  assert.deepEqual(options.voices.values, []);
});

test("explicit native default wins and a failed migration never retires the legacy choice", async () => {
  const f = fixture();
  f.state.agents[0].profile.voice = null;
  let retired = 0;
  await f.configuration.migrateLegacyVoice("cedar", async () => {
    retired++;
  });
  assert.equal(f.saves.length, 0);
  assert.equal(retired, 1);
  delete f.state.agents[0].profile.voice;
  f.application.ownerApi.command = async () => {
    throw new Error("Save failed");
  };
  await assert.rejects(
    f.configuration.migrateLegacyVoice("cedar", async () => {
      retired++;
    }),
    /Save failed/,
  );
  assert.equal(retired, 1);
});

test("voice start cannot replace the exact agent's saved voice with a stale UI selection", async () => {
  const f = fixture();
  let starts = 0;
  const voice = {
    listVoices: async () => ({
      voices: [{ id: "ember", name: "Ember" }],
      defaultVoice: "ember",
      selectedVoice: null,
    }),
    start: async (input) => {
      starts++;
      return input;
    },
  };
  const command = createVoiceOwnerCommands(
    voice,
    f.configuration.selectedVoice,
  );
  const catalog = await command("voice.list", { binding: binding("second") });
  assert.equal(catalog.selectedVoice, "ember");
  await assert.rejects(
    command("voice.start", {
      binding: binding("second"),
      callId: "call",
      sdp: "offer",
      voice: "cedar",
    }),
    /saved voice changed/,
  );
  assert.equal(starts, 0);
  const result = await command("voice.start", {
    binding: binding("second"),
    callId: "call",
    sdp: "offer",
    voice: "ember",
  });
  assert.equal(result.binding.agentId, "second");
  assert.equal(result.voice, "ember");
  assert.equal(starts, 1);
});
