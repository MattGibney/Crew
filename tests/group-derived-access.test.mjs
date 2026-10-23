import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessStore } from "../src/access/state.mts";
import { migrateLegacyAgentSkills } from "../src/access/group-access.mts";
import { ProjectAuthorizationService } from "../src/access/authorization.mts";
import { EncryptedCredentialVault } from "../src/access/vault.mts";
import { OwnerConnectionSetupService } from "../src/access/connection-setup.mts";
import { createSupportedGatewayRegistry } from "../src/gateway/registry.mts";
import { GatewayOwnerConnectionVerifier } from "../src/gateway/owner-verification.mts";
import {
  TrustedServiceExecutor,
  capabilityId,
} from "../src/gateway/executor.mts";
import { createGateway } from "../src/gateway/compose.mts";
import { gmailTools } from "../src/gateway/gmail.mts";
import { normalizeArguments } from "../src/gateway/json.mts";
import { createProjectSkillAgentTools } from "../src/skills/tools.mts";
const owner = { type: "user", userId: "owner" };
const agent = (id, skills = []) => ({
  id,
  projectId: "project",
  archivedAt: null,
  profile: { name: id },
  skills,
  runtime: {
    session: {
      sessionId: `session-${id}`,
      observedState: "started",
      desiredState: "started",
    },
  },
});
const caller = (id) => ({
  projectId: "project",
  agentId: id,
  sessionId: `session-${id}`,
});
const group = (id, grants = {}) => ({
  id,
  projectId: "project",
  revision: 1,
  name: id,
  description: "",
  updatedAt: new Date().toISOString(),
  grants: { crew: [], services: [], environmentPolicyIds: [], ...grants },
});
const connection = {
  id: "mail",
  projectId: "project",
  name: "Mail",
  service: "gmail",
  revision: 1,
  identity: {
    displayName: "Fixture mailbox",
    emailAddress: "fixture@example.com",
    externalAccountId: "fixture@example.com",
  },
  transport: { type: "mcp", serverConfigRef: "crew.gmail.v1" },
  authentication: { method: "token", credentialRef: "fixture-reference" },
  observedState: "connected",
  lastVerifiedAt: null,
};

test("legacy service intersection and skills migrate once, retaining recovery snapshot and exact revocation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "crew-group-migrate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const location = join(dir, "access");
  let store = await AccessStore.create(location, "project", "owner");
  await store.close();
  const old = JSON.parse(await readFile(join(location, "access.json"), "utf8"));
  delete old.groupAccessVersion;
  old.groups = [
    group("team", {
      services: [{ connectionId: "mail", capabilities: ["read"] }],
    }),
  ];
  old.connections = [connection];
  old.assignments = [
    {
      agentId: "a",
      revision: 1,
      permissionGroupIds: ["team"],
      serviceConnectionIds: ["mail"],
    },
    {
      agentId: "b",
      revision: 1,
      permissionGroupIds: ["team"],
      serviceConnectionIds: [],
    },
  ];
  old.presets = [
    {
      id: "preset",
      projectId: "project",
      revision: 1,
      name: "Restricted preset",
      enabled: true,
      profile: {
        name: "Agent",
        pictureRef: null,
        personality: "",
        systemPrompt: "",
      },
      skills: [],
      permissionGroupIds: ["team"],
      serviceConnectionIds: [],
      modelAccessId: "subscription",
      configRef: "config",
    },
  ];
  await writeFile(join(location, "access.json"), JSON.stringify(old));
  store = await AccessStore.open(location, "project", "owner");
  const agents = [
    agent("a", [{ skillId: "marketing", enabled: true }]),
    agent("b"),
    agent("unassigned", [{ skillId: "legacy", enabled: true }]),
  ];
  await store.transaction((state) => migrateLegacyAgentSkills(state, agents));
  const auth = new ProjectAuthorizationService(
    store,
    {
      getAgent: async (id) => agents.find((row) => row.id === id),
      getJob: async () => null,
    },
    { hasOperation: async () => true, hasSkill: async () => true },
  );
  assert.deepEqual((await auth.accessFor("a")).serviceConnectionIds, ["mail"]);
  assert.deepEqual((await auth.accessFor("b")).serviceConnectionIds, []);
  assert.deepEqual(await auth.skillsFor("a"), [
    { skillId: "marketing", enabled: true },
  ]);
  assert.deepEqual(await auth.skillsFor("unassigned"), [
    { skillId: "legacy", enabled: true },
  ]);
  const snapshot = await auth.snapshot(owner);
  assert.deepEqual(
    snapshot.groups.find((row) => row.id === "team").grants.services,
    [],
  );
  assert.deepEqual(snapshot.presets[0].serviceConnectionIds, []);
  assert.deepEqual(
    JSON.parse(
      await readFile(
        join(location, "access-before-group-derived-access.json"),
        "utf8",
      ),
    ),
    old,
  );
  await store.close();
  store = await AccessStore.open(location, "project", "owner");
  await store.transaction((state) => migrateLegacyAgentSkills(state, agents));
  assert.equal(
    (await store.transaction((state) => state.groups)).length,
    snapshot.groups.length,
  );
  await store.close();
});

test("owner Gmail connection, vaulted refresh, group tools, broker draft/send and revocation use real backend with fixture provider", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "crew-group-mail-"));
  const agents = [agent("pa"), agent("developer")];
  const store = await AccessStore.create(
    join(dir, "access"),
    "project",
    "owner",
  );
  t.after(() => store.close());
  // Synthetic bytes only. The production host injects Electron safeStorage.
  const vault = new EncryptedCredentialVault({
    directory: join(dir, "vault"),
    projectId: "project",
    ownerUserId: "owner",
    encryption: {
      isAvailable: () => true,
      encrypt: async (value) => Uint8Array.from(value, (byte) => byte ^ 0x52),
      decrypt: async (value) => Uint8Array.from(value, (byte) => byte ^ 0x52),
    },
  });
  const registry = createSupportedGatewayRegistry();
  const requests = [];
  let mailbox = "fixture@example.com",
    refreshCount = 0;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(input);
    assert.ok(
      ["gmail.googleapis.com", "oauth2.googleapis.com"].includes(url.hostname),
    );
    requests.push({ path: url.pathname, method: init.method });
    if (url.hostname === "oauth2.googleapis.com") {
      assert.equal(init.method, "POST");
      assert.equal(init.body.get("client_id"), "fixture-client");
      assert.equal(init.body.get("refresh_token"), "fixture-refresh");
      assert.equal(init.body.has("resource"), false);
      refreshCount++;
      return Response.json({
        access_token: "fixture-refreshed",
        expires_in: 3600,
        token_type: "Bearer",
      });
    }
    assert.match(init.headers.Authorization, /^Bearer fixture-/);
    if (url.pathname.endsWith("/profile"))
      return Response.json({ emailAddress: mailbox, messagesTotal: 2 });
    if (
      url.pathname.endsWith("/messages/send") ||
      url.pathname.endsWith("/drafts")
    ) {
      const body = JSON.parse(init.body),
        raw = body.raw ?? body.message.raw;
      const mime = Buffer.from(raw, "base64url").toString("utf8");
      assert.match(mime, /To: recipient@example.com\r\n/);
      assert.match(mime, /Content-Type: text\/plain/);
      return Response.json({
        id: "fixture-result",
        message: { id: "fixture-message" },
      });
    }
    return Response.json({
      messages: [{ id: "fixture-message", threadId: "fixture-thread" }],
    });
  });
  let gateway;
  const auth = new ProjectAuthorizationService(
    store,
    {
      getAgent: async (id) => agents.find((row) => row.id === id),
      getJob: async () => null,
    },
    {
      hasOperation: async (id, operation) =>
        gateway?.catalogue.hasOperation(id, operation) ?? false,
      hasSkill: async (id) => ["marketing", "coding"].includes(id),
    },
  );
  gateway = await createGateway({
    privateDirectory: join(dir, "gateway"),
    authorization: auth,
    vault,
    resolveConfiguration: registry.resolve,
    connections: {
      get: (id) => auth.getConnection(id),
      listAssigned: (bound) => auth.listAssignedConnections(bound),
      allowedOperations: (bound, id) => auth.allowedOperations(bound, id),
    },
    validateCaller: async () => true,
    admission: {
      run: async (_invocation, permit, dispatch) =>
        (await auth.redeem(permit)).state === "allowed"
          ? { state: "admitted", result: await dispatch() }
          : { state: "denied" },
    },
  });
  let setup;
  const drafts = {
    get: (id) => setup.candidate(id),
    listAssigned: async () => [],
  };
  const executor = new TrustedServiceExecutor({
    authorization: auth,
    vault,
    connections: drafts,
    resolveConfiguration: registry.resolve,
    privateDirectory: join(dir, "verify"),
    admission: { run: async () => ({ state: "denied" }) },
    canDispatch: async () => false,
  });
  const verifier = new GatewayOwnerConnectionVerifier({
    vault,
    connections: drafts,
    registry,
    prepareCredential: (record, revision) =>
      executor.prepareOwnerCredential(record, revision),
    discoverCapabilities: (record, options) =>
      executor.discoverCapabilities(record, options),
  });
  let loseVerificationResult = false;
  setup = new OwnerConnectionSetupService({
    store,
    vault,
    projectId: "project",
    ownerUserId: "owner",
    setupChoices: async () => registry.setupChoices(),
    listAgents: async () => agents,
    verify: async (record, revision, signal) => {
      const result = await verifier.verify(
        record,
        { credentialRef: record.authentication.credentialRef, revision },
        { signal },
      );
      if (loseVerificationResult)
        throw new Error(
          "Synthetic lost owner-verification result after refresh.",
        );
      return result;
    },
  });
  t.after(async () => {
    await setup.close();
    await rm(dir, { recursive: true, force: true });
  });
  const bundle = JSON.stringify({
    access_token: "fixture-access",
    expires_at: 1,
    refresh_token: "fixture-refresh",
    client_id: "fixture-client",
    client_secret: "fixture-secret",
  });
  const verificationInput = {
    requestId: "owner-request",
    setupChoiceId: "gmail",
    name: "PA mailbox",
    accountKind: "dedicated",
    credential: bundle,
    connectionId: null,
    expectedRevision: null,
  };
  loseVerificationResult = true;
  assert.equal((await setup.verify(verificationInput)).state, "failed");
  assert.equal(refreshCount, 1);
  // The refresh committed, but setup still has revision 1 after the lost result.
  assert.equal(
    await store.transaction(
      (state) => state.connectionSetups[0].credentialRevision,
    ),
    1,
  );
  loseVerificationResult = false;
  const verified = await setup.verify(verificationInput);
  assert.equal(refreshCount, 1); // Exact completed refresh receipt; no second refresh.
  assert.equal(
    await store.transaction(
      (state) => state.connectionSetups[0].credentialRevision,
    ),
    2,
  );
  assert.equal(verified.state, "verified");
  assert.equal(verified.identity.emailAddress, "fixture@example.com");
  assert.equal(verified.capabilities.length, 6);
  await setup.save({
    requestId: verified.requestId,
    verificationId: verified.verificationId,
    groupSelections: [],
    agentSelections: [],
  });
  assert.deepEqual(await auth.listAssignedConnections(caller("pa")), []); // Saving a connection grants nothing.
  const saved = await auth.getConnection(verified.connectionId);
  gateway.catalogue.rememberVerified(saved, verified.capabilities);
  const capability = (name) => capabilityId(saved.id, name);
  const readGroup = await auth.saveGroup(
    owner,
    group("readers", {
      skillIds: ["marketing"],
      services: [
        {
          connectionId: saved.id,
          capabilities: [capability("gmail_messages_list")],
        },
      ],
    }),
    null,
  );
  const writeGroup = await auth.saveGroup(
    owner,
    group("mail-writers", {
      services: [
        {
          connectionId: saved.id,
          capabilities: [
            capability("gmail_draft_create"),
            capability("gmail_message_send"),
          ],
        },
      ],
    }),
    null,
  );
  await auth.saveGroup(
    owner,
    group("developers", { skillIds: ["coding"] }),
    null,
  );
  await auth.setAssignments(owner, "pa", [readGroup.id], [], null);
  await auth.setAssignments(
    owner,
    "developer",
    ["developers"],
    [saved.id],
    null,
  ); // Old list is not authority.
  assert.deepEqual((await auth.accessFor("pa")).serviceConnectionIds, [
    saved.id,
  ]);
  assert.deepEqual(
    (await auth.accessFor("developer")).serviceConnectionIds,
    [],
  );
  assert.deepEqual(
    (await gateway.broker.listCapabilities(caller("pa"))).map(
      (row) => row.upstreamName,
    ),
    ["gmail_messages_list"],
  );
  assert.deepEqual(
    await gateway.broker.listCapabilities(caller("developer")),
    [],
  );
  const result = await gateway.broker.invokeTool(
    caller("pa"),
    "search",
    capability("gmail_messages_list"),
    { query: "is:unread" },
  );
  assert.equal(result.state, "succeeded");
  assert.equal(
    (
      await gateway.broker.invokeTool(
        caller("pa"),
        "blocked-send",
        capability("gmail_message_send"),
        {
          to: "recipient@example.com",
          subject: "Fixture",
          body: "Fixture only",
        },
      )
    ).state,
    "denied",
  );
  let assignment = await auth.assignment("pa");
  await auth.setAssignments(
    owner,
    "pa",
    [readGroup.id, writeGroup.id],
    [],
    assignment.revision,
  );
  for (const name of ["gmail_draft_create", "gmail_message_send"])
    assert.equal(
      (
        await gateway.broker.invokeTool(caller("pa"), name, capability(name), {
          to: "recipient@example.com",
          subject: "Fixture",
          body: "Fixture only",
        })
      ).state,
      "succeeded",
    );
  assert.equal(
    requests.filter((row) => row.path.endsWith("/messages/send")).length,
    1,
  );
  // Refresh is via the owner's explicit OAuth bundle and canonical vault replacement.
  const metadata = await vault.metadataForReference(
    saved.authentication.credentialRef,
  );
  await vault.withReplacement(
    saved.id,
    Buffer.from(
      JSON.stringify({
        access_token: "fixture-expired",
        expires_at: 1,
        refresh_token: "fixture-refresh",
        client_id: "fixture-client",
        client_secret: "fixture-secret",
      }),
    ),
    (handle) => vault.replace(saved.id, metadata.revision, handle),
  );
  assert.equal(
    (
      await gateway.broker.invokeTool(
        caller("pa"),
        "search-after-refresh",
        capability("gmail_messages_list"),
        {},
      )
    ).state,
    "succeeded",
  );
  assert.equal(refreshCount, 2);
  const normalized = normalizeArguments(
    gmailTools.find((tool) => tool.name === "gmail_message_send").inputSchema,
    { to: "recipient@example.com", subject: "Fixture", body: "Fixture only" },
  );
  const reserved = await auth.authorizeAndReserve({
    caller: caller("pa"),
    jobId: null,
    operation: {
      invocationId: "revocation-race",
      connectionId: saved.id,
      operation: capability("gmail_message_send"),
      ...normalized,
    },
  });
  assert.equal(reserved.state, "allowed");
  const attempt = await auth.beginAttempt(
    reserved.reservationId,
    "revocation-attempt",
  );
  assert.equal(attempt.state, "allowed");
  assignment = await auth.assignment("pa");
  await auth.setAssignments(owner, "pa", [], [saved.id], assignment.revision);
  assert.equal((await auth.redeem(attempt.permit)).state, "denied");
  assert.deepEqual(await gateway.broker.listCapabilities(caller("pa")), []);
  assert.equal(
    (
      await gateway.broker.invokeTool(
        caller("pa"),
        "revoked-send",
        capability("gmail_message_send"),
        {
          to: "recipient@example.com",
          subject: "Fixture",
          body: "Fixture only",
        },
      )
    ).state,
    "denied",
  );
  assert.equal(
    requests.filter((row) => row.path.endsWith("/messages/send")).length,
    1,
  );
  // Skill list/read are current membership-scoped, independent of native cached instructions.
  const skillTools = createProjectSkillAgentTools({
    caller: caller("developer"),
    store: {
      projectId: "project",
      list: async () => [{ id: "coding" }, { id: "marketing" }],
      read: async (id) => ({ id }),
    },
    visibleSkillIds: async () =>
      (await auth.skillsFor("developer")).map((row) => row.skillId),
    runAuthorized: async (_caller, _action, operation) => operation(),
  });
  assert.deepEqual(await skillTools.call("skills_list", {}), [
    { id: "coding" },
  ]);
  await assert.rejects(
    skillTools.call("skill_read", { skillId: "marketing" }),
    /No current group/,
  );
  // Replacing a token cannot silently change the saved mailbox account.
  assignment = await auth.assignment("pa");
  await auth.setAssignments(
    owner,
    "pa",
    [readGroup.id],
    [],
    assignment.revision,
  );
  mailbox = "different@example.com";
  await assert.rejects(
    gateway.broker.invokeTool(
      caller("pa"),
      "changed-account",
      capability("gmail_messages_list"),
      {},
    ),
    /Trusted credential operation failed/,
  );
  mailbox = "fixture@example.com";
  const readOnlyVerification = await setup.verify({
    requestId: "readonly-request",
    setupChoiceId: "gmail-readonly",
    name: "Owner mailbox",
    accountKind: "personal",
    credential: JSON.stringify({
      access_token: "fixture-near-expiry",
      expires_at: Date.now() + 5000,
      refresh_token: "fixture-refresh",
      client_id: "fixture-client",
      client_secret: "fixture-secret",
    }),
    connectionId: null,
    expectedRevision: null,
  });
  assert.equal(readOnlyVerification.state, "verified");
  assert.deepEqual(
    readOnlyVerification.capabilities.map((row) => row.upstreamName),
    ["gmail_profile", "gmail_messages_list", "gmail_message_read"],
  );
  assert.equal(readOnlyVerification.accountKind, "personal");
  assert.equal(refreshCount, 3); // Near-expiry setup refreshes before pinning too.
  // An external vault edit after a lost result is never adopted as this refresh.
  const conflictInput = {
    ...verificationInput,
    requestId: "external-edit",
    name: "Conflict fixture",
  };
  loseVerificationResult = true;
  assert.equal((await setup.verify(conflictInput)).state, "failed");
  assert.equal(refreshCount, 4);
  const conflicting = await store.transaction((state) =>
    state.connectionSetups.find(
      (row) => row.requestId === conflictInput.requestId,
    ),
  );
  const conflictMetadata = await vault.metadataForReference(
    conflicting.connection.authentication.credentialRef,
  );
  await vault.withReplacement(
    conflicting.connection.id,
    Buffer.from(
      JSON.stringify({
        access_token: "fixture-external-edit",
        expires_at: Date.now() + 3600000,
      }),
    ),
    (handle) =>
      vault.replace(
        conflicting.connection.id,
        conflictMetadata.revision,
        handle,
      ),
  );
  loseVerificationResult = false;
  assert.equal((await setup.verify(conflictInput)).state, "failed");
  assert.equal(refreshCount, 4);
  assert.equal(
    await store.transaction(
      (state) =>
        state.connectionSetups.find(
          (row) => row.requestId === conflictInput.requestId,
        ).credentialRevision,
    ),
    1,
  );
});
