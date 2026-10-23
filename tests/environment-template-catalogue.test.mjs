import test from "node:test";
import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectEnvironmentTemplateCatalogue } from "../src/agents/environment-templates.mts";

const owner = { type: "user", userId: "owner" };
const draft = () => ({
  name: "Local only",
  description: "",
  tools: [],
  executableDirectories: [],
  readableDirectories: [],
  environment: {},
  capabilities: { packageDownloads: false, network: false, localhostPorts: [] },
  preparation: { instructions: "", commands: [] },
});

async function fixture(t, inspect) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "crew-template-catalogue-")),
  );
  const directory = join(root, "controller"),
    tools = join(root, "tools");
  await mkdir(directory, { mode: 0o700 });
  await mkdir(tools, { mode: 0o700 });
  const agents = ["one", "two"].map((id) => ({
    id,
    projectId: "project",
    archivedAt: null,
  }));
  const options = {
    directory,
    projectId: "project",
    ownerUserId: "owner",
    protectedDirectories: [directory],
    listAgents: async () => agents,
    inspect,
  };
  const result = {
    root,
    directory,
    tools,
    agents,
    options,
    catalogue: await ProjectEnvironmentTemplateCatalogue.open(options),
  };
  t.after(async () => {
    await result.catalogue.close();
    await rm(root, { recursive: true, force: true });
  });
  return result;
}

test("saving and sharing a template only assigns metadata, including explicit preparation commands", async (t) => {
  let inspected = 0;
  const f = await fixture(t, async () => {
    inspected++;
    throw Error("Must not inspect automatically");
  });
  const minimal = await f.catalogue.saveTemplate(owner, {
    id: null,
    expectedRevision: null,
    draft: draft(),
  });
  assert.deepEqual(minimal.tools, []);
  const marker = join(f.root, "must-not-run");
  const saved = await f.catalogue.saveTemplate(owner, {
    id: null,
    expectedRevision: null,
    draft: {
      ...draft(),
      name: "Optional Node",
      tools: [{ name: "node", versionRequirement: ">=22" }],
      executableDirectories: [f.tools],
      preparation: {
        instructions: "Prepare explicitly",
        commands: [
          [
            "node",
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`,
          ],
        ],
      },
    },
  });
  for (const agentId of ["one", "two"])
    await f.catalogue.assign(owner, {
      agentId,
      expectedRevision: null,
      templateId: saved.id,
      templateRevision: saved.revision,
    });
  const plan = await f.catalogue.resolvePreparation({
    caller: { projectId: "project", agentId: "one", sessionId: "session" },
    agentId: "one",
    environmentId: "workspace",
    requestId: "prepare",
    expectedAssignmentRevision: 1,
  });
  assert.equal(plan.template.id, saved.id);
  assert.equal(inspected, 0);
  await assert.rejects(access(marker), { code: "ENOENT" });
  assert.equal(f.catalogue.ownerSnapshot(owner).assignments.length, 2);
});

test("concurrent saves conflict and immutable assignment pins survive edits and durable reopen", async (t) => {
  const f = await fixture(t);
  const original = await f.catalogue.saveTemplate(owner, {
    id: null,
    expectedRevision: null,
    draft: draft(),
  });
  for (const agentId of ["one", "two"])
    await f.catalogue.assign(owner, {
      agentId,
      expectedRevision: null,
      templateId: original.id,
      templateRevision: 1,
    });
  const saved = await Promise.allSettled(
    ["Updated A", "Updated B"].map((name) =>
      f.catalogue.saveTemplate(owner, {
        id: original.id,
        expectedRevision: 1,
        draft: { ...draft(), name },
      }),
    ),
  );
  assert.equal(saved.filter((row) => row.status === "fulfilled").length, 1);
  assert.match(
    saved.find((row) => row.status === "rejected").reason.message,
    /Template changed/,
  );
  const copy = f.catalogue.resolvePinned(original.id, 1);
  copy.name = "Mutation outside store";
  assert.equal(f.catalogue.resolvePinned(original.id, 1).name, original.name);
  await f.catalogue.close();
  f.catalogue = await ProjectEnvironmentTemplateCatalogue.open(f.options);
  assert.equal(f.catalogue.ownerSnapshot(owner).templates[0].revision, 2);
  assert.ok(
    f.catalogue
      .ownerSnapshot(owner)
      .assignments.every((row) => row.templateRevision === 1),
  );
  await assert.rejects(
    f.catalogue.assign(owner, {
      agentId: "one",
      expectedRevision: null,
      templateId: original.id,
      templateRevision: 2,
    }),
    /assignment changed/,
  );
  await f.catalogue.assign(owner, {
    agentId: "one",
    expectedRevision: 1,
    templateId: original.id,
    templateRevision: 2,
  });
  const state = JSON.parse(
    await readFile(join(f.directory, "environment-templates.json"), "utf8"),
  );
  assert.equal(state.versions.length, 2);
  assert.equal(
    state.assignments.find((row) => row.agentId === "one").templateRevision,
    2,
  );
  assert.equal(
    state.assignments.find((row) => row.agentId === "two").templateRevision,
    1,
  );
});

test("owner scope, private configuration paths and inspection aliases fail closed", async (t) => {
  let inspected = 0;
  const f = await fixture(t, async () => {
    inspected++;
    throw Error("Alias reached inspector");
  });
  assert.throws(
    () => f.catalogue.ownerSnapshot({ type: "user", userId: "other" }),
    /owner required/,
  );
  await assert.rejects(ProjectEnvironmentTemplateCatalogue.open(f.options));
  const saved = await f.catalogue.saveTemplate(owner, {
    id: null,
    expectedRevision: null,
    draft: draft(),
  });
  f.agents.push({ id: "foreign", projectId: "other", archivedAt: null });
  await assert.rejects(
    f.catalogue.assign(owner, {
      agentId: "foreign",
      expectedRevision: null,
      templateId: saved.id,
      templateRevision: 1,
    }),
    /Current project agent/,
  );
  for (const path of [
    join(homedir(), ".codex", "auth.json"),
    join(homedir(), ".ssh", "id_ed25519"),
    join(homedir(), "Library", "Application Support"),
    f.root,
  ]) {
    await assert.rejects(
      f.catalogue.saveTemplate(owner, {
        id: null,
        expectedRevision: null,
        draft: { ...draft(), readableDirectories: [path] },
      }),
      /narrow|private/,
    );
  }
  for (const key of ["GITHUB_TOKEN", "NODE_OPTIONS", "NPM_CONFIG_USERCONFIG"]) {
    await assert.rejects(
      f.catalogue.saveTemplate(owner, {
        id: null,
        expectedRevision: null,
        draft: { ...draft(), environment: { [key]: "test-only" } },
      }),
      /credentials|isolation/,
    );
  }
  const alias = join(f.root, "alias");
  await symlink(f.tools, alias);
  const aliased = await f.catalogue.saveTemplate(owner, {
    id: null,
    expectedRevision: null,
    draft: {
      ...draft(),
      executableDirectories: [alias],
      tools: [{ name: "node", versionRequirement: null }],
    },
  });
  const report = await f.catalogue.inspect(owner, {
    templateId: aliased.id,
    templateRevision: 1,
  });
  assert.equal(report.tools[0].state, "unavailable");
  assert.equal(report.processEvidenceComplete, true);
  assert.equal(report.processesSettled, true);
  assert.deepEqual(report.processEvidenceRefs, []);
  assert.equal(inspected, 0);
});

test("inspection preserves unknown states and settlement receipts rather than implying readiness", async (t) => {
  let state = "available",
    processFields = {
      processEvidenceRefs: ["receipt-one"],
      processEvidenceComplete: true,
      processesSettled: false,
    };
  const f = await fixture(t, async (template) => ({
    templateId: template.id,
    templateRevision: template.revision,
    checkedAt: new Date().toISOString(),
    limitations: [],
    ...processFields,
    tools: [
      {
        name: "node",
        state,
        requestedVersion: null,
        observedVersion: state === "available" ? "20.0.0" : null,
        executablePath: state === "available" ? join(f.tools, "node") : null,
        reason: null,
      },
    ],
  }));
  const saved = await f.catalogue.saveTemplate(owner, {
    id: null,
    expectedRevision: null,
    draft: {
      ...draft(),
      tools: [{ name: "node", versionRequirement: ">=22" }],
    },
  });
  const request = { templateId: saved.id, templateRevision: 1 };
  const report = await f.catalogue.inspect(owner, request);
  assert.equal(report.tools[0].state, "wrong_version");
  assert.equal(report.processesSettled, false);
  assert.equal(report.processEvidenceComplete, true);
  assert.deepEqual(report.processEvidenceRefs, ["receipt-one"]);
  for (state of ["missing", "inaccessible", "unavailable"])
    assert.equal(
      (await f.catalogue.inspect(owner, request)).tools[0].state,
      state,
    );
  processFields = { processEvidenceRefs: ["bad\0ref"], processesSettled: true };
  await assert.rejects(f.catalogue.inspect(owner, request), /inspection/);
  await f.catalogue.close();
  f.catalogue = await ProjectEnvironmentTemplateCatalogue.open({
    ...f.options,
    inspect: undefined,
  });
  const unavailable = await f.catalogue.inspect(owner, request);
  assert.equal(unavailable.tools[0].state, "unavailable");
  assert.equal(unavailable.processesSettled, undefined);
  assert.equal(unavailable.processEvidenceComplete, undefined);
});

test("incoming TCP ports are explicit and additive without changing old template revision bytes", async (t) => {
  const f = await fixture(t);
  const old = await f.catalogue.saveTemplate(owner, {
    id: null,
    expectedRevision: null,
    draft: draft(),
  });
  const originalBytes = JSON.stringify(old);
  await f.catalogue.assign(owner, {
    agentId: "one",
    expectedRevision: null,
    templateId: old.id,
    templateRevision: 1,
  });
  const configured = {
    ...draft(),
    capabilities: { ...draft().capabilities, inboundPorts: [43123] },
  };
  const updated = await f.catalogue.saveTemplate(owner, {
    id: old.id,
    expectedRevision: 1,
    draft: configured,
  });
  assert.deepEqual(updated.capabilities.inboundPorts, [43123]);
  assert.equal(updated.capabilities.network, false);
  assert.deepEqual(updated.capabilities.localhostPorts, []);
  for (const inboundPorts of [
    [80],
    [65536],
    [43123, 43123],
    Array.from({ length: 17 }, (_, index) => 43000 + index),
    null,
  ]) {
    await assert.rejects(
      f.catalogue.saveTemplate(owner, {
        id: null,
        expectedRevision: null,
        draft: {
          ...configured,
          capabilities: { ...configured.capabilities, inboundPorts },
        },
      }),
      /capabilities/,
    );
  }
  await f.catalogue.close();
  f.catalogue = await ProjectEnvironmentTemplateCatalogue.open(f.options);
  assert.equal(
    JSON.stringify(f.catalogue.resolvePinned(old.id, 1)),
    originalBytes,
  );
  assert.equal(
    Object.hasOwn(
      f.catalogue.resolvePinned(old.id, 1).capabilities,
      "inboundPorts",
    ),
    false,
  );
  assert.equal(f.catalogue.assignment("one").templateRevision, 1);
  assert.deepEqual(
    f.catalogue.resolvePinned(old.id, 2).capabilities.inboundPorts,
    [43123],
  );
});

test("host Docker authority requires explicit acknowledgement and never changes old revision pins", async (t) => {
  const f = await fixture(t);
  const old = await f.catalogue.saveTemplate(owner, {
    id: null,
    expectedRevision: null,
    draft: draft(),
  });
  const originalBytes = JSON.stringify(old);
  await f.catalogue.assign(owner, {
    agentId: "one",
    expectedRevision: null,
    templateId: old.id,
    templateRevision: 1,
  });
  const socketPath = join(f.root, "owner-daemon.sock");
  for (const hostDocker of [
    { socketPath, hostAccessAcknowledged: false },
    { socketPath },
    { socketPath: "relative/docker.sock", hostAccessAcknowledged: true },
    {
      socketPath: join(f.root, "child") + "/../docker.sock",
      hostAccessAcknowledged: true,
    },
  ]) {
    await assert.rejects(
      f.catalogue.saveTemplate(owner, {
        id: null,
        expectedRevision: null,
        draft: { ...draft(), hostDocker },
      }),
      /Host Docker/,
    );
  }
  const updated = await f.catalogue.saveTemplate(owner, {
    id: old.id,
    expectedRevision: 1,
    draft: {
      ...draft(),
      hostDocker: { socketPath, hostAccessAcknowledged: true },
    },
  });
  assert.deepEqual(updated.hostDocker, {
    socketPath,
    hostAccessAcknowledged: true,
  });
  // Saving the owner choice does not connect to or create a daemon socket.
  await assert.rejects(access(socketPath), { code: "ENOENT" });
  await f.catalogue.close();
  f.catalogue = await ProjectEnvironmentTemplateCatalogue.open(f.options);
  assert.equal(
    JSON.stringify(f.catalogue.resolvePinned(old.id, 1)),
    originalBytes,
  );
  assert.equal(
    Object.hasOwn(f.catalogue.resolvePinned(old.id, 1), "hostDocker"),
    false,
  );
  assert.equal(f.catalogue.assignment("one").templateRevision, 1);
  assert.equal(
    f.catalogue.resolvePinned(old.id, 2).hostDocker.hostAccessAcknowledged,
    true,
  );
});
