import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  readFile,
  lstat,
  realpath,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test from "node:test";
import { createServer } from "node:net";
import { ProjectEnvironmentService } from "../src/agents/environments.mts";
import { inspectEnvironmentTemplate } from "../src/agents/environment-tool-inspector.mts";
import {
  runMacWorkspaceCommand,
  startMacWorkspaceProcess,
  inspectMacWorkspaceProcess,
  stopMacWorkspaceProcess,
  reconcileMacWorkspaceCommand,
} from "../src/access/workspace-executor.mts";
test(
  "execution admission refreshes initially unknown managed starts without owner reconciliation",
  { skip: process.platform !== "darwin", concurrency: false, timeout: 15000 },
  async (t) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "crew108-start-refresh-")),
    );
    const controller = join(root, "controller"),
      directory = join(controller, "environments"),
      workspace = join(root, "workspace");
    for (const path of [controller, workspace])
      await mkdir(path, { mode: 0o700 });
    const actor = { type: "user", userId: "owner" };
    const caller = {
      projectId: "project",
      agentId: "agent",
      sessionId: "session",
    };
    let revoked = false,
      unknownObservation = false,
      starts = 0,
      request = 0;
    const refs = new Set();
    let serial = Promise.resolve();
    const service = await ProjectEnvironmentService.open({
      directory,
      protectedDirectories: [controller],
      projectId: "project",
      ownerUserId: "owner",
      admission: {
        run(fn) {
          const task = serial.then(fn);
          serial = task.catch(() => {});
          return task;
        },
      },
      authorize: async (_caller, action) => {
        if (revoked && action !== "read") throw Error("revoked");
      },
      verifyExecution: async () => {},
      noteExecutionAdmitted: async () => {},
      execute: runMacWorkspaceCommand,
      observeExecution: reconcileMacWorkspaceCommand,
      startExecution: async (...args) => {
        starts++;
        const result = await startMacWorkspaceProcess(...args);
        if (result.processEvidenceRef) refs.add(result.processEvidenceRef);
        // Simulate the real initial sampling race while retaining the actual
        // helper's durable complete identity and later OS observations.
        return { ...result, state: "unknown", processesSettled: false };
      },
      inspectExecution: async (...args) => {
        const result = await inspectMacWorkspaceProcess(...args);
        return unknownObservation
          ? { ...result, state: "unknown", processesSettled: false }
          : result;
      },
      stopExecution: stopMacWorkspaceProcess,
    });
    t.after(async () => {
      const results = await Promise.all(
        [...refs].map((ref) => stopMacWorkspaceProcess(directory, ref)),
      );
      const settled = results.every((result) => result.processesSettled);
      await service.close();
      if (settled) await rm(root, { recursive: true, force: true });
      assert.equal(
        settled,
        true,
        "retain evidence if fixture process exit is unconfirmed",
      );
    });
    await service.approveWorkspace(
      actor,
      {
        policyId: "folder",
        workspaceDirectory: workspace,
        writable: true,
        executableDirectories: [],
      },
      null,
    );
    const invoke = (action, args) =>
      service.invoke({
        caller,
        agentId: "agent",
        requestId: `refresh-${++request}`,
        action,
        arguments: args,
      });
    const attached = await invoke("attach", { policyId: "folder" });
    const environmentId = attached.result.environmentId;
    const started = await invoke("start", {
      environmentId,
      command: ["/bin/sleep", "2"],
    });
    assert.equal(started.result.state, "unknown");
    assert.equal(started.executionSettled, false);
    const operation = () =>
      service
        .ownerSnapshot(actor)
        .operations.find((row) => row.id === started.operationId);
    const observed = await invoke("status", {
      operationId: started.operationId,
    });
    assert.equal(observed.observations[0].state, "running");
    assert.equal(
      operation().result.state,
      "unknown",
      "read-only status preserves original outcome",
    );
    unknownObservation = true;
    await assert.rejects(
      invoke("execute", { environmentId, command: ["/usr/bin/true"] }),
      /running or uncertain/,
    );
    unknownObservation = false;
    const foreground = await invoke("execute", {
      environmentId,
      command: ["/usr/bin/true"],
    });
    assert.equal(
      foreground.result.state,
      "exited",
      "fresh running evidence permits foreground after an unknown initial response",
    );
    assert.equal(operation().result.state, "unknown");
    assert.equal(operation().executionSettled, false);
    const second = await invoke("start", {
      environmentId,
      command: ["/usr/bin/true"],
    });
    assert.equal(
      second.result.state,
      "unknown",
      "fresh running evidence also permits another explicit managed start",
    );
    let status;
    for (let attempt = 0; attempt < 40; attempt++) {
      status = await invoke("status", { operationId: started.operationId });
      if (status.observedExecutionSettled) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(status.observedExecutionSettled, true);
    assert.equal(
      operation().executionSettled,
      false,
      "even confirmed-exit status remains read-only",
    );
    revoked = true;
    await assert.rejects(
      invoke("execute", { environmentId, command: ["/usr/bin/true"] }),
      /revoked/,
    );
    assert.equal(
      operation().executionSettled,
      false,
      "observation cannot mutate without fresh execution authority",
    );
    revoked = false;
    const afterExit = await invoke("execute", {
      environmentId,
      command: ["/usr/bin/true"],
    });
    assert.equal(afterExit.result.state, "exited");
    assert.equal(
      operation().executionSettled,
      true,
      "authorized admission confirms natural settlement without an owner API",
    );
    assert.equal(
      operation().result.state,
      "unknown",
      "settlement never rewrites command outcome",
    );
    assert.equal(
      starts,
      2,
      "only the two explicit Start requests launched helpers; no setup replay",
    );
  },
);
test(
  "prepared environment and owner inspection retain exact lifecycle, authority and process evidence",
  { skip: process.platform !== "darwin", concurrency: false, timeout: 3e4 },
  async (t) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "crew108-service-")),
    );
    const controller = join(root, "controller"),
      directory = join(controller, "environments"),
      workspace = join(root, "workspace"),
      runtimeDirectory = join(root, "runtime");
    for (const path of [controller, workspace])
      await mkdir(path, { mode: 448 });
    const portProbe = createServer();
    await new Promise((r) => portProbe.listen(0, "127.0.0.1", r));
    const port = portProbe.address().port;
    await new Promise((r, j) => portProbe.close((e) => (e ? j(e) : r())));
    const actor = { type: "user", userId: "owner" };
    const caller = {
      projectId: "project",
      agentId: "agent",
      sessionId: "session",
    };
    let revoked = false,
      executionAllowed = true,
      inspections = 0,
      starts = 0,
      unknownInspection = false,
      liveInspection = false,
      inspectionHook;
    let ownerAllowed = true;
    let assignment = {
      agentId: "agent",
      revision: 1,
      templateId: "template",
      templateRevision: 1,
      updatedAt: new Date().toISOString(),
    };
    const template = {
      id: "template",
      projectId: "project",
      revision: 1,
      updatedAt: new Date().toISOString(),
      name: "Node",
      description: "Disposable Node fixture",
      tools: [{ name: "node", versionRequirement: process.versions.node }],
      executableDirectories: [dirname(await realpath(process.execPath))],
      readableDirectories: [],
      environment: {},
      capabilities: {
        packageDownloads: false,
        network: false,
        localhostPorts: [],
        inboundPorts: [port],
      },
      preparation: {
        instructions: "Run setup only when explicitly selected.",
        commands: [["/bin/sh", "-c", "touch should-not-exist"]],
      },
    };
    const versions = new Map([[1, template]]);
    let serial = Promise.resolve();
    const admission = {
      run(operation) {
        const p = serial.then(operation);
        serial = p.then(
          () => {},
          () => {},
        );
        return p;
      },
    };
    const options = {
      directory,
      protectedDirectories: [controller],
      projectId: "project",
      ownerUserId: "owner",
      admission,
      runtimeDirectory,
      authorize: async (_c, action) => {
        if (revoked && action !== "read") throw Error("revoked");
      },
      verifyOwnerExecution: async () => {
        if (!ownerAllowed) throw Error("owner reservation");
      },
      verifyExecution: async () => {
        if (!executionAllowed) throw Error("session closed");
      },
      noteExecutionAdmitted: async () => {},
      execute: runMacWorkspaceCommand,
      observeExecution: reconcileMacWorkspaceCommand,
      startExecution: async (...args) => {
        starts++;
        return startMacWorkspaceProcess(...args);
      },
      inspectExecution: inspectMacWorkspaceProcess,
      stopExecution: stopMacWorkspaceProcess,
      templateSource: {
        assignment: () => structuredClone(assignment),
        resolvePinned: (_id, revision) => {
          const t2 = versions.get(revision);
          if (!t2) throw Error("missing pin");
          return structuredClone(t2);
        },
        resolvePreparation: async (request2) => {
          if (request2.expectedAssignmentRevision !== assignment.revision)
            throw Error("stale assignment");
          return {
            request: request2,
            assignment: structuredClone(assignment),
            template: structuredClone(
              versions.get(assignment.templateRevision),
            ),
          };
        },
        inspect: async (t2) => {
          inspections++;
          assert.equal(
            service.settlement().inFlightOperationIds.length,
            1,
            "receipt must predate inspector",
          );
          inspectionHook?.();
          if (unknownInspection)
            throw Error("simulated unknown callback failure");
          if (liveInspection) {
            const child = await startMacWorkspaceProcess(
              {
                workspaceDirectory: workspace,
                privateDirectory: directory,
                writable: false,
                readableRoots: [],
                writableRoots: [],
                executableDirectories: [],
              },
              { command: "/bin/sleep 30" },
            );
            backgroundRef = child.processEvidenceRef;
            return {
              templateId: t2.id,
              templateRevision: t2.revision,
              checkedAt: new Date().toISOString(),
              tools: [],
              limitations: [],
              processEvidenceRefs: [child.processEvidenceRef],
              processEvidenceComplete: true,
              processesSettled: false,
            };
          }
          return inspectEnvironmentTemplate(t2, directory);
        },
      },
    };
    let service = await ProjectEnvironmentService.open(options);
    let request = 0;
    const invoke = (action, args, id = `request-${++request}`) =>
      service.invoke({
        caller,
        agentId: "agent",
        requestId: id,
        action,
        arguments: args,
      });
    const checks = [];
    let backgroundRef, secondBackgroundRef;
    try {
      await service.approveWorkspace(
        actor,
        {
          policyId: "folder",
          workspaceDirectory: workspace,
          writable: true,
          executableDirectories: [],
        },
        null,
      );
      const attached = await invoke("attach", { policyId: "folder" });
      const environmentId = attached.result.environmentId;
      const prepared = await invoke(
        "prepare",
        { environmentId, expectedAssignmentRevision: 1 },
        "prepare-first",
      );
      assert.equal(prepared.result.state, "prepared");
      assert.equal(prepared.executionSettled, true);
      assert.equal(prepared.result.commandsExecuted, false);
      assert.equal(inspections, 1);
      await assert.rejects(lstat(join(workspace, "should-not-exist")));
      const snapshot = service.ownerSnapshot(actor);
      const pin = snapshot.environments[0].preparation;
      assert.ok(
        pin.cacheDirectories.every(
          (row) =>
            row.path.startsWith(runtimeDirectory) &&
            !row.path.startsWith(controller),
        ),
      );
      const replay = await invoke(
        "prepare",
        { environmentId, expectedAssignmentRevision: 1 },
        "prepare-first",
      );
      assert.equal(replay.operationId, prepared.operationId);
      assert.equal(inspections, 1);
      checks.push(
        "prepare journals before actual sandbox Node version inspection; pins roots/revisions/private caches; runs zero suggested commands; replay does not inspect again",
      );
      const read = await invoke("execute", {
        environmentId,
        command: [
          "node",
          "-e",
          'process.stdout.write(process.env.npm_config_cache+"|"+process.version)',
        ],
      });
      assert.equal(read.result.state, "exited");
      assert.equal(
        read.result.stdout,
        `${pin.cacheDirectories[0].path}|v${process.versions.node}`,
      );
      checks.push(
        "prepared execution uses pinned real Node and private npm cache",
      );
      const writeHome = await invoke("execute", {
        environmentId,
        command: [
          "node",
          "-e",
          "require('fs').writeFileSync(require('path').join(require('os').homedir(),'fixture-home'),'retained');process.stdout.write(require('os').homedir())",
        ],
      });
      assert.equal(writeHome.result.stdout, pin.runtimeHome.path);
      const readHome = await invoke("execute", {
        environmentId,
        command: [
          "node",
          "-e",
          "process.stdout.write(require('fs').readFileSync(require('path').join(require('os').homedir(),'fixture-home'),'utf8'))",
        ],
      });
      assert.equal(readHome.result.stdout, "retained");
      checks.push(
        "private runtime HOME is pinned outside controller and persists across explicit commands",
      );

      assignment = { ...assignment, revision: 2 };
      const unchanged = await invoke("execute", {
        environmentId,
        command: ["node", "--version"],
      });
      assert.equal(unchanged.result.state, "exited");
      assert.equal(
        service.ownerSnapshot(actor).environments[0].preparation
          .assignmentRevision,
        1,
      );
      const listing = await service.list(caller, "agent");
      assert.equal(listing[0].templateAssignment.revision, 2);
      checks.push(
        "assignment change is discoverable and does not silently alter existing pin",
      );
      const serverCommand = [
        "node",
        "-e",
        `require('http').createServer((q,r)=>r.end('crew108')).listen(${port},'127.0.0.1')`,
      ];
      const started = await invoke(
        "start",
        { environmentId, command: serverCommand },
        "start-first",
      );
      assert.equal(started.result.state, "running");
      assert.equal(started.executionSettled, false);
      backgroundRef = service
        .ownerSnapshot(actor)
        .operations.find((r) => r.id === started.operationId)
        .processEvidenceRefs[0];
      assert.equal(
        await (await fetch(`http://127.0.0.1:${port}`)).text(),
        "crew108",
      );
      const startAgain = await invoke(
        "start",
        { environmentId, command: serverCommand },
        "start-first",
      );
      assert.equal(startAgain.operationId, started.operationId);
      assert.equal(starts, 1);
      const secondStarted = await invoke(
        "start",
        { environmentId, command: ["/bin/sleep", "30"] },
        "start-second",
      );
      assert.equal(secondStarted.result.state, "running");
      secondBackgroundRef = service
        .ownerSnapshot(actor)
        .operations.find((row) => row.id === secondStarted.operationId)
        .processEvidenceRefs[0];

      const whileRunning = await invoke("execute", {
        environmentId,
        command: ["/usr/bin/printf", "foreground"],
      });
      assert.equal(whileRunning.result.stdout, "foreground");
      await assert.rejects(invoke("dispose", { environmentId }));
      await assert.rejects(
        invoke("prepare", { environmentId, expectedAssignmentRevision: 2 }),
      );
      const before = await readFile(
        join(directory, "environments.json"),
        "utf8",
      );
      executionAllowed = false;
      const status = await invoke("status", {
        operationId: started.operationId,
      });
      assert.equal(status.observations[0].state, "running");
      assert.ok(
        status.observations[0].listeningPorts.some((p) => p.port === port),
      );
      assert.ok(!JSON.stringify(status).includes("workspace-process:"));
      const ownerStatus = await service.inspectOperation(
        actor,
        started.operationId,
      );
      assert.equal(ownerStatus.processEvidenceRefs?.[0], backgroundRef);
      assert.equal(
        await readFile(join(directory, "environments.json"), "utf8"),
        before,
      );
      await assert.rejects(
        invoke("stop", { operationId: started.operationId }),
      );
      executionAllowed = true;
      revoked = true;
      await assert.rejects(
        invoke("stop", { operationId: started.operationId }),
      );
      await assert.rejects(
        invoke("execute", { environmentId, command: ["/usr/bin/true"] }),
      );
      revoked = false;
      const stopped = await invoke("stop", {
        operationId: started.operationId,
      });
      assert.equal(stopped.result.processesSettled, true);
      backgroundRef = void 0;
      assert.equal(
        service
          .ownerSnapshot(actor)
          .operations.find((r) => r.id === started.operationId)
          .executionSettled,
        true,
      );
      const secondStatus = await invoke("status", {
        operationId: secondStarted.operationId,
      });
      assert.equal(secondStatus.observations[0].state, "running");
      assert.equal(
        service
          .ownerSnapshot(actor)
          .operations.find((row) => row.id === secondStarted.operationId)
          .executionSettled,
        false,
      );
      const secondStopped = await invoke("stop", {
        operationId: secondStarted.operationId,
      });
      assert.equal(secondStopped.executionSettled, true);
      secondBackgroundRef = undefined;
      checks.push(
        "two managed background processes coexist; stopping either exact operation leaves the other running until explicitly stopped",
      );

      checks.push(
        "actual owner-configured incoming-port Node HTTP server answers requests and reports listener; real background start is idempotent; foreground/status work while running; dispose/reprepare blocked; fresh revocation/session close deny stop/execute; exact stop settles original receipt",
      );
      const ownerReport = await service.inspectTemplate(actor, {
        templateId: "template",
        templateRevision: 1,
      });
      assert.equal(ownerReport.processesSettled, true);
      assert.equal(service.ownerSnapshot(actor).ownerInspections.length, 1);
      assert.deepEqual(service.settlement().uncertainOperationIds, []);
      checks.push(
        "owner inspection journals actual helper receipt in same journal and settles truthfully",
      );
      const ownerCount = inspections;
      let releaseGate;
      const gateHeld = admission.run(
        () =>
          new Promise((r) => {
            releaseGate = r;
          }),
      );
      await new Promise((r) => setTimeout(r, 0));
      const ownerRace = service.inspectTemplate(actor, {
        templateId: "template",
        templateRevision: 1,
      });
      await new Promise((r) => setTimeout(r, 0));
      ownerAllowed = false;
      releaseGate();
      await gateHeld;
      await assert.rejects(ownerRace);
      ownerAllowed = true;
      assert.equal(inspections, ownerCount);
      assert.equal(service.ownerSnapshot(actor).ownerInspections.length, 1);
      checks.push(
        "owner reservation is rechecked inside admission after queued inspection; no helper or marker is created",
      );
      liveInspection = true;
      const ownerPending = await service.inspectTemplate(actor, {
        templateId: "template",
        templateRevision: 1,
      });
      assert.equal(ownerPending.processesSettled, false);
      const ownerRow = service.ownerSnapshot(actor).ownerInspections.at(-1);
      assert.ok(
        service.settlement().uncertainOperationIds.includes(ownerRow.id),
      );
      assert.ok(
        !service.settlement(caller).uncertainOperationIds.includes(ownerRow.id),
      );
      await stopMacWorkspaceProcess(directory, backgroundRef);
      backgroundRef = void 0;
      liveInspection = false;
      const ownerReconciled = await service.reconcileOperation(
        actor,
        ownerRow.id,
      );
      assert.equal(ownerReconciled.executionSettled, true);
      checks.push(
        "owner pending helper inventory participates in global lifecycle and reconciles after actual exit",
      );
      const v2 = {
        ...template,
        revision: 2,
        capabilities: { ...template.capabilities, localhostPorts: [54321] },
      };
      versions.set(2, v2);
      assignment = { ...assignment, revision: 3, templateRevision: 2 };
      const unsupported = await invoke("prepare", {
        environmentId,
        expectedAssignmentRevision: 3,
      });
      assert.equal(unsupported.result.state, "not_prepared");
      assert.equal(unsupported.executionSettled, true);
      assert.equal(
        service.ownerSnapshot(actor).environments[0].preparation
          .templateRevision,
        1,
      );
      checks.push(
        "unsupported inbound capability fails settled before tools and preserves old pin",
      );
      assignment = { ...assignment, revision: 4, templateRevision: 1 };
      inspectionHook = () => {
        revoked = true;
      };
      const stale = await invoke("prepare", {
        environmentId,
        expectedAssignmentRevision: 4,
      });
      inspectionHook = void 0;
      revoked = false;
      assert.equal(stale.result.state, "not_prepared");
      assert.equal(stale.executionSettled, true);
      assert.equal(
        service.ownerSnapshot(actor).environments[0].preparation
          .assignmentRevision,
        1,
      );
      checks.push(
        "revocation during actual inspection prevents publication while retaining settled process evidence",
      );
      liveInspection = true;
      const pending = await invoke("prepare", {
        environmentId,
        expectedAssignmentRevision: 4,
      });
      assert.equal(pending.state, "completed");
      assert.equal(pending.result.state, "not_prepared");
      assert.equal(pending.executionSettled, false);
      await stopMacWorkspaceProcess(directory, backgroundRef);
      backgroundRef = void 0;
      liveInspection = false;
      const reconciled = await service.reconcileOperation(
        actor,
        pending.operationId,
      );
      assert.equal(reconciled.executionSettled, true);
      checks.push(
        "known returned inspection inventory with live processes stays pending then reconciles without permanent uncertainty",
      );
      unknownInspection = true;
      const uncertain = await invoke(
        "prepare",
        { environmentId, expectedAssignmentRevision: 4 },
        "prepare-uncertain",
      );
      assert.equal(uncertain.state, "uncertain");
      assert.equal(uncertain.executionSettled, false);
      const count = inspections;
      const uncertainReplay = await invoke(
        "prepare",
        { environmentId, expectedAssignmentRevision: 4 },
        "prepare-uncertain",
      );
      assert.equal(uncertainReplay.operationId, uncertain.operationId);
      assert.equal(inspections, count);
      await assert.rejects(
        service.inspectTemplate(actor, {
          templateId: "template",
          templateRevision: 1,
        }),
      );
      const unknownOwnerId = service
        .ownerSnapshot(actor)
        .ownerInspections.at(-1).id;
      await service.close();
      service = await ProjectEnvironmentService.open(options);
      assert.ok(
        service.settlement().uncertainOperationIds.includes(unknownOwnerId),
      );
      assert.ok(
        service
          .settlement()
          .uncertainOperationIds.includes(uncertain.operationId),
      );
      executionAllowed = false;
      const unknownStatus = await service.inspectOperation(
        actor,
        uncertain.operationId,
      );
      assert.equal(unknownStatus.observedExecutionSettled, false);
      executionAllowed = true;
      checks.push(
        "unknown inspection is durably uncertain across reopen and exact retry never reruns; owner read-only inspection survives blocked execution",
      );
      for (const check of checks) t.diagnostic(check);
    } finally {
      for (const ref of [backgroundRef, secondBackgroundRef].filter(Boolean)) {
        const stopped = await stopMacWorkspaceProcess(directory, ref);
        assert.equal(
          stopped.processesSettled,
          true,
          `Retain unsettled fixture evidence in ${root}`,
        );
      }
      await service.close().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "host Docker authority is explicit, pinned to the current socket and preserves an isolated runtime home",
  { skip: process.platform !== "darwin", concurrency: false, timeout: 15000 },
  async (t) => {
    const root = await mkdtemp("/private/tmp/crew108-socket-service-");
    const controller = join(root, "controller"),
      directory = join(controller, "environments"),
      workspace = join(root, "workspace"),
      runtimeDirectory = join(root, "runtime");
    for (const path of [controller, workspace])
      await mkdir(path, { mode: 0o700 });
    const socketPath = join(root, "d.sock");
    const original = createServer((socket) => socket.end("fixture-daemon"));
    await new Promise((resolve, reject) => {
      original.once("error", reject);
      original.listen(socketPath, resolve);
    });
    let replacement;
    let service;
    t.after(async () => {
      await service?.close();
      for (const server of [replacement, original])
        if (server?.listening)
          await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    });
    const actor = { type: "user", userId: "owner" },
      caller = { projectId: "project", agentId: "agent", sessionId: "session" };
    let serial = Promise.resolve();
    const admission = {
      run(operation) {
        const result = serial.then(operation);
        serial = result.catch(() => {});
        return result;
      },
    };
    const base = {
      id: "template",
      projectId: "project",
      revision: 1,
      updatedAt: new Date().toISOString(),
      name: "Local tools",
      description: "",
      tools: [],
      executableDirectories: [dirname(await realpath(process.execPath))],
      readableDirectories: [],
      environment: {},
      capabilities: {
        packageDownloads: false,
        network: false,
        localhostPorts: [],
      },
      preparation: { instructions: "Explicit commands only", commands: [] },
    };
    const versions = new Map([[1, base]]);
    let assignment = {
      agentId: "agent",
      revision: 1,
      templateId: "template",
      templateRevision: 1,
      updatedAt: new Date().toISOString(),
    };
    service = await ProjectEnvironmentService.open({
      directory,
      protectedDirectories: [controller],
      runtimeDirectory,
      projectId: "project",
      ownerUserId: "owner",
      admission,
      authorize: async () => {},
      verifyExecution: async () => {},
      noteExecutionAdmitted: async () => {},
      execute: runMacWorkspaceCommand,
      observeExecution: reconcileMacWorkspaceCommand,
      templateSource: {
        resolvePinned: (_id, revision) =>
          structuredClone(versions.get(revision)),
        resolvePreparation: async (request) => ({
          request,
          assignment: structuredClone(assignment),
          template: structuredClone(versions.get(assignment.templateRevision)),
        }),
        inspect: (template) => inspectEnvironmentTemplate(template, directory),
      },
    });
    let request = 0;
    const invoke = (action, args) =>
      service.invoke({
        caller,
        agentId: "agent",
        requestId: `socket-${++request}`,
        action,
        arguments: args,
      });
    await service.approveWorkspace(
      actor,
      {
        policyId: "folder",
        workspaceDirectory: workspace,
        writable: true,
        executableDirectories: [],
      },
      null,
    );
    const attached = await invoke("attach", { policyId: "folder" }),
      environmentId = attached.result.environmentId;
    await invoke("prepare", { environmentId, expectedAssignmentRevision: 1 });
    assert.equal(
      service.ownerSnapshot(actor).environments[0].preparation.hostDocker,
      undefined,
    );
    const denied = await invoke("execute", {
      environmentId,
      command: [
        "node",
        "-e",
        `const c=require('net').connect(${JSON.stringify(socketPath)});c.on('data',b=>process.stdout.write(b));c.on('error',()=>process.stdout.write('denied'));`,
      ],
    });
    assert.equal(denied.result.stdout, "denied");
    const approved = {
      ...base,
      revision: 2,
      hostDocker: { socketPath, hostAccessAcknowledged: true },
    };
    versions.set(2, approved);
    assignment = { ...assignment, revision: 2, templateRevision: 2 };
    const prepared = await invoke("prepare", {
      environmentId,
      expectedAssignmentRevision: 2,
    });
    assert.equal(prepared.result.state, "prepared");
    const pin = service.ownerSnapshot(actor).environments[0].preparation;
    assert.equal(pin.hostDocker.socketPath, socketPath);
    assert.equal(pin.hostDocker.hostAccessAcknowledged, true);
    assert.ok(pin.runtimeHome.path.startsWith(runtimeDirectory));
    const connected = await invoke("execute", {
      environmentId,
      command: [
        "node",
        "-e",
        `const c=require('net').connect(process.env.DOCKER_HOST.slice(7));c.on('data',b=>process.stdout.write(b));c.on('error',()=>process.stdout.write('denied'));`,
      ],
    });
    assert.equal(connected.result.stdout, "fixture-daemon");
    const configuration = await invoke("execute", {
      environmentId,
      command: [
        "node",
        "-e",
        "process.stdout.write(JSON.stringify({home:process.env.HOME,dockerConfig:process.env.DOCKER_CONFIG,entries:require('fs').readdirSync(process.env.DOCKER_CONFIG)}))",
      ],
    });
    assert.deepEqual(JSON.parse(configuration.result.stdout), {
      home: pin.runtimeHome.path,
      dockerConfig: join(pin.runtimeHome.path, ".docker"),
      entries: [],
    });
    await rename(socketPath, join(root, "old.sock"));
    replacement = createServer((socket) => socket.end("replacement"));
    await new Promise((resolve, reject) => {
      replacement.once("error", reject);
      replacement.listen(socketPath, resolve);
    });
    assert.notEqual((await lstat(socketPath)).ino, pin.hostDocker.inode);
    await assert.rejects(
      invoke("execute", { environmentId, command: ["node", "--version"] }),
      /socket changed/,
    );
    t.diagnostic(
      "Actual disposable Unix socket only; no host Docker daemon, user Docker configuration, credentials or containers accessed.",
    );
  },
);

test("equivalent folder setup reuses authority while retained aliases and distinct tool policies survive reopen", async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "crew124-folders-")),
  );
  const controller = join(root, "controller"),
    directory = join(controller, "environments"),
    workspace = join(root, "workspace"),
    tools = join(root, "tools");
  for (const folder of [controller, workspace, tools])
    await mkdir(folder, { mode: 0o700 });
  const owner = { type: "user", userId: "owner" },
    caller = { projectId: "project", agentId: "agent", sessionId: "session" };
  let tail = Promise.resolve();
  const options = {
    directory,
    protectedDirectories: [controller],
    projectId: "project",
    ownerUserId: "owner",
    admission: {
      run(fn) {
        const result = tail.then(fn);
        tail = result.catch(() => {});
        return result;
      },
    },
    authorize: async () => {},
    verifyExecution: async () => {},
    noteExecutionAdmitted: async () => {},
    execute: async () => {
      throw Error("No commands should run");
    },
    observeExecution: async () => {
      throw Error("No processes should run");
    },
  };
  let service = await ProjectEnvironmentService.open(options);
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const approval = (policyId, writable, executableDirectories = []) => ({
    policyId,
    workspaceDirectory: workspace,
    writable,
    executableDirectories,
  });
  await service.approveWorkspace(owner, approval("legacy-read", false), null);
  const attached = await service.invoke({
    caller,
    agentId: "agent",
    requestId: "attach-retained",
    action: "attach",
    arguments: { policyId: "legacy-read" },
  });
  const originalAttachment = service.ownerSnapshot(owner).environments;
  assert.equal(originalAttachment.length, 1);
  assert.equal(attached.executionSettled, true);
  const write = await service.approveWorkspace(
    owner,
    approval("settings-write", true),
    null,
  );
  const setup = await service.prepareFolderAccess(owner, {
    workspaceDirectory: workspace,
    access: "read_write",
  });
  assert.equal(setup.policy.id, write.policy.id);
  const concurrent = await Promise.all(
    ["random-one", "random-two"].map((id) =>
      service.approveWorkspace(owner, approval(id, true), null),
    ),
  );
  assert.ok(concurrent.every((row) => row.policy.id === write.policy.id));
  assert.equal(service.ownerSnapshot(owner).workspaces.length, 2);
  await service.approveWorkspace(
    owner,
    approval("tool-enabled", true, [tools]),
    null,
  );
  // Updating an existing authority may make two historical IDs equivalent.
  // Preserve both rather than rewriting its attached environment or references.
  await service.approveWorkspace(owner, approval("legacy-read", true), 1);
  const { equivalentWorkspaceChoices } =
    await import("../src/agents/workspace-identity.mts");
  const choices = equivalentWorkspaceChoices(
    service.ownerSnapshot(owner).workspaces,
  );
  assert.equal(choices.length, 2);
  assert.deepEqual(choices[0].policyIds, ["legacy-read", "settings-write"]);
  assert.deepEqual(
    service.ownerSnapshot(owner).environments,
    originalAttachment,
  );
  await service.close();
  service = await ProjectEnvironmentService.open(options);
  assert.equal(service.ownerSnapshot(owner).workspaces.length, 3);
  assert.deepEqual(
    service.ownerSnapshot(owner).environments,
    originalAttachment,
  );
  const repeated = await service.prepareFolderAccess(owner, {
    workspaceDirectory: workspace,
    access: "read_write",
  });
  assert.equal(repeated.policy.id, "legacy-read");
  assert.equal(service.ownerSnapshot(owner).workspaces.length, 3);
  const { groupWorkspaceChoices } =
    await import("../renderer/src/access/workspace-choices.ts");
  const { workspaceConfigurationKey, workspaceConfigurationDescription } =
    await import("../src/agents/workspace-identity.mts");
  const rendered = groupWorkspaceChoices(
    service
      .ownerSnapshot(owner)
      .workspaces.map((row) => ({
        policy: row.policy,
        label: row.workspace.path,
        description: workspaceConfigurationDescription(row),
        configurationKey: workspaceConfigurationKey(row),
      })),
  );
  assert.equal(rendered.length, 2);
  assert.deepEqual(rendered[0].policyIds, ["legacy-read", "settings-write"]);
  assert.notEqual(rendered[0].description, rendered[1].description);
});
