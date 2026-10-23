import test from "node:test";
import assert from "node:assert/strict";
import { AgentFoundation } from "../src/agents/foundation.mts";
import { createFoundationAgentTools } from "../src/agents/tools.mts";
import { normalizeArguments } from "../src/gateway/json.mts";

test("discoverable environment actions preserve the caller and existing permission authority", async () => {
  const caller = {
    projectId: "project",
    agentId: "agent",
    sessionId: "session",
  };
  const authorizations = [],
    invocations = [];
  const foundation = {
    executionAllowed: () => true,
    records: {
      authorize: async (principal, action, target) => {
        assert.deepEqual(principal, { type: "agent", caller });
        assert.deepEqual(target, { type: "agent", agentId: caller.agentId });
        authorizations.push(action);
      },
    },
    options: {
      environments: {
        invoke: async (input) => {
          invocations.push(input);
          return { operationId: "retained" };
        },
      },
    },
  };
  foundation.environment =
    AgentFoundation.prototype.environment.bind(foundation);
  const tools = createFoundationAgentTools(foundation, caller);
  const schema = tools
    .list()
    .find((tool) => tool.name === "environment_action").inputSchema;
  const call = (input) =>
    tools.call(
      "environment_action",
      normalizeArguments(schema, input).arguments,
    );
  const cases = [
    [
      "prepare",
      { environmentId: "attached", expectedAssignmentRevision: 3 },
      "environments.execute",
    ],
    [
      "start",
      { environmentId: "attached", command: ["node", "worker.mjs"] },
      "environments.execute",
    ],
    ["status", { operationId: "retained" }, "environments.read"],
    ["stop", { operationId: "retained" }, "environments.execute"],
  ];
  for (const [action, arguments_, permission] of cases) {
    const result = await call({
      agentId: "self",
      action,
      requestId: action,
      arguments: arguments_,
    });
    assert.equal(result.operationId, "retained");
    assert.equal(authorizations.at(-1), permission);
    assert.deepEqual(invocations.at(-1), {
      caller,
      agentId: caller.agentId,
      action,
      requestId: action,
      arguments: arguments_,
    });
  }
  const before = invocations.length;
  for (const arguments_ of [
    {
      environmentId: "attached",
      expectedAssignmentRevision: 3,
      environment: { PATH: "/host" },
    },
    {
      environmentId: "attached",
      expectedAssignmentRevision: 3,
      executableDirectories: ["/host"],
    },
  ])
    assert.throws(() =>
      call({
        agentId: "self",
        action: "prepare",
        requestId: "invalid",
        arguments: arguments_,
      }),
    );
  assert.equal(invocations.length, before);
  foundation.records.authorize = async () => {
    throw new Error("Current group revoked");
  };
  await assert.rejects(
    tools.call("environment_action", {
      agentId: "self",
      action: "stop",
      requestId: "revoked",
      arguments: { operationId: "retained" },
    }),
    /Current group revoked/,
  );
  assert.equal(invocations.length, before);
});
