import test from "node:test";
import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  mkdir,
  realpath,
  rm,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FoundationStore } from "../src/agents/store.mts";
import { AgentFoundation } from "../src/agents/foundation.mts";
import { ProjectEnvironmentTemplateCatalogue } from "../src/agents/environment-templates.mts";
import { ProjectEnvironmentService } from "../src/agents/environments.mts";
import { createFoundationAgentTools } from "../src/agents/tools.mts";
import { inspectEnvironmentTemplate } from "../src/agents/environment-tool-inspector.mts";
import {
  runMacWorkspaceCommand,
  reconcileMacWorkspaceCommand,
  startMacWorkspaceProcess,
  inspectMacWorkspaceProcess,
  stopMacWorkspaceProcess,
} from "../src/access/workspace-executor.mts";

const owner = { type: "user", userId: "owner" };
const principal = { type: "owner", userId: "owner" };

test(
  "agent template update inbox, explicit preparation and restart retain exact applied state",
  { skip: process.platform !== "darwin", timeout: 20000 },
  async (t) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "crew127-lifecycle-")),
    );
    const controller = join(root, "controller"),
      workspace = join(root, "shared"),
      runtime = join(root, "runtime"),
      binaries = join(root, "tools");
    for (const path of [controller, workspace, binaries])
      await mkdir(path, { mode: 0o700 });
    await writeFile(
      join(binaries, "ffmpeg"),
      '#!/bin/sh\n[ "$1" = "-version" ] || exit 2\nprintf "ffmpeg version 7.1.2 fixture\\n"\n',
      { mode: 0o700 },
    );
    const marker = join(workspace, "never-automatic");
    let store,
      foundation,
      catalogue,
      environments,
      failAfterEnqueue = false;
    const gate = { run: async (fn) => fn() };
    let contextExecuteAllowed = true,
      contextReadAllowed = true,
      contextCalls = 0;
    const options = {
      directory: join(controller, "templates"),
      projectId: "project",
      ownerUserId: "owner",
      protectedDirectories: [controller],
      contextDirectory: runtime,
      listAgents: async () => store.snapshot().agents,
      inspect: (template) =>
        inspectEnvironmentTemplate(template, join(controller, "environments")),
      notify: async (notice) => {
        await foundation.sendInternal({
          id: notice.id,
          source: "preparation",
          sourceId: `template:${notice.id}`,
          recipientAgentId: notice.agentId,
          content: [
            {
              type: "text",
              text: `Template ${notice.templateRevision} changed; inspect environment_template_read and choose when to reconcile.`,
            },
          ],
        });
        if (failAfterEnqueue) {
          failAfterEnqueue = false;
          throw Error("Response lost after durable inbox write");
        }
      },
    };
    const open = async () => {
      store = await FoundationStore.open({
        directory: join(controller, "foundation"),
        projectId: "project",
        ownerUserId: "owner",
      });
      catalogue = await ProjectEnvironmentTemplateCatalogue.open(options);
      environments = await ProjectEnvironmentService.open({
        directory: join(controller, "environments"),
        protectedDirectories: [controller],
        projectId: "project",
        ownerUserId: "owner",
        admission: gate,
        runtimeDirectory: runtime,
        execute: runMacWorkspaceCommand,
        observeExecution: reconcileMacWorkspaceCommand,
        startExecution: startMacWorkspaceProcess,
        inspectExecution: inspectMacWorkspaceProcess,
        stopExecution: stopMacWorkspaceProcess,
        authorizePrivateContext: async (_caller, action) => {
          contextCalls++;
          if (action === "read" ? !contextReadAllowed : !contextExecuteAllowed)
            throw Error("Private context group capability revoked");
        },
        authorize: async (caller, _action, target) => {
          if (caller.agentId !== target) throw Error("Wrong resource owner");
        },
        verifyExecution: async (caller) => {
          if (!foundation.executionAllowed(caller))
            throw Error("Stale session");
        },
        noteExecutionAdmitted: async () => {},
        templateSource: {
          prepareContext: (agentId, input) =>
            catalogue.preparePrivateContext(agentId, input),
          resolvePreparation: (input) => catalogue.resolvePreparation(input),
          resolvePinned: (id, revision) =>
            catalogue.resolvePinned(id, revision),
          assignment: (id) => catalogue.assignment(id),
          inspect: (template) =>
            catalogue.inspect(owner, {
              templateId: template.id,
              templateRevision: template.revision,
            }),
        },
      });
      foundation = new AgentFoundation({
        store,
        runtime: {},
        access: {},
        authorization: {},
        broker: {},
        references: { validate: async () => true },
        configuration: async () => {
          throw Error("No native model launch in fixture");
        },
        admissionUsesFoundationBarrier: true,
        admission: gate,
        environments,
        // Inbox-only acceptance: no fabricated model turn or voice interaction.
        privateInputBlocked: () => true,
        environmentTemplates: {
          invoke: async (caller, action, input) => {
            if (action === "reconcile")
              await catalogue.reconcile(caller.agentId, input);
            if (action === "report")
              await catalogue.reportPreparation(caller.agentId, input);
            return {
              ...(await catalogue.agentSnapshot(caller.agentId)),
              appliedEnvironments: environments.templateState(caller.agentId),
            };
          },
        },
      });
    };
    const close = async () => {
      for (const operation of environments
        .ownerSnapshot(owner)
        .operations.filter((row) => row.action === "start"))
        for (const ref of operation.processEvidenceRefs) {
          const stopped = await stopMacWorkspaceProcess(
            join(controller, "environments"),
            ref,
          );
          assert.equal(
            stopped.processesSettled,
            true,
            "Fixture background must settle before cleanup",
          );
        }
      await catalogue.close();
      await environments.close();
      await store.close();
    };
    await open();
    t.after(async () => {
      await close();
      await rm(root, { recursive: true, force: true });
    });
    const agents = [];
    for (const name of ["Developer", "Marketing"])
      agents.push(
        await foundation.records.createAgent(principal, {
          profile: {
            name,
            pictureRef: null,
            personality: "",
            systemPrompt: "",
          },
          modelAccessId: "model",
          configRef: "runtime",
        }),
      );
    await store.update((state) => {
      for (const agent of state.agents) {
        agent.runtime.threadId = `thread-${agent.id}`;
        Object.assign(agent.runtime.session, {
          sessionId: `session-${agent.id}`,
          desiredState: "started",
          observedState: "started",
        });
      }
    });
    const caller = {
      projectId: "project",
      agentId: agents[0].id,
      sessionId: `session-${agents[0].id}`,
    };
    const tools = () => createFoundationAgentTools(foundation, caller);
    const draft = {
      name: "Media tools",
      description: "Existing approved tools",
      tools: [
        {
          name: "ffmpeg",
          versionRequirement: ">=7",
          versionArguments: ["-version"],
        },
      ],
      executableDirectories: [binaries],
      readableDirectories: [],
      environment: { TEMPLATE_MARK: "one" },
      capabilities: {
        network: false,
        packageDownloads: false,
        localhostPorts: [],
      },
      preparation: {
        instructions: "Agent chooses when to run setup",
        commands: [["/usr/bin/touch", marker]],
      },
    };
    const template = await catalogue.saveTemplate(owner, {
      id: null,
      expectedRevision: null,
      draft,
    });
    for (const agent of agents)
      await catalogue.assign(owner, {
        agentId: agent.id,
        expectedRevision: null,
        templateId: template.id,
        templateRevision: 1,
      });
    assert.equal(
      (await tools().call("environment_template_read", {})).preparationRequired,
      true,
    );
    contextExecuteAllowed = false;
    await assert.rejects(
      tools().call("environment_context_prepare", {
        requestId: "private-prepare",
        expectedAssignmentRevision: 1,
      }),
      /capability revoked/,
    );
    assert.equal(
      environments.ownerSnapshot(owner).workspaces.length,
      0,
      "Template assignment never supplies group execution authority",
    );
    contextExecuteAllowed = true;
    const privatePrepared = await tools().call("environment_context_prepare", {
      requestId: "private-prepare",
      expectedAssignmentRevision: 1,
    });
    assert.equal(privatePrepared.result.state, "prepared");
    const privateEnvironmentId = privatePrepared.environmentId;
    const repeatedPreparation = await tools().call(
      "environment_context_prepare",
      { requestId: "private-prepare", expectedAssignmentRevision: 1 },
    );
    assert.equal(repeatedPreparation.operationId, privatePrepared.operationId);
    let privateRequest = 0;
    const privateAction = (action, args) =>
      tools().call("environment_context_action", {
        action,
        requestId: `private-action-${++privateRequest}`,
        arguments: args,
      });
    const writeOwn = await privateAction("execute", {
      environmentId: privateEnvironmentId,
      command: [
        "/bin/sh",
        "-c",
        'printf "%s" "$TEMPLATE_MARK" > own-report.txt; ffmpeg -version',
      ],
    });
    assert.equal(writeOwn.result.exitCode, 0, JSON.stringify(writeOwn));
    assert.match(writeOwn.result.stdout, /ffmpeg version 7.1.2/);
    const noSharedAccess = await privateAction("execute", {
      environmentId: privateEnvironmentId,
      command: ["/usr/bin/touch", marker],
    });
    assert.notEqual(
      noSharedAccess.result.exitCode,
      0,
      "Private execution cannot write unrelated shared folders",
    );
    const noControllerRead = await privateAction("execute", {
      environmentId: privateEnvironmentId,
      command: [
        "/bin/cat",
        join(controller, "templates", "environment-templates.json"),
      ],
    });
    assert.notEqual(
      noControllerRead.result.exitCode,
      0,
      "Private execution cannot read controller state",
    );
    const otherCaller = {
      ...caller,
      agentId: agents[1].id,
      sessionId: `session-${agents[1].id}`,
    };
    const otherTools = createFoundationAgentTools(foundation, otherCaller);
    await otherTools.call("environment_context_prepare", {
      requestId: "private-other",
      expectedAssignmentRevision: 1,
    });
    const otherDirectory = environments.templateState(agents[1].id)[0]
      .preparation.privateContextDirectory;
    await assert.rejects(
      otherTools.call("environment_context_action", {
        action: "execute",
        requestId: "wrong-agent",
        arguments: {
          environmentId: privateEnvironmentId,
          command: ["/usr/bin/true"],
        },
      }),
      /current-self/,
    );
    const noOtherAgentRead = await privateAction("execute", {
      environmentId: privateEnvironmentId,
      command: ["/bin/ls", otherDirectory],
    });
    assert.notEqual(
      noOtherAgentRead.result.exitCode,
      0,
      "Other agent's private context remains unreadable",
    );
    const started = await privateAction("start", {
      environmentId: privateEnvironmentId,
      command: ["/bin/sleep", "30"],
    });
    assert.equal(started.result.state, "running");
    contextReadAllowed = false;
    await assert.rejects(
      privateAction("status", { operationId: started.operationId }),
      /capability revoked/,
    );
    contextReadAllowed = true;
    const liveStatus = await privateAction("status", {
      operationId: started.operationId,
    });
    assert.equal(liveStatus.observations[0].state, "running");
    contextExecuteAllowed = false;
    await assert.rejects(
      privateAction("execute", {
        environmentId: privateEnvironmentId,
        command: ["/usr/bin/true"],
      }),
      /capability revoked/,
    );
    await assert.rejects(
      privateAction("stop", { operationId: started.operationId }),
      /capability revoked/,
    );
    contextExecuteAllowed = true;
    const stopped = await privateAction("stop", {
      operationId: started.operationId,
    });
    assert.equal(stopped.result.processesSettled, true);
    assert.ok(
      contextCalls > 8,
      "Every private read/execute operation freshly checks group capability",
    );
    const context = (await tools().call("environment_template_read", {}))
      .privateContexts[0];
    await access(join(context.directory, "home"));
    assert.equal(
      environments
        .ownerSnapshot(owner)
        .workspaces.filter((row) => !row.privateContext).length,
      0,
      "Private contexts execute without any shared-folder grant",
    );
    assert.equal(
      (await tools().call("environment_template_read", {})).preparationRequired,
      true,
      "Verified tool preparation is not agent-reported project setup readiness",
    );
    await environments.approveWorkspace(
      owner,
      {
        policyId: "shared",
        workspaceDirectory: workspace,
        writable: true,
        executableDirectories: [],
      },
      null,
    );
    let request = 0;
    const invoke = (action, args) =>
      environments.invoke({
        caller,
        agentId: caller.agentId,
        requestId: `request-${++request}`,
        action,
        arguments: args,
      });
    const attached = await invoke("attach", { policyId: "shared" });
    const environmentId = attached.result.environmentId;
    const prepared = await invoke("prepare", {
      environmentId,
      expectedAssignmentRevision: 1,
    });
    assert.equal(prepared.result.state, "prepared");
    assert.equal(
      environments.templateState(caller.agentId)[0].preparation
        .privateContextDirectory,
      context.directory,
    );
    await assert.rejects(access(marker), { code: "ENOENT" });
    const executeMark = async () => {
      const result = await invoke("execute", {
        environmentId,
        command: ["/bin/sh", "-c", 'printf "%s" "$TEMPLATE_MARK"'],
      });
      assert.equal(result.result.exitCode, 0);
      return result.result.stdout;
    };
    assert.equal(await executeMark(), "one");
    await tools().call("environment_preparation_report", {
      expectedAssignmentRevision: 1,
      state: "prepared",
      summary: "Explicit fixture inspection; no project setup requested.",
    });
    assert.equal(
      (await tools().call("environment_template_read", {})).preparationRequired,
      false,
    );
    failAfterEnqueue = true;
    await catalogue.saveTemplate(owner, {
      id: template.id,
      expectedRevision: 1,
      draft: { ...draft, environment: { TEMPLATE_MARK: "two" } },
    });
    await catalogue.deliverNotifications().catch(() => {});
    const inboxBefore = store.snapshot().messages;
    assert.equal(
      inboxBefore.length,
      2,
      "Every affected agent receives one durable internal notice",
    );
    assert.ok(
      inboxBefore.every(
        (message) =>
          message.visibility === "private" &&
          message.delivery.state === "queued",
      ),
    );
    assert.ok(
      catalogue
        .ownerSnapshot(owner)
        .notifications.some((notice) => notice.enqueuedAt === null),
      "Lost enqueue response stays pending",
    );
    assert.equal(
      await executeMark(),
      "one",
      "Template edit never reconfigures prepared execution",
    );
    const updated = await tools().call("environment_template_read", {});
    assert.equal(updated.desiredTemplate.revision, 2);
    assert.equal(updated.assignment.templateRevision, 1);
    assert.equal(updated.preparationRequired, true);
    await close();
    await open();
    await catalogue.deliverNotifications();
    assert.equal(
      store.snapshot().messages.length,
      2,
      "Outbox replay reuses durable foundation intent IDs",
    );
    assert.ok(
      catalogue
        .ownerSnapshot(owner)
        .notifications.every((notice) => notice.enqueuedAt),
    );
    await tools().call("environment_template_reconcile", {
      expectedAssignmentRevision: 1,
      templateRevision: 2,
    });
    assert.equal(
      await executeMark(),
      "one",
      "Reconcile metadata keeps prior execution snapshot until explicit prepare",
    );
    assert.equal(
      (await tools().call("environment_template_read", {})).preparationRequired,
      true,
      "Old report cannot satisfy new assignment",
    );
    await invoke("prepare", { environmentId, expectedAssignmentRevision: 2 });
    assert.equal(await executeMark(), "two");
    const nextContext = environments
      .templateState(caller.agentId)
      .find((row) => row.environmentId === environmentId)
      .preparation.privateContextDirectory;
    assert.notEqual(nextContext, context.directory);
    await access(context.directory);
    await assert.rejects(access(marker), { code: "ENOENT" });
    const oldPrivateReport = await privateAction("execute", {
      environmentId: privateEnvironmentId,
      command: ["/bin/cat", "own-report.txt"],
    });
    assert.equal(
      oldPrivateReport.result.stdout,
      "one",
      "Private working files persist across controller restart/template change",
    );
    const privateV2 = await tools().call("environment_context_prepare", {
      requestId: "private-prepare-v2",
      expectedAssignmentRevision: 2,
    });
    assert.notEqual(
      privateV2.environmentId,
      privateEnvironmentId,
      "Explicit new revision creates a distinct private execution target",
    );
    const nextPrivateMark = await privateAction("execute", {
      environmentId: privateV2.environmentId,
      command: ["/bin/sh", "-c", 'printf "%s" "$TEMPLATE_MARK"'],
    });
    assert.equal(nextPrivateMark.result.stdout, "two");
    const history = store.snapshot();
    assert.equal(history.agents[0].runtime.threadId, `thread-${agents[0].id}`);
    assert.equal(history.messages.length, 2);
    const before = await readFile(
      join(controller, "templates", "environment-templates.json"),
      "utf8",
    );
    const stale = createFoundationAgentTools(foundation, {
      ...caller,
      sessionId: "stale",
    });
    await assert.rejects(
      stale.call("environment_template_reconcile", {
        expectedAssignmentRevision: 2,
        templateRevision: 1,
      }),
      /session required|current authenticated|execution/i,
    );
    assert.equal(
      await readFile(
        join(controller, "templates", "environment-templates.json"),
        "utf8",
      ),
      before,
    );
    t.diagnostic(
      "Real catalogue, durable foundation inbox, discoverable self tools and sandbox private execution/background receipts; no shared grant required; revocation and cross-context/controller denials verified. No native model turn, external account, customer repository or microphone used.",
    );
  },
);
