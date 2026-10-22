import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspectEnvironmentTemplate } from "../src/agents/environment-tool-inspector.mts";

async function fixture(t) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "crew-template-inspector-")),
  );
  await mkdir(join(root, "controller"), { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = {
    id: "node-tools",
    projectId: "project",
    revision: 1,
    updatedAt: new Date().toISOString(),
    name: "Optional Node",
    description: "",
    tools: [],
    executableDirectories: [],
    readableDirectories: [],
    environment: {},
    capabilities: {
      network: false,
      packageDownloads: false,
      localhostPorts: [],
    },
    preparation: { instructions: "", commands: [] },
  };
  return { root, template, controller: join(root, "controller") };
}

test("a minimal template has no tool requirement or installation side effect", async (t) => {
  const f = await fixture(t);
  const report = await inspectEnvironmentTemplate(f.template, f.controller);
  assert.deepEqual(report.tools, []);
  assert.match(report.limitations.join(" "), /does not install/);
});

test(
  "actual sandboxed Node inspection distinguishes compatible and wrong versions",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const f = await fixture(t);
    f.template.executableDirectories = [
      dirname(await realpath(process.execPath)),
    ];
    f.template.tools = [
      { name: "node", versionRequirement: process.versions.node },
    ];
    let report = await inspectEnvironmentTemplate(f.template, f.controller);
    assert.equal(report.tools[0].state, "available", JSON.stringify(report));
    assert.equal(report.tools[0].observedVersion, process.versions.node);
    f.template.tools[0].versionRequirement = "0.0.1";
    report = await inspectEnvironmentTemplate(f.template, f.controller);
    assert.equal(report.tools[0].state, "wrong_version");
  },
);

test("inspection rejects redirected roots rather than discovering through them", async (t) => {
  const f = await fixture(t),
    actual = join(f.root, "tools"),
    alias = join(f.root, "alias");
  await mkdir(actual);
  await symlink(actual, alias);
  f.template.executableDirectories = [alias];
  f.template.tools = [{ name: "node", versionRequirement: null }];
  const report = await inspectEnvironmentTemplate(f.template, f.controller);
  assert.equal(report.tools[0].state, "unavailable");
  assert.equal(report.tools[0].observedVersion, null);
});
