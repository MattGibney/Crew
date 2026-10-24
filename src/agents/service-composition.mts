import {
  ProjectResourceCatalogue,
  projectResources,
} from "../resources/catalogue.mjs";
import { createProjectResourceTools } from "../resources/tools.mjs";
import { combineAgentToolExtensions } from "./tool-extensions.mjs";
import {
  connectionIds,
  skillSelections,
  migrateLegacyAgentSkills,
} from "../access/group-access.mjs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type {
  ModelAccess,
  ProjectSkillSource,
  RuntimeBinding,
  CallerContext,
} from "./contracts.mjs";
import { FoundationStore } from "./store.mjs";
import { AgentFoundation } from "./foundation.mjs";
import { ProjectExecutionAdmission } from "./admission.mjs";
import { CodexAgentRuntime } from "./codex-runtime.mjs";
import { createFoundationSenderLookup } from "./composition.mjs";
import { NativeProcessRegistry } from "./native-processes.mjs";
import {
  startAgentMcpHost,
  type AgentMcpHost,
  type AgentToolExtension,
} from "./session-host.mjs";
import {
  ProjectEnvironmentService,
  type FolderAccessPreparation,
  type WorkspaceApproval,
} from "./environments.mjs";
import { ProjectEnvironmentTemplateCatalogue } from "./environment-templates.mjs";
import { inspectEnvironmentTemplate } from "./environment-tool-inspector.mjs";
import { withEnvironmentTemplateProvisioning } from "./environment-provisioning.mjs";
import {
  createPrimaryAgentVoice,
  type PrimaryAgentVoice,
} from "./voice-composition.mjs";
import { createOwnerApi } from "./owner-api.mjs";
import { VoiceTranscriptArtifacts } from "./voice-artifacts.mjs";
import { OwnerConnectionSetupService } from "../access/connection-setup.mjs";
import {
  AccessStore,
  ProjectAuthorizationService,
  EncryptedCredentialVault,
  CodexRuntimeAccessProvider,
  createAccessOwnerApi,
  runMacWorkspaceCommand,
  reconcileMacWorkspaceCommand,
  startMacWorkspaceProcess,
  inspectMacWorkspaceProcess,
  stopMacWorkspaceProcess,
  type CredentialEncryptionBackend,
} from "../access/index.mjs";
import {
  createGateway,
  createSupportedGatewayRegistry,
  TrustedServiceExecutor,
  GatewayOwnerConnectionVerifier,
} from "../gateway/index.mjs";

export const unifiedRuntimeDefaults = Object.freeze({
  modelAccessId: "crew-chatgpt",
  configRef: "crew.codex.broker-only.v1",
  mode: "restricted_bringup" as const,
});
export interface UnifiedApplicationOptions {
  stateDirectory: string;
  projectId: string;
  ownerUserId: string;
  projectName: string;
  nativeExecutable: string;
  vaultEncryption: CredentialEncryptionBackend;
  skills: ProjectSkillSource & { subscribe?(listener: () => void): () => void };
  /** Project skill authoring checks the same authorization service. */
  agentTools?(context: {
    authorization: ProjectAuthorizationService;
    runAuthorized<T>(
      caller: CallerContext,
      action: "skills.read" | "skills.write" | "browser.control",
      operation: () => Promise<T>,
    ): Promise<T>;
  }): AgentToolExtension;
}

/** The single production composition used by desktop. No synthetic runtime,
 * policy override, provider secret or model credential is accepted in options. */
export async function startUnifiedApplication(
  options: UnifiedApplicationOptions,
) {
  if (
    !isAbsolute(options.stateDirectory) ||
    !isAbsolute(options.nativeExecutable)
  )
    throw new Error(
      "Crew needs trusted absolute state and native executable paths.",
    );
  await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(options.stateDirectory);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    rootStat.mode & 0o077 ||
    rootStat.uid !== process.getuid?.()
  )
    throw new Error("Unified Crew state must be private and owner controlled.");
  const root = await realpath(options.stateDirectory);
  const store = await FoundationStore.open({
    directory: join(root, "foundation"),
    projectId: options.projectId,
    ownerUserId: options.ownerUserId,
  });
  let accessStore: AccessStore | undefined;
  let nativeAccess: CodexRuntimeAccessProvider | undefined;
  let mcp: AgentMcpHost | undefined;
  let foundation: AgentFoundation | undefined;
  let environments: ProjectEnvironmentService | undefined;
  let environmentTemplates: ProjectEnvironmentTemplateCatalogue | undefined;
  let resources: ProjectResourceCatalogue | undefined;
  let voice: PrimaryAgentVoice | undefined;
  let voiceArtifacts: VoiceTranscriptArtifacts | undefined;
  let voiceArtifactRevision = 0;
  const voiceArtifactListeners = new Set<() => void>();
  const voiceArtifactWarnings = new Map<string, string>();
  const failedVoiceArtifactCalls = new Set<string>();
  const voiceArtifactKey = (
    binding: Pick<RuntimeBinding, "agentId" | "threadId">,
  ) => JSON.stringify([binding.agentId, binding.threadId]);
  const voiceArtifactsChanged = () => {
    voiceArtifactRevision++;
    for (const listener of voiceArtifactListeners) {
      try {
        listener();
      } catch {
        /* Owner projection only. */
      }
    }
  };
  let closing = false;
  let closeReservationId: string | undefined;
  let closeStarted = false;
  const closedSteps = new Set<string>();
  const cleanupSubscriptions: (() => void)[] = [];
  try {
    const accessDirectory = join(root, "access");
    const accessExists = await lstat(accessDirectory).then(
      () => true,
      (error) => {
        if (error?.code === "ENOENT") return false;
        throw error;
      },
    );
    accessStore = accessExists
      ? await AccessStore.open(
          accessDirectory,
          options.projectId,
          options.ownerUserId,
        )
      : await AccessStore.create(
          accessDirectory,
          options.projectId,
          options.ownerUserId,
        );
    const vault = new EncryptedCredentialVault({
      directory: join(root, "vault"),
      projectId: options.projectId,
      ownerUserId: options.ownerUserId,
      encryption: options.vaultEncryption,
    });
    const gate = new ProjectExecutionAdmission();
    let gateway: Awaited<ReturnType<typeof createGateway>>;
    const authorization = new ProjectAuthorizationService(
      accessStore,
      {
        // Raw identity facts only: never recurse into access while it holds a transaction.
        getAgent: async (id) =>
          store.snapshot().agents.find((agent) => agent.id === id) ?? null,
        getJob: async (id) =>
          store.snapshot().jobs.find((job) => job.id === id) ?? null,
      },
      {
        hasSkill: async (id) =>
          (await options.skills.list()).some(
            (skill) => skill.id === id && skill.projectId === options.projectId,
          ),
        hasOperation: async (connectionId, operation) =>
          gateway?.catalogue.hasOperation(connectionId, operation) ?? false,
      },
    );
    await accessStore.transaction((state) =>
      migrateLegacyAgentSkills(state, store.snapshot().agents),
    );
    const registry = createSupportedGatewayRegistry();
    gateway = await createGateway({
      privateDirectory: join(root, "gateway"),
      authorization,
      vault,
      connections: {
        get: (id) => authorization.getConnection(id),
        listAssigned: (caller) => authorization.listAssignedConnections(caller),
        allowedOperations: (caller, id) =>
          authorization.allowedOperations(caller, id),
      },
      resolveConfiguration: registry.resolve,
      validateCaller: async (caller, jobId) =>
        !!foundation?.executionAllowed(caller) &&
        (jobId === null ||
          store
            .snapshot()
            .jobs.some(
              (job) =>
                job.id === jobId &&
                job.assignment.assignedToAgentId === caller.agentId,
            )),
      admission: {
        async run(invocation, permit, dispatch) {
          // Durable broker attempts exist before entry. No remote I/O or approval
          // waits occur under this mutex. Final reservation sees pending attempts.
          const admitted = await gate.run(async () => {
            if (closing || !foundation?.executionAllowed(invocation.caller))
              return false;
            if ((await authorization.redeem(permit)).state !== "allowed")
              return false;
            await foundation.noteExecutionAdmitted(invocation.caller);
            return true;
          });
          if (!admitted) return { state: "denied" as const };
          return { state: "admitted" as const, result: await dispatch() };
        },
      },
    });
    const owner = { type: "user" as const, userId: options.ownerUserId };
    const agentContextRoot = join(
      homedir(),
      ".crew",
      "workspace-caches",
      createHash("sha256").update(root).digest("hex").slice(0, 24),
    );
    environmentTemplates = await ProjectEnvironmentTemplateCatalogue.open({
      directory: join(root, "environment-templates"),
      projectId: options.projectId,
      ownerUserId: options.ownerUserId,
      protectedDirectories: [root],
      listAgents: async () => store.snapshot().agents,
      contextDirectory: agentContextRoot,
      notify: async (notice) => {
        if (!foundation)
          throw new Error("Foundation notification ingress unavailable.");
        const queued = await foundation.sendInternal(
          {
            id: notice.id,
            source: "preparation",
            sourceId: `environment-template:${notice.id}`,
            recipientAgentId: notice.agentId,
            content: [
              {
                type: "text",
                text: `Your environment template changed to revision ${notice.templateRevision}. Read environment_template_read to inspect the exact updated definition and your preparation-required state. Decide when/how to reconcile or rebuild with environment_template_reconcile, environment_action prepare, and existing project tools. No setup ran and no active execution was reconfigured. Report readiness or blockers with environment_preparation_report. This notification does not assign a task or prescribe workflow.`,
              },
            ],
          },
          async () =>
            store
              .snapshot()
              .agents.some(
                (agent) =>
                  agent.id === notice.agentId && agent.archivedAt === null,
              ),
        );
        if (!queued)
          throw new Error(
            "Template recipient is unavailable; notice remains pending.",
          );
      },
      inspect: (template) =>
        inspectEnvironmentTemplate(template, join(root, "environments")),
    });
    environments = await ProjectEnvironmentService.open({
      directory: join(root, "environments"),
      protectedDirectories: [root],
      projectId: options.projectId,
      ownerUserId: options.ownerUserId,
      admission: gate,
      execute: runMacWorkspaceCommand,
      observeExecution: reconcileMacWorkspaceCommand,
      startExecution: startMacWorkspaceProcess,
      inspectExecution: inspectMacWorkspaceProcess,
      stopExecution: stopMacWorkspaceProcess,
      runtimeDirectory: agentContextRoot,
      templateSource: {
        prepareContext: (agentId, input) =>
          environmentTemplates!.preparePrivateContext(agentId, input),
        resolvePreparation: (input) =>
          environmentTemplates!.resolvePreparation(input),
        resolvePinned: (id, revision) =>
          environmentTemplates!.resolvePinned(id, revision),
        assignment: (agentId) => environmentTemplates!.assignment(agentId),
        inspect: (template) =>
          environmentTemplates!.inspect(owner, {
            templateId: template.id,
            templateRevision: template.revision,
          }),
      },
      verifyExecution: async (caller) => {
        if (closing || !foundation?.executionAllowed(caller))
          throw new Error("This native session cannot admit workspace work.");
      },
      verifyOwnerExecution: async () => {
        if (closing || store.snapshot().reservation)
          throw new Error("Execution is reserved.");
      },
      noteExecutionAdmitted: (caller) =>
        foundation!.noteExecutionAdmitted(caller),
      authorizePrivateContext: async (caller, action) => {
        await foundation!.records.authorize(
          { type: "agent", caller },
          action === "read" ? "environments.read" : "environments.execute",
          { type: "agent", agentId: caller.agentId },
        );
      },
      authorize: async (caller, action, agentId, policy) => {
        if (
          !store
            .snapshot()
            .agents.some(
              (agent) =>
                agent.id === agentId &&
                agent.projectId === options.projectId &&
                !agent.archivedAt,
            )
        )
          throw new Error(
            "Workspace target is not an available project agent.",
          );
        await foundation!.records.authorize(
          { type: "agent", caller },
          action === "prepare" || action === "start" || action === "stop"
            ? "environments.execute"
            : action === "status"
              ? "environments.read"
              : `environments.${action}`,
          action === "create"
            ? { type: "project" }
            : { type: "agent", agentId },
        );
        const access = await authorization.snapshot(owner);
        const assignment = await authorization.assignment(caller.agentId);
        const current = access.environmentPolicies.find(
          (row) => row.id === policy.id,
        );
        if (
          !current ||
          current.revision !== policy.revision ||
          current.enforcementConfigRef !== policy.enforcementConfigRef ||
          !access.groups.some(
            (group) =>
              assignment?.permissionGroupIds.includes(group.id) &&
              group.grants.environmentPolicyIds.includes(policy.id),
          )
        )
          throw new Error(
            "No current group grants this exact owner-approved workspace policy.",
          );
      },
    });
    const processes = new NativeProcessRegistry(join(root, "native-processes"));
    const modelAccess: ModelAccess = {
      id: unifiedRuntimeDefaults.modelAccessId,
      runtime: "codex",
      authentication: {
        method: "chatgpt-subscription",
        signInRef: "crew-native-chatgpt",
      },
    };
    nativeAccess = await CodexRuntimeAccessProvider.open({
      directory: join(root, "native"),
      projectId: options.projectId,
      executable: options.nativeExecutable,
      runtimeConfigRef: unifiedRuntimeDefaults.configRef,
      gatewayFor: async (caller) => {
        if (!mcp)
          throw new Error("Authenticated native tool host is unavailable.");
        const binding = await mcp.bind(caller);
        return {
          url: binding.gatewayUrl,
          foundationUrl: binding.foundationUrl,
          bearerToken: binding.bearerToken,
          bindingRef: binding.bindingRef,
          release: () => mcp!.revoke(caller),
        };
      },
      resolveSkills: (skills) =>
        Promise.all(
          skills.map(async (skill) => ({
            id: skill.id,
            revision: skill.revision,
            nativePath: (await options.skills.resolve(skill.id, skill.revision))
              .nativePath,
          })),
        ),
    });
    const retained = (binding: RuntimeBinding) =>
      store
        .snapshot()
        .agents.some(
          (agent) =>
            agent.id === binding.agentId &&
            agent.projectId === binding.projectId &&
            agent.runtime.threadId === binding.threadId,
        );
    const runtime = new CodexAgentRuntime({
      resolveLaunch: nativeAccess.resolveLaunch,
      resolveHistoryLaunch: async (binding) =>
        retained(binding)
          ? nativeAccess!.resolveHistoryLaunch(binding)
          : {
              state: "blocked",
              error: {
                code: "identity_mismatch",
                message:
                  "Retained native history identity does not match this project.",
              },
            },
      lookupSender: createFoundationSenderLookup(store),
      readSubscriptionUsage: () => nativeAccess!.subscriptionUsage(),
      onProcessStarted: (caller, pid) => processes.recordStarted(caller, pid),
    });
    foundation = new AgentFoundation({
      store,
      runtime,
      access: nativeAccess,
      authorization,
      broker: gateway.broker,
      provisioning: withEnvironmentTemplateProvisioning(
        authorization,
        environmentTemplates,
        owner,
      ),
      admission: gate,
      admissionUsesFoundationBarrier: true,
      environments,
      environmentTemplates: {
        invoke: async (caller, action, input) => {
          const allowed =
            action === "read"
              ? []
              : action === "reconcile"
                ? ["expectedAssignmentRevision", "templateRevision"]
                : ["expectedAssignmentRevision", "state", "summary"];
          if (Object.keys(input).some((key) => !allowed.includes(key)))
            throw new Error("Unknown template lifecycle argument.");
          if (action === "reconcile")
            await environmentTemplates!.reconcile(
              caller.agentId,
              input as unknown as Parameters<
                ProjectEnvironmentTemplateCatalogue["reconcile"]
              >[1],
            );
          if (action === "report")
            await environmentTemplates!.reportPreparation(
              caller.agentId,
              input as unknown as Parameters<
                ProjectEnvironmentTemplateCatalogue["reportPreparation"]
              >[1],
            );
          return JSON.parse(
            JSON.stringify({
              ...(await environmentTemplates!.agentSnapshot(caller.agentId)),
              appliedEnvironments: environments!.templateState(caller.agentId),
            }),
          );
        },
      },
      privateInputBlocked: (binding) =>
        voice?.privateInputBlocked(binding) ?? false,
      executionSettlement: async (caller) => {
        const local = environments!.settlement(caller);
        if (
          local.inFlightOperationIds.length ||
          local.uncertainOperationIds.length
        )
          return {
            settled: false,
            detail:
              "Workspace execution or retained process evidence requires settlement.",
          };
        return caller
          ? { settled: true, detail: "Session workspace work is settled." }
          : (voice?.settlement() ?? {
              settled: true,
              detail: "No realtime activity.",
            });
      },
      confirmVoiceExit: (binding) =>
        voice?.confirmNativeExit(binding) ?? Promise.resolve(),
      confirmNativeExit: (caller) => processes.confirmExited(caller),
      references: {
        async validate(kind, id, projectId) {
          if (projectId !== options.projectId) return false;
          if (kind === "modelAccess")
            return id === unifiedRuntimeDefaults.modelAccessId;
          if (kind === "runtimeConfig")
            return id === unifiedRuntimeDefaults.configRef;
          if (kind === "skill")
            return (await options.skills.list()).some(
              (skill) => skill.id === id && skill.projectId === projectId,
            );
          return !!(await authorization.getConnection(id));
        },
      },
      async configuration(agent) {
        const access = await authorization.snapshot({
          type: "user",
          userId: options.ownerUserId,
        });
        const groupIds =
          access.assignments.find((row) => row.agentId === agent.id)
            ?.permissionGroupIds ?? [];
        const serviceIds = connectionIds(access, groupIds);
        const available = await options.skills.list();
        const skills = skillSelections(access, groupIds)
          .filter((skill) => skill.enabled)
          .map((selection) => {
            const skill = available.find(
              (item) => item.id === selection.skillId,
            );
            if (!skill)
              throw new Error("An enabled project skill is unavailable.");
            return skill;
          });
        if (
          agent.runtime.modelAccessId !== modelAccess.id ||
          agent.runtime.configRef !== unifiedRuntimeDefaults.configRef
        )
          throw new Error("Saved model/runtime configuration is unavailable.");
        return {
          modelAccess,
          configuration: {
            profile: agent.profile,
            skills,
            permissionGroups: access.groups
              .filter((group) => groupIds.includes(group.id))
              .map(({ id, revision }) => ({ id, revision })),
            serviceConnections: access.connections
              .filter((connection) => serviceIds.includes(connection.id))
              .map(({ id, revision }) => ({ id, revision })),
            runtimeConfig: {
              id: unifiedRuntimeDefaults.configRef,
              revision: 1,
            },
          },
        };
      },
      requestPreparation: async (binding, reason, preparationId) => {
        await foundation!.sendInternal({
          id: `prepare-${preparationId}-${binding.agentId}`,
          source: "preparation",
          sourceId: preparationId,
          recipientAgentId: binding.agentId,
          content: [
            {
              type: "text",
              text: `The owner requested preparation for ${reason}. Preparation identity: ${preparationId}. Preserve the continuation you need, then report current readiness using preparation_readiness. Ordinary communication remains available.`,
            },
          ],
        });
      },
    });
    await foundation.recover();
    await environmentTemplates.deliverNotifications().catch(() => {});
    // The foundation writer lock owns this artifact store's entire lifetime.
    // Damage to optional voice display evidence must not hide existing agents.
    try {
      voiceArtifacts = await VoiceTranscriptArtifacts.open({
        directory: join(root, "voice-artifacts"),
        projectId: options.projectId,
        ownerUserId: options.ownerUserId,
      });
    } catch {
      /* Owner reads surface unavailable recovery explicitly. */
    }
    voice = createPrimaryAgentVoice({
      ownerUserId: options.ownerUserId,
      authenticatedUserId: options.ownerUserId,
      runtime,
      admission: gate,
      currentPrimaryBinding: () => {
        const state = store.snapshot();
        const agent = state.agents.find(
          (row) =>
            row.id ===
            (state.projectSettings.contactAgentId ??
              state.projectSettings.primaryAgentId),
        );
        return agent?.runtime.threadId && agent.runtime.session.sessionId
          ? {
              projectId: agent.projectId,
              agentId: agent.id,
              sessionId: agent.runtime.session.sessionId,
              threadId: agent.runtime.threadId,
            }
          : null;
      },
      executionAllowed: (binding) =>
        !closing && foundation!.executionAllowed(binding),
      publicVoiceAllowed: (binding) =>
        !closing && foundation!.publicVoiceAllowed(binding),
      noteExecutionAdmitted: (binding) =>
        foundation!.noteExecutionAdmitted(binding),
      recordPublicVoiceTurn: (binding, input) =>
        foundation!.recordPublicVoiceTurn(binding, input),
      flush: () => foundation!.flush(),
      recordVoiceTranscript: async (record) => {
        const callKey = JSON.stringify([
          record.binding.agentId,
          record.binding.threadId,
          record.callId,
        ]);
        if (failedVoiceArtifactCalls.has(callKey)) return;
        try {
          if (!voiceArtifacts)
            throw new Error("Unavailable voice artifact storage.");
          await voiceArtifacts.record(record);
        } catch {
          failedVoiceArtifactCalls.add(callKey);
          voiceArtifactWarnings.set(
            voiceArtifactKey(record.binding),
            "Some voice transcript text could not be saved. The saved call may be incomplete.",
          );
          // Retain an honest terminal marker where storage still permits it;
          // later calls remain independent and audio cleanup stays available.
          await voiceArtifacts
            ?.closeCall(record.binding, record.callId, true)
            .catch(() => {});
        } finally {
          voiceArtifactsChanged();
        }
      },
      closeVoiceTranscript: async (binding, callId) => {
        try {
          if (!voiceArtifacts)
            throw new Error("Unavailable voice artifact storage.");
          await voiceArtifacts.closeCall(
            binding,
            callId,
            failedVoiceArtifactCalls.has(
              JSON.stringify([binding.agentId, binding.threadId, callId]),
            ),
          );
        } catch {
          voiceArtifactWarnings.set(
            voiceArtifactKey(binding),
            "Voice transcript closure could not be saved. Its completion state is unavailable.",
          );
        } finally {
          voiceArtifactsChanged();
        }
      },
    });
    const publishPolicy = async (policyId: string) => {
      const workspace = environments!
        .ownerSnapshot(owner)
        .workspaces.find((row) => row.policy.id === policyId);
      if (!workspace)
        throw new Error("Unknown owner-approved workspace policy.");
      const saved = (
        await authorization.snapshot(owner)
      ).environmentPolicies.find((row) => row.id === policyId);
      if (
        saved?.revision === workspace.policy.revision &&
        saved.enforcementConfigRef === workspace.policy.enforcementConfigRef
      )
        return workspace;
      if ((saved?.revision ?? 0) + 1 !== workspace.policy.revision)
        throw new Error(
          "Workspace policy revisions require explicit owner reconciliation.",
        );
      const published = await authorization.saveEnvironmentPolicy(
        owner,
        workspace.policy,
        saved?.revision ?? null,
      );
      if (published.revision !== workspace.policy.revision)
        throw new Error("Workspace policy changed while publishing.");
      return workspace;
    };
    const environmentOwnerApi = {
      snapshot: () => environments!.ownerSnapshot(owner),
      templates: {
        snapshot: () => environmentTemplates!.ownerSnapshot(owner),
        save: (
          input: Parameters<
            ProjectEnvironmentTemplateCatalogue["saveTemplate"]
          >[1],
        ) => {
          if (closing) throw new Error("Crew is closing.");
          return environmentTemplates!.saveTemplate(owner, input);
        },
        assign: (
          input: Parameters<ProjectEnvironmentTemplateCatalogue["assign"]>[1],
        ) => {
          if (closing) throw new Error("Crew is closing.");
          return environmentTemplates!.assign(owner, input);
        },
        inspect: async (
          input: Parameters<ProjectEnvironmentTemplateCatalogue["inspect"]>[1],
        ) => {
          if (closing) throw new Error("Crew is closing.");
          return environments!.inspectTemplate(owner, input);
        },
      },
      async prepareFolderAccess(input: FolderAccessPreparation) {
        if (closing) throw new Error("Crew is closing.");
        const prepared = await environments!.prepareFolderAccess(owner, input);
        if (prepared.policy) {
          const published = await publishPolicy(prepared.policy.id);
          if (
            published.policy.revision !== prepared.policy.revision ||
            published.policy.enforcementConfigRef !==
              prepared.policy.enforcementConfigRef
          )
            throw new Error("Folder access changed while preparing it.");
        }
        return prepared;
      },
      async approveWorkspace(
        input: WorkspaceApproval,
        expectedRevision: number | null,
      ) {
        if (closing) throw new Error("Crew is closing.");
        const current = environments!
          .ownerSnapshot(owner)
          .workspaces.find((row) => row.policy.id === input.policyId);
        if (current) await publishPolicy(current.policy.id);
        const workspace = await environments!.approveWorkspace(
          owner,
          input,
          expectedRevision,
        );
        await publishPolicy(workspace.policy.id);
        return workspace;
      },
      publishPolicy,
      reconcileOperation: (operationId: string) =>
        environments!.reconcileOperation(owner, operationId),
      // Read-only evidence stays available for failed-project Quit/recovery.
      inspectOperation: (operationId: string) =>
        environments!.inspectOperation(owner, operationId),
    };
    resources = await ProjectResourceCatalogue.open(
      join(root, "resources"),
      options.projectId,
    );
    const resourceList = async (caller?: CallerContext) => {
      const access = await authorization.snapshot(owner);
      const assigned = caller
        ? await authorization.accessFor(caller.agentId)
        : null;
      return projectResources({
        references: resources!.list(),
        workspaces: environments!
          .ownerSnapshot(owner)
          .workspaces.filter((row) => !row.privateContext),
        connections: assigned
          ? access.connections.filter((connection) =>
              assigned.serviceConnectionIds.includes(connection.id),
            )
          : access.connections,
        ...(assigned
          ? {
              groups: access.groups.filter((group) =>
                assigned.permissionGroupIds.includes(group.id),
              ),
            }
          : {}),
      });
    };
    const resourceTools = createProjectResourceTools({
      run: (caller, operation) =>
        gate.run(async () => {
          if (closing || !foundation!.executionAllowed(caller))
            throw Error("This native session cannot inspect resources.");
          await foundation!.records.authorize(
            { type: "agent", caller },
            "resources.read",
            { type: "project" },
          );
          return operation();
        }),
      list: (caller) => resourceList(caller),
      subscribe: (listener) => resources!.subscribe(listener),
    });
    const suppliedTools = options.agentTools?.({
      authorization,
      runAuthorized: (caller, action, operation) =>
        gate.run(async () => {
          if (closing || !foundation!.executionAllowed(caller))
            throw new Error("This native session cannot admit tool work.");
          await foundation!.records.authorize(
            { type: "agent", caller },
            action,
            { type: "project" },
          );
          if (action === "skills.write" || action === "browser.control")
            await foundation!.noteExecutionAdmitted(caller);
          return operation();
        }),
    });
    const additionalTools = combineAgentToolExtensions([
      resourceTools,
      ...(suppliedTools ? [suppliedTools] : []),
    ]);
    mcp = await startAgentMcpHost({
      privateDirectory: join(root, "native-transport"),
      foundation,
      broker: gateway.broker,
      additionalTools,
    });
    if (additionalTools?.subscribe)
      cleanupSubscriptions.push(
        additionalTools.subscribe(() => {
          void mcp?.refreshTools();
        }),
      );
    cleanupSubscriptions.push(
      authorization.subscribe(() => {
        void mcp?.refreshTools();
      }),
    );
    if (options.skills.subscribe)
      cleanupSubscriptions.push(
        options.skills.subscribe(() => {
          void mcp?.refreshTools();
        }),
      );
    const baseOwnerApi = createOwnerApi(
      {
        foundation,
        projectName: options.projectName,
        defaultModelAccessId: modelAccess.id,
        defaultRuntimeConfigRef: unifiedRuntimeDefaults.configRef,
        voiceArtifacts: {
          revision: () => voiceArtifactRevision,
          subscribe: (listener) => {
            voiceArtifactListeners.add(listener);
            return () => {
              voiceArtifactListeners.delete(listener);
            };
          },
          read: async (agentId, threadId, cursor) => {
            try {
              if (!voiceArtifacts)
                throw new Error("Unavailable voice artifact storage.");
              const page = await voiceArtifacts.list(agentId, threadId, cursor);
              return {
                state: "acknowledged",
                value: {
                  ...page,
                  warning:
                    voiceArtifactWarnings.get(
                      voiceArtifactKey({ agentId, threadId }),
                    ) ?? null,
                },
              };
            } catch {
              return {
                state: "failed",
                error: {
                  code: "runtime_error",
                  message:
                    "Saved voice transcripts could not be read. Existing native chat history has been retained.",
                },
              };
            }
          },
        },
        catalog: async () => ({
          skills: await options.skills.list(),
          serviceConnections: (
            await authorization.snapshot({
              type: "user",
              userId: options.ownerUserId,
            })
          ).connections.map(
            ({
              id,
              projectId,
              name,
              service,
              identity,
              observedState,
              lastVerifiedAt,
            }) => ({
              id,
              projectId,
              name,
              service,
              identity,
              observedState,
              lastVerifiedAt,
            }),
          ),
        }),
      },
      options.ownerUserId,
    );
    const ownerApi = {
      snapshot: async () => ({
        ...(await baseOwnerApi.snapshot()),
        setupDefaults: unifiedRuntimeDefaults,
        projectResources: await resourceList(),
      }),
      command: async (name: string, args: unknown) => {
        if (closing) throw new Error("Crew is closing.");
        if (name === "resources.list") return resourceList();
        if (name === "resources.saveReference") {
          if (!args || typeof args !== "object" || Array.isArray(args))
            throw Error("Reference fields are required.");
          return resources!.save(
            args as Parameters<ProjectResourceCatalogue["save"]>[0],
          );
        }
        return baseOwnerApi.command(name, args);
      },
      subscribe(listener: (event: unknown) => void) {
        const stops = [
          baseOwnerApi.subscribe(listener),
          authorization.subscribe(() => listener({ kind: "changed" })),
          resources!.subscribe(() => listener({ kind: "changed" })),
        ];
        if (options.skills.subscribe)
          stops.push(
            options.skills.subscribe(() => listener({ kind: "changed" })),
          );
        stops.push(
          environments!.subscribe(() => listener({ kind: "changed" })),
          environmentTemplates!.subscribe(() => listener({ kind: "changed" })),
        );
        return () => stops.forEach((stop) => stop());
      },
    };
    let connectionSetup: OwnerConnectionSetupService;
    const draftConnections = {
      get: async (id: string) => connectionSetup.candidate(id),
      listAssigned: async () => [], // Drafts are never exposed to runtime agents.
    };
    const draftExecutor = new TrustedServiceExecutor({
      authorization,
      vault,
      connections: draftConnections,
      resolveConfiguration: registry.resolve,
      privateDirectory: join(root, "gateway", "owner-verification"),
      admission: { run: async () => ({ state: "denied" as const }) },
      canDispatch: async () => false,
    });
    const connectionVerifier = new GatewayOwnerConnectionVerifier({
      vault,
      connections: draftConnections,
      registry,
      prepareCredential: (connection, revision) =>
        draftExecutor.prepareOwnerCredential(connection, revision),
      discoverCapabilities: (connection, options) =>
        draftExecutor.discoverCapabilities(connection, options),
    });
    connectionSetup = new OwnerConnectionSetupService({
      store: accessStore,
      vault,
      projectId: options.projectId,
      ownerUserId: options.ownerUserId,
      setupChoices: async () => registry.setupChoices(),
      listAgents: async () => store.snapshot().agents,
      verify: (connection, revision, signal) => {
        if (closing || connection.authentication.method !== "token")
          throw new Error("Crew cannot verify this connection now.");
        return connectionVerifier.verify(
          connection,
          { credentialRef: connection.authentication.credentialRef, revision },
          { signal },
        );
      },
    });
    const accessOwnerApi = createAccessOwnerApi(
      {
        authorization,
        vault,
        projectId: options.projectId,
        ownerUserId: options.ownerUserId,
        connectionSetup,
        rememberVerifiedConnection: async (id) => {
          const evidence = await connectionSetup.savedEvidence(id);
          if (evidence)
            gateway.catalogue.rememberVerified(
              evidence.connection,
              evidence.capabilities,
            );
        },
        runtimeDefaults: unifiedRuntimeDefaults,
        listAgents: () => foundation!.agentViews(),
        listSkills: () => options.skills.list(),
        resolveEnvironmentTemplate: async (pin) => {
          environmentTemplates!.resolvePinned(pin.id, pin.revision);
        },
        setupChoices: async () => registry.setupChoices(),
        catalogueSnapshot: (connection) =>
          gateway.catalogue.projection(connection),
        verifyConnection: async (id) => {
          const connection = await authorization.getConnection(id);
          if (!connection) throw new Error("Connection unavailable.");
          registry.assertConnection(connection);
          await gateway.catalogue.refresh(connection);
        },
      },
      options.ownerUserId,
    );
    return {
      foundation,
      authorization,
      gateway,
      ownerApi,
      accessOwnerApi,
      environmentOwnerApi,
      runtime,
      voice,
      subscription: {
        status: () => nativeAccess!.subscriptionStatus(),
        usage: () => runtime.readSubscriptionUsage(),
        subscribeUsage: (
          listener: Parameters<typeof runtime.subscribeSubscriptionUsage>[0],
        ) => runtime.subscribeSubscriptionUsage(listener),
        beginSignIn: () => nativeAccess!.beginSignIn(),
        cancelSignIn: () => nativeAccess!.cancelSignIn(),
      },
      setupDefaults: unifiedRuntimeDefaults,
      beginQuit() {
        foundation!.beginQuit();
        runtime.beginQuit();
      },
      async closeForQuit(): Promise<void> {
        foundation!.beginQuit();
        for (const stop of cleanupSubscriptions) stop();
        // Record uncertainty before closing transports. A lost acknowledgement
        // must not be written as stopped, or erase retained active-turn evidence.
        await store.update((state) => {
          for (const agent of state.agents) {
            if (agent.runtime.session.observedState === "stopped") continue;
            agent.runtime.session.desiredState = "stopped";
            agent.runtime.session.observedState = "unknown";
          }
        });
        await Promise.allSettled([
          runtime.closeForQuit(),
          voice!.dispose(),
          mcp!.close(),
        ]);
        // Keep journals, native history, credentials and environment receipts.
        // Environment commands are not killed by closing the desktop app.
        await Promise.allSettled([
          voiceArtifacts!.dispose(),
          foundation!.dispose(),
        ]);
      },
      async close(reservationId?: string): Promise<void> {
        if (closing) throw new Error("Crew close is already in progress.");
        const state = store.snapshot();
        if (closeStarted && reservationId !== closeReservationId)
          throw new Error("Retry the exact retained shutdown reservation.");
        if (
          !closedSteps.has("resources") &&
          (state.reservation ||
            state.agents.some(
              (agent) => agent.runtime.session.observedState !== "stopped",
            )) &&
          (!reservationId || state.reservation?.id !== reservationId)
        )
          throw new Error(
            "Prepare and reserve this project before closing active native sessions.",
          );
        closing = true;
        closeStarted = true;
        closeReservationId = reservationId;
        try {
          if (!closedSteps.has("resources")) {
            const local = environments!.settlement();
            if (
              local.inFlightOperationIds.length ||
              local.uncertainOperationIds.length ||
              !voice!.settlement().settled
            )
              throw new Error(
                "Workspace or voice activity must settle before closing this project.",
              );
            for (const agent of store.snapshot().agents) {
              const result = await foundation!.stop(agent.id);
              if (result.state !== "acknowledged") {
                // An earlier Stop may have lost its acknowledgement after exit.
                // Existing recovery proves the exact owned process exited and all
                // activity settled; it never signals or launches a process.
                const recovered = await foundation!.recoverSession(
                  { type: "owner", userId: options.ownerUserId },
                  agent.id,
                );
                if (recovered.state !== "acknowledged")
                  throw new Error(result.error.message);
              }
            }
            const finishStep = async (
              name: string,
              run: () => Promise<void>,
            ) => {
              if (closedSteps.has(name)) return;
              await run();
              closedSteps.add(name);
            };
            await finishStep("subscriptions", async () => {
              for (const stop of cleanupSubscriptions) stop();
            });
            await finishStep("voice", () => voice!.dispose());
            await finishStep("voiceArtifacts", async () => {
              await voiceArtifacts?.dispose();
            });
            await finishStep("mcp", () => mcp!.close());
            await finishStep("nativeAccess", () => nativeAccess!.close());
            await finishStep("environments", () => environments!.close());
            await finishStep("environmentTemplates", () =>
              environmentTemplates!.close(),
            );
            await finishStep("connectionSetup", () => connectionSetup.close());
            await finishStep("accessStore", () => accessStore!.close());
            await finishStep("projectResources", () => resources!.close());
            closedSteps.add("resources");
          }
          await foundation!.dispose(reservationId);
        } catch (error) {
          closing = false;
          throw error;
        }
      },
    };
  } catch (error) {
    for (const stop of cleanupSubscriptions) stop();
    await resources?.close().catch(() => {});
    await voice?.dispose().catch(() => {});
    await voiceArtifacts?.dispose().catch(() => {});
    await mcp?.close().catch(() => {});
    await nativeAccess?.close().catch(() => {});
    await environments?.close().catch(() => {});
    await environmentTemplates?.close().catch(() => {});
    if (foundation) await foundation.dispose().catch(() => {});
    else await store.close().catch(() => {});
    await accessStore?.close().catch(() => {});
    throw error;
  }
}
export type UnifiedApplication = Awaited<
  ReturnType<typeof startUnifiedApplication>
>;
