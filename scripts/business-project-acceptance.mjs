// #127: actual production registry/composition, disposable business folders only.
// Native CLI version/config verification uses a fresh empty private home; no
// subscription reads/sign-in, agent Start, model turns, media or service I/O.
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const runtimeRoot = resolve(
  process.env.CREW_BUSINESS_RUNTIME_ROOT || "runtime",
);
const load = (file) => import(pathToFileURL(join(runtimeRoot, file)).href);
const { openUnifiedRegistry } = await load("desktop/unified-registry.mjs");
const { startUnifiedApplication } = await load(
  "agents/service-composition.mjs",
);
const binary =
  process.env.CREW_BUSINESS_CODEX_BINARY ||
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
const root = await realpath(
  await mkdtemp(join(tmpdir(), "crew-business-project-")),
);
const source = join(root, "Business workspace"),
  other = join(root, "Other business");
await mkdir(source);
await mkdir(other);
await writeFile(
  join(source, "business.txt"),
  "Disposable non-Git business workspace.\n",
);
const checks = [];
const pass = (name) => {
  checks.push(name);
  console.log("PASS", name);
};
const apps = new Set();
const openApp = async (registry, project) => {
  const application = await startUnifiedApplication({
    stateDirectory: registry.stateDirectory(project.id),
    projectId: project.id,
    projectName: project.name,
    ownerUserId: `local-owner:${project.id}`,
    nativeExecutable: await realpath(binary),
    vaultEncryption: {
      isAvailable: () => false,
      encrypt: async () => {
        throw Error("No credential material is used by this fixture.");
      },
      decrypt: async () => {
        throw Error("No credential material is used by this fixture.");
      },
    },
    skills: {
      list: async () => [],
      resolve: async () => {
        throw Error("No fixture skills.");
      },
    },
  });
  apps.add(application);
  return application;
};
const closeApp = async (application) => {
  await application.close();
  apps.delete(application);
};
try {
  const registry = await openUnifiedRegistry(join(root, "private desktop"));
  const project = await registry.create({
    name: "Business without a repository",
    directory: source,
  });
  const second = await registry.create({
    name: "Another business",
    directory: other,
  });
  await registry.select(project.id);
  assert.notEqual(project.id, second.id);
  assert.notEqual(
    registry.stateDirectory(project.id),
    registry.stateDirectory(second.id),
  );
  await symlink(source, join(root, "source-alias"));
  await assert.rejects(
    registry.create({
      name: "Duplicate",
      directory: join(root, "source-alias"),
    }),
    /already registered/,
  );
  await assert.rejects(
    registry.create({ name: "Overlap", directory: root }),
    /separate folders/,
  );
  pass(
    "Non-Git project registration preserves canonical identity and private state separation",
  );

  let application = await openApp(registry, project);
  const user = { type: "user", userId: `local-owner:${project.id}` };
  const empty = await application.ownerApi.snapshot();
  assert.equal(empty.projectId, project.id);
  assert.equal(empty.agents.length, 0);
  assert.equal(empty.serviceConnections.length, 0);
  pass("Production unified composition opens an empty non-Git project");

  await application.authorization.saveConnection(
    user,
    {
      id: "fixture-service",
      projectId: project.id,
      revision: 1,
      name: "Synthetic service metadata",
      service: "fixture",
      identity: {
        displayName: "Synthetic identity",
        externalAccountId: null,
        emailAddress: null,
      },
      transport: { type: "mcp", serverConfigRef: "fixture-not-executed" },
      authentication: { method: "none" },
      observedState: "unknown",
      lastVerifiedAt: null,
    },
    null,
  );
  const group = await application.authorization.saveGroup(
    user,
    {
      id: "business-read",
      projectId: project.id,
      revision: 1,
      name: "Business group",
      description: "Disposable capabilities",
      updatedAt: new Date().toISOString(),
      grants: {
        crew: [{ action: "agents.read" }],
        services: [],
        environmentPolicyIds: [],
      },
    },
    null,
  );
  const preset = await application.authorization.savePreset(
    user,
    {
      id: "business-specialist",
      projectId: project.id,
      revision: 1,
      name: "Business specialist",
      enabled: true,
      profile: {
        name: "Business specialist",
        pictureRef: null,
        personality: "",
        systemPrompt: "Editable business guidance",
      },
      skills: [],
      modelAccessId: application.setupDefaults.modelAccessId,
      configRef: application.setupDefaults.configRef,
      permissionGroupIds: [group.id],
      serviceConnectionIds: [],
    },
    null,
  );
  const agent = await application.ownerApi.command("createAgent", {
    input: { presetId: preset.id, expectedPresetRevision: preset.revision },
  });
  await application.ownerApi.command("setPrimaryAgent", {
    agentId: agent.id,
    expectedRevision:
      application.foundation.store.snapshot().projectSettings.revision,
  });
  const populated = await application.ownerApi.snapshot();
  assert.equal(populated.agents.length, 1);
  assert.equal(populated.agents[0].runtime.session.observedState, "stopped");
  assert.equal(populated.agents[0].runtime.threadId, null);
  assert.equal(populated.pendingMessages.length, 0);
  assert.equal(
    populated.serviceConnections[0].name,
    "Synthetic service metadata",
  );
  assert.deepEqual(
    (await application.authorization.accessFor(agent.id)).permissionGroupIds,
    [group.id],
  );
  assert.deepEqual(application.environmentOwnerApi.snapshot().workspaces, []);
  pass(
    "Owner preset creates a stopped specialist with groups and service metadata without repository access",
  );

  // Root #127 adds reference metadata independently of repository registration.
  const hasReferences = Object.hasOwn(populated, "projectResources");
  if (hasReferences) {
    const reference = await application.ownerApi.command(
      "resources.saveReference",
      {
        expectedRevision: null,
        name: "Business documentation",
        category: "documentation",
        description: "Fixture reference only",
        url: "https://example.com/",
      },
    );
    const resources = await application.ownerApi.command("resources.list", {});
    assert.ok(resources.some((row) => row.id === reference.id));
    pass(
      "Project resource catalogue accepts non-repository business documentation",
    );
  } else
    console.log(
      "INFO pre-resource runtime: resource catalogue check belongs to integrated #127 runtime",
    );

  const isolated = await openApp(registry, second);
  const isolatedSnapshot = await isolated.ownerApi.snapshot();
  assert.equal(isolatedSnapshot.agents.length, 0);
  assert.equal(isolatedSnapshot.serviceConnections.length, 0);
  assert.equal((await isolated.accessOwnerApi.snapshot()).groups.length, 0);
  await closeApp(isolated);
  await closeApp(application);

  const reopenedRegistry = await openUnifiedRegistry(
    join(root, "private desktop"),
  );
  assert.deepEqual(reopenedRegistry.snapshot(), registry.snapshot());
  application = await openApp(reopenedRegistry, project);
  const retained = await application.ownerApi.snapshot();
  assert.equal(retained.agents[0].id, agent.id);
  assert.equal(retained.projectSettings.primaryAgentId, agent.id);
  assert.equal(retained.serviceConnections[0].id, "fixture-service");
  assert.deepEqual(
    (await application.authorization.accessFor(agent.id)).permissionGroupIds,
    [group.id],
  );
  if (hasReferences)
    assert.ok(
      (await application.ownerApi.command("resources.list", {})).some(
        (row) => row.name === "Business documentation",
      ),
    );
  await closeApp(application);
  pass(
    "Registry, specialist, groups and service metadata survive reopen and stay isolated from another business",
  );
  assert.deepEqual(await readdir(source), ["business.txt"]);
  assert.equal(
    await readFile(join(source, "business.txt"), "utf8"),
    "Disposable non-Git business workspace.\n",
  );
  assert.deepEqual(await readdir(other), []);
  pass(
    "Business folders remain untouched: no Git init, config, credential or session files",
  );
  console.log(
    JSON.stringify(
      {
        root,
        runtimeRoot,
        checks,
        native:
          "Version/config verification only; no account reads, agent sessions or model turns",
        service: "Synthetic metadata only; no external connection verification",
      },
      null,
      2,
    ),
  );
} finally {
  for (const application of [...apps]) await closeApp(application);
}
