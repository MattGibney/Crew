import type {
  Agent,
  RuntimeHistoryItem,
  Job,
} from "../../../src/agents/contracts.mjs";
import type { DesktopBridge, DesktopSnapshot } from "../agents/desktop-client";
import type {
  AgentSetupDraft,
  AgentSetupRecord,
} from "../../../src/desktop/agent-setup-contracts.mjs";
import type { BrowserState } from "../contracts/browser";
import type { VoiceTranscriptArtifact } from "../../../src/agents/voice-artifacts.mjs";
import { createPreviewProject, type PreviewProject } from "./fixtures";

type Row = Record<string, unknown>;
const object = (value: unknown): Row =>
  value && typeof value === "object" ? (value as Row) : {};
const clone = <T>(value: T): T => structuredClone(value);
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const success = <T>(value: T) => ({ state: "acknowledged" as const, value });

/** Entirely disposable renderer data. No native bridge, network, auth, or model calls. */
export function createPreviewBridge(initial: "empty" | "full" = "full") {
  let projects = {
    empty: createPreviewProject("empty"),
    full: createPreviewProject("full"),
  };
  let selected = initial;
  const listeners = new Set<(event: unknown) => void>();
  const browsers = new Map<string, BrowserState>();
  let quit: DesktopSnapshot["quit"] = {
    state: "idle",
    recoveryRequired: false,
    detail: null,
    projects: [],
  };
  const emit = (event: unknown) =>
    listeners.forEach((listener) => listener(clone(event)));
  const desktop = (): DesktopSnapshot => ({
    projects: Object.values(projects).map(({ snapshot }) => ({
      id: snapshot.projectId,
      name: snapshot.projectName,
      directory: `/Preview/${snapshot.projectName}`,
    })),
    selectedId: projects[selected].snapshot.projectId,
    quit,
    updates: null,
  });
  const applicationChanged = () =>
    emit({ type: "application", snapshot: desktop() });
  const changed = (project: PreviewProject) => {
    project.access.agents = project.snapshot.agents;
    project.snapshot.creationPresets = project.access.presets;
    emit({
      type: "owner",
      projectId: project.snapshot.projectId,
      event: { kind: "changed" },
    });
  };
  function findProject(projectId: unknown) {
    const project = Object.values(projects).find(
      (item) => item.snapshot.projectId === projectId,
    );
    if (!project) throw new Error("Choose one of the sample projects.");
    return project;
  }
  function agent(project: PreviewProject, agentId: unknown) {
    const found = project.snapshot.agents.find((item) => item.id === agentId);
    if (!found) throw new Error("The preview agent no longer exists.");
    return found;
  }
  function newAgent(
    project: PreviewProject,
    name: string,
    presetId?: unknown,
  ): Agent {
    const preset = project.access.presets.find((item) => item.id === presetId);
    const seed = createPreviewProject("full").snapshot.agents[0];
    const value: Agent = {
      ...clone(seed),
      id: id(),
      projectId: project.snapshot.projectId,
      createdAt: now(),
      updatedAt: now(),
      archivedAt: null,
      lastUsedAt: null,
      profile: { ...(preset?.profile ?? seed.profile), revision: 1, name },
      reportsTo: { type: "user", userId: project.snapshot.ownerId },
      scratchpad: { markdown: "", revision: 1, updatedAt: now() },
      resources: [],
      skills: clone(preset?.skills ?? []),
      access: {
        permissionGroupIds: clone(preset?.permissionGroupIds ?? []),
        serviceConnectionIds: [],
        inheritPersonalServiceCredentials: false,
      },
      runtime: {
        ...clone(seed.runtime),
        threadId: null,
        session: {
          ...clone(seed.runtime.session),
          sessionId: null,
          desiredState: "stopped",
          observedState: "stopped",
          activeTurnId: null,
          appliedConfiguration: null,
          lastError: null,
        },
      },
    };
    project.snapshot.agents.push(value);
    project.histories[value.id] = [];
    return value;
  }
  function setup(project: PreviewProject, command: string, args: Row) {
    let record = (project.extras.setup ?? null) as AgentSetupRecord | null;
    if (command === "setup.read") return record;
    if (command === "setup.discard") {
      if (
        !record ||
        args.expectedRevision !== record.revision ||
        !["draft", "reviewed"].includes(record.phase)
      )
        throw new Error(
          "Only the current unapplied editor draft can be discarded.",
        );
      project.extras.setup = null;
      return null;
    }
    if (command === "setup.open" || command === "setup.new") {
      const existing = args.agentId ? agent(project, args.agentId) : null;
      const draft: AgentSetupDraft = {
        step: 0,
        mode: existing ? "repair" : "create",
        agentId: existing?.id ?? null,
        name: existing?.profile.name ?? "New agent",
        instructions:
          existing?.profile.systemPrompt ?? "Help the user with their goals.",
        personality: existing?.profile.personality ?? "",
        pictureRef: existing?.profile.pictureRef ?? null,
        voice: existing?.profile.voice ?? null,
        skills: existing?.skills ?? [],
        folderAccess: "none",
        groupMode: project.access.groups.length ? "existing" : "new",
        groupName: "Project team",
        groupIds: existing?.access.permissionGroupIds ?? [],
        crewActions: [],
        serviceConnectionIds: [],
        serviceCapabilities: [],
        makePrimary: !project.snapshot.primaryAgentId,
      };
      record = {
        id: id(),
        revision: (record?.revision ?? 0) + 1,
        draft,
        phase: "draft",
        review: null,
        result: null,
        error: null,
      };
    } else {
      if (!record) throw new Error("Open a preview setup draft first.");
      record = clone(record);
      record.revision++;
      if (command === "setup.save") {
        record.draft = args.draft as AgentSetupDraft;
        if (record.draft.groupMode === "existing") {
          const groups = project.access.groups.filter((group) =>
            record!.draft.groupIds.includes(group.id),
          );
          record.draft.skills = [
            ...new Set(groups.flatMap((group) => group.grants.skillIds ?? [])),
          ].map((skillId) => ({ skillId, enabled: true }));
          record.draft.serviceConnectionIds = [
            ...new Set(
              groups.flatMap((group) =>
                group.grants.services.map((grant) => grant.connectionId),
              ),
            ),
          ];
          const directory =
            project.extras.projectFolder ??
            `/Preview/${project.snapshot.projectName}`;
          const workspaces = object(project.extras.environments).workspaces;
          const selectedWorkspaces = (
            Array.isArray(workspaces) ? workspaces : []
          )
            .map(object)
            .filter(
              (workspace) =>
                object(workspace.workspace).path === directory &&
                groups.some((group) =>
                  group.grants.environmentPolicyIds.includes(
                    String(object(workspace.policy).id),
                  ),
                ),
            );
          record.draft.folderAccess = selectedWorkspaces.some(
            (workspace) => workspace.writable,
          )
            ? "read_write"
            : selectedWorkspaces.length
              ? "read_only"
              : "none";
        }
        record.phase = "draft";
      }
      if (command === "setup.review") {
        record.phase = "reviewed";
        record.review = {
          draftRevision: record.revision,
          directory: `/Preview/${project.snapshot.projectName}`,
          folderAccess: record.draft.folderAccess,
          groups: project.access.groups.filter((item) =>
            record!.draft.groupIds.includes(item.id),
          ),
          newGroup:
            record.draft.groupMode === "new"
              ? {
                  id: `preview-group-${record.id}`,
                  name: record.draft.groupName,
                  grants: {
                    crew: record.draft.crewActions.map((action) => ({
                      action,
                    })),
                    services: record.draft.serviceCapabilities,
                    environmentPolicyIds: [],
                  },
                }
              : null,
          connections: project.access.connections.filter((item) =>
            record!.draft.serviceConnectionIds.includes(item.id),
          ),
          workspaces: [],
          crewGrants: [],
          serviceCapabilities: record.draft.serviceCapabilities,
          warnings: [
            "UI preview only. No account, folder, session or service is accessed.",
          ],
          revisions: {
            groups: [],
            connections: [],
            policies: [],
            assignment: null,
            projectSettings: project.snapshot.projectSettings?.revision ?? 1,
            profile: null,
          },
        };
      }
      if (command === "setup.complete") {
        const value = record.draft.agentId
          ? agent(project, record.draft.agentId)
          : newAgent(project, record.draft.name);
        value.profile = {
          ...value.profile,
          revision: value.profile.revision + 1,
          name: record.draft.name,
          systemPrompt: record.draft.instructions,
          personality: record.draft.personality,
          voice: record.draft.voice,
          pictureRef: record.draft.pictureRef,
        };
        value.access.permissionGroupIds = [...record.draft.groupIds];
        if (record.review?.newGroup) {
          const group = {
            ...clone(record.review.newGroup),
            projectId: project.snapshot.projectId,
            description: "Created in UI preview",
            revision: 1,
            updatedAt: now(),
          };
          project.access.groups.push(group);
          value.access.permissionGroupIds.push(group.id);
        }
        const assignment = project.access.assignments.find(
          (item) => item.agentId === value.id,
        );
        if (assignment) {
          assignment.permissionGroupIds = [...value.access.permissionGroupIds];
          assignment.revision++;
        } else
          project.access.assignments.push({
            agentId: value.id,
            permissionGroupIds: [...value.access.permissionGroupIds],
            serviceConnectionIds: [],
            revision: 1,
          });
        if (record.draft.makePrimary)
          project.snapshot.primaryAgentId = value.id;
        if (record.draft.makePrimary && project.snapshot.projectSettings)
          project.snapshot.projectSettings.contactAgentId = value.id;
        record.result = {
          agentId: value.id,
          mode: record.draft.mode,
          primary: record.draft.makePrimary,
        };
        record.phase = "complete";
      }
    }
    project.extras.setup = record;
    changed(project);
    return record;
  }
  function access(project: PreviewProject, command: string, args: Row) {
    const view = project.access;
    const draft = object(args.draft);
    if (command === "access.snapshot") return view;
    if (command === "access.removeGroup") {
      const group = view.groups.find((item) => item.id === args.groupId);
      if (!group || group.revision !== args.expectedRevision)
        throw new Error("Group changed.");
      view.groups = view.groups.filter((item) => item.id !== args.groupId);
      for (const assignment of view.assignments)
        if (assignment.permissionGroupIds.includes(String(args.groupId))) {
          assignment.permissionGroupIds = assignment.permissionGroupIds.filter(
            (id) => id !== args.groupId,
          );
          assignment.serviceConnectionIds = [
            ...new Set(
              view.groups
                .filter((group) =>
                  assignment.permissionGroupIds.includes(group.id),
                )
                .flatMap((group) =>
                  group.grants.services.map((service) => service.connectionId),
                ),
            ),
          ];
          assignment.revision++;
        }
      for (const preset of view.presets)
        if (preset.permissionGroupIds.includes(String(args.groupId))) {
          preset.permissionGroupIds = preset.permissionGroupIds.filter(
            (id) => id !== args.groupId,
          );
          const groups = view.groups.filter((group) =>
            preset.permissionGroupIds.includes(group.id),
          );
          preset.serviceConnectionIds = [
            ...new Set(
              groups.flatMap((group) =>
                group.grants.services.map((service) => service.connectionId),
              ),
            ),
          ];
          preset.skills = [
            ...new Set(groups.flatMap((group) => group.grants.skillIds ?? [])),
          ].map((skillId) => ({ skillId, enabled: true }));
          preset.revision++;
        }
      for (const agent of project.snapshot.agents)
        if (agent.access.permissionGroupIds.includes(String(args.groupId))) {
          agent.access.permissionGroupIds =
            agent.access.permissionGroupIds.filter((id) => id !== args.groupId);
          const groups = view.groups.filter((group) =>
            agent.access.permissionGroupIds.includes(group.id),
          );
          agent.access.serviceConnectionIds = [
            ...new Set(
              groups.flatMap((group) =>
                group.grants.services.map((service) => service.connectionId),
              ),
            ),
          ];
          agent.skills = [
            ...new Set(groups.flatMap((group) => group.grants.skillIds ?? [])),
          ].map((skillId) => ({ skillId, enabled: true }));
        }
      return null;
    }
    if (command === "access.saveGroup" || command === "access.savePreset") {
      const list = command === "access.saveGroup" ? view.groups : view.presets;
      const index = list.findIndex((item) => item.id === args.id);
      const value = {
        ...draft,
        id: args.id ?? id(),
        projectId: view.projectId,
        revision: index >= 0 ? list[index].revision + 1 : 1,
        updatedAt: now(),
      };
      if (index < 0) list.push(value as never);
      else list[index] = value as never;
      return value;
    }
    if (command === "access.saveAssignment") {
      const value = agent(project, args.agentId);
      value.access.permissionGroupIds = args.permissionGroupIds as string[];
      let assignment = view.assignments.find(
        (item) => item.agentId === value.id,
      );
      if (!assignment) {
        assignment = {
          agentId: value.id,
          permissionGroupIds: [],
          serviceConnectionIds: [],
          revision: 0,
        };
        view.assignments.push(assignment);
      }
      assignment.permissionGroupIds = [...value.access.permissionGroupIds];
      assignment.revision++;
      return assignment;
    }
    if (command === "access.removePreset") {
      const preset = view.presets.find((item) => item.id === args.presetId);
      if (!preset || preset.revision !== args.expectedRevision)
        throw new Error("Template changed.");
      view.presets = view.presets.filter((item) => item.id !== args.presetId);
      if (view.creationDefaults.presetId === args.presetId)
        view.creationDefaults = {
          revision: view.creationDefaults.revision + 1,
          presetId: null,
        };
      return null;
    }
    if (command === "access.setDefaultPreset") {
      view.creationDefaults = {
        revision: view.creationDefaults.revision + 1,
        presetId: args.presetId as string | null,
      };
      return view.creationDefaults;
    }
    if (command === "access.removeConnection") {
      view.connections = view.connections.filter(
        (item) => item.id !== args.connectionId,
      );
      return null;
    }
    if (command === "access.revokeGrant") {
      view.grants = view.grants.filter((item) => item.id !== args.grantId);
      return null;
    }
    if (command === "access.decideAccess") {
      view.requests = view.requests.filter(
        (item) => item.id !== args.requestId,
      );
      return null;
    }
    if (command === "access.verifyConnection") return null;
    throw new Error(
      "Service authentication is disabled in UI preview. Existing connections are fictional sample data.",
    );
  }
  function browser(project: PreviewProject, args: Row) {
    const agentId = String(
      args.agentId ?? project.snapshot.primaryAgentId ?? "",
    );
    const key = `${project.snapshot.projectId}:${agentId}`;
    const state = browsers.get(key) ?? {
      open: false,
      url: "",
      title: "",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      ownerAgentId: agentId,
      recipientAgentId: agentId,
      activeTabId: null,
      tabs: [],
    };
    state.tabs ??= [];
    if (!browsers.has(key) && project === projects.full && agentId) {
      state.tabs = [
        {
          id: `${agentId}-overview`,
          title: "Studio dashboard",
          url: "https://example.com/studio",
          loading: false,
        },
        {
          id: `${agentId}-brief`,
          title: "Launch brief",
          url: "https://example.com/studio/brief",
          loading: false,
        },
      ];
      state.activeTabId = state.tabs[0].id;
      state.url = state.tabs[0].url;
      state.title = state.tabs[0].title;
      state.open = true;
    }
    if (["open", "new_tab", "navigate"].includes(String(args.action))) {
      if (!state.activeTabId || args.action === "new_tab") {
        state.activeTabId = id();
        state.tabs.push({
          id: state.activeTabId,
          title: "Preview page",
          url: "about:blank",
          loading: false,
        });
      }
      const tab = state.tabs.find((item) => item.id === state.activeTabId)!;
      tab.url = String(args.url ?? "https://example.com");
      tab.title = "Sample product dashboard";
      state.open = true;
    }
    if (args.action === "select_tab") state.activeTabId = String(args.tabId);
    if (args.action === "close_tab") {
      state.tabs = state.tabs.filter((item) => item.id !== args.tabId);
      state.activeTabId = state.tabs[0]?.id ?? null;
    }
    if (args.action === "close") state.open = false;
    const tab = state.tabs.find((item) => item.id === state.activeTabId);
    state.url = tab?.url ?? "";
    state.title = tab?.title ?? "";
    if (args.action === "selectElement")
      state.selection = {
        url: state.url,
        title: state.title,
        selector: "main h1",
        text: "Grow your business",
        capturedAt: now(),
      };
    if (args.action === "annotation")
      state.annotation = {
        content: [
          {
            type: "text",
            text: `Preview annotation on ${state.url}: ${String(args.comment ?? "")}`,
          },
        ],
      };
    browsers.set(key, state);
    emit({ type: "browser", projectId: project.snapshot.projectId, state });
    return state;
  }
  async function ownerCommand(
    project: PreviewProject,
    command: string,
    args: Row,
  ): Promise<unknown> {
    const s = project.snapshot;
    if (command.startsWith("setup.")) return setup(project, command, args);
    if (command.startsWith("access.")) {
      const value = access(project, command, args);
      if (command !== "access.snapshot") changed(project);
      return value;
    }
    if (command === "readHistory")
      return success({
        items: project.histories[String(args.agentId)] ?? [],
        nextCursor: null,
      });
    if (command === "readVoiceArtifacts")
      return success({
        artifacts:
          object(project.extras.voiceArtifacts)[String(args.agentId)] ?? [],
        nextCursor: null,
        warning: null,
      });
    if (command === "subscription.status")
      return { state: "signed_in", plan: "Preview subscription" };
    if (command === "subscription.usage")
      return (
        project.extras.usage ?? {
          status: "available",
          snapshot: {
            observedAt: now(),
            ordinaryUsageAllowed: true,
            limits: [
              {
                limitId: "preview",
                limitName: "Sample allowance",
                normalModelSlug: null,
                primary: {
                  usedPercent: 34,
                  windowDurationMins: 300,
                  resetsAt: Date.now() / 1000 + 7200,
                },
                secondary: {
                  usedPercent: 61,
                  windowDurationMins: 10080,
                  resetsAt: Date.now() / 1000 + 172800,
                },
              },
            ],
            resetCredits: { availableCount: 2, credits: [] },
          },
        }
      );
    if (command === "subscription.beginSignIn")
      throw new Error(
        "UI preview uses a fictional signed-in account. No sign-in is needed.",
      );
    if (command === "subscription.cancelSignIn") return null;
    const voices = project.extras.voices ?? [
      { id: "marin", name: "Marin" },
      { id: "cedar", name: "Cedar" },
    ];
    if (command === "agents.options")
      return {
        runtime: {
          provider: "codex",
          modelAccessId: "preview-subscription",
          configRef: "preview",
          label: "Preview Codex subscription",
        },
        voices: {
          state: "available",
          values: voices,
          defaultVoice: "marin",
          observedAt: now(),
        },
      };
    if (command === "voice.list")
      return { voices, defaultVoice: "marin", selectedVoice: null };
    if (command === "voice.start" || command === "voice.ready")
      throw new Error(
        "Voice calls are disabled in UI preview. No microphone or runtime connection is opened.",
      );
    if (command === "voice.stop") return null;
    if (command === "images.save") {
      const imageRef = `preview:${id()}`;
      project.extras[imageRef] = args.picture;
      return { imageRef };
    }
    if (command === "images.read")
      return project.extras[String(args.imageRef)]
        ? { picture: project.extras[String(args.imageRef)] }
        : null;
    if (command.startsWith("skills.")) return skills(project, command, args);
    if (command.startsWith("environments."))
      return environments(project, command, args);
    if (command.startsWith("schedules.")) {
      const schedules = object((project.extras.schedules ??= {}));
      const value = object(
        schedules[String(args.agentId)] ?? {
          revision: "preview-1",
          schedules: [],
        },
      );
      if (command === "schedules.save") {
        value.revision = id();
        value.schedules = args.schedules;
        schedules[String(args.agentId)] = value;
        changed(project);
      }
      return value;
    }
    if (command === "setContactAgent") {
      s.primaryAgentId = args.agentId as string;
      if (s.projectSettings) {
        s.projectSettings.contactAgentId = args.agentId as string;
        s.projectSettings.revision++;
      }
      changed(project);
      return s.projectSettings;
    }
    if (command === "createAgent") {
      const input = object(args.input);
      const value = newAgent(
        project,
        String(input.name ?? "New agent"),
        input.presetId,
      );
      changed(project);
      return value;
    }
    if (command === "saveProfile") {
      const value = agent(project, args.agentId);
      const input = object(args.input);
      value.profile = {
        ...(input.profile as Agent["profile"]),
        revision: value.profile.revision + 1,
      };
      value.skills = input.skills as Agent["skills"];
      changed(project);
      return value;
    }
    if (
      command === "archiveAgent" ||
      command === "restoreAgent" ||
      command === "deleteAgent"
    ) {
      const value = agent(project, args.agentId);
      if (command === "deleteAgent") {
        s.agents = s.agents.filter((item) => item.id !== value.id);
        delete project.histories[value.id];
      } else {
        value.archivedAt = command === "archiveAgent" ? now() : null;
        value.runtime.session = {
          ...value.runtime.session,
          desiredState: "stopped",
          observedState: "stopped",
          sessionId: null,
          activeTurnId: null,
        };
      }
      if (command !== "restoreAgent" && s.primaryAgentId === value.id) {
        s.primaryAgentId =
          s.agents.find((item) => !item.archivedAt)?.id ?? null;
        if (s.projectSettings)
          s.projectSettings.contactAgentId = s.primaryAgentId;
      }
      changed(project);
      return null;
    }
    if (command === "lifecycle" || command === "recoverSession") {
      const value = agent(project, args.agentId);
      const running = args.action !== "stop";
      value.runtime.threadId ??= `preview-thread-${value.id}`;
      value.runtime.session = {
        ...value.runtime.session,
        desiredState: running ? "started" : "stopped",
        observedState: running ? "started" : "stopped",
        sessionId: running ? id() : null,
        activeTurnId: null,
        lastObservedAt: now(),
        startedAt: running ? now() : null,
        lastError: null,
      };
      changed(project);
      return success(null);
    }
    if (command === "sendMessage") {
      const input = object(args.input);
      const value = agent(project, input.recipientAgentId);
      const turnId = id();
      const items = (project.histories[value.id] ??= []);
      const voiceItems = (
        (object(project.extras.voiceArtifacts)[value.id] ??
          []) as VoiceTranscriptArtifact[]
      ).flatMap((artifact) => artifact.items);
      // Fixture dates are deterministic; a new sample message must still follow them.
      const sentAt = new Date(
        Math.max(
          Date.now(),
          ...items.map((item) => Date.parse(item.timestamp ?? "") || 0),
          ...voiceItems.map((item) => Date.parse(item.observedAt) || 0),
        ) + 1,
      ).toISOString();
      items.push({
        runtimeRef: id(),
        turnId,
        timestamp: sentAt,
        timestampSource: "native_item",
        kind: "message",
        sender: { type: "user", userId: s.ownerId },
        content: clone(input.content) as RuntimeHistoryItem["content"],
        metadata: {},
      });
      items.push({
        runtimeRef: id(),
        turnId,
        timestamp: new Date(Date.parse(sentAt) + 1).toISOString(),
        timestampSource: "native_item",
        kind: "message",
        sender: { type: "assistant", agentId: value.id },
        content: [
          {
            type: "text",
            text: "This is a simulated preview reply. Your message stays in this browser tab; no agent or external service was contacted. You can keep editing the interface with realistic chat content.",
          },
        ],
        metadata: {},
      });
      value.lastUsedAt = now();
      changed(project);
      emit({
        type: "owner",
        projectId: s.projectId,
        event: {
          kind: "runtime",
          event: {
            kind: "history",
            binding: {
              projectId: s.projectId,
              agentId: value.id,
              sessionId: value.runtime.session.sessionId ?? "preview-session",
              threadId: value.runtime.threadId ?? "preview-thread",
            },
            observedAt: now(),
            item: items[items.length - 1],
          },
        },
      });
      return { id: id(), delivery: { state: "delivered" } };
    }
    if (command === "createJob") {
      const input = object(args.input);
      const work = object(input.work);
      const value: Job = {
        id: id(),
        projectId: s.projectId,
        createdAt: now(),
        updatedAt: now(),
        assignment: {
          assignedBy: { type: "user", userId: s.ownerId },
          assignedToAgentId: input.assignedToAgentId as string | null,
          instruction: input.instruction as string | null,
        },
        work:
          work.type === "local"
            ? {
                type: "local",
                title: String(work.title ?? "New job"),
                objective: String(work.objective ?? ""),
                updates: [],
                outcome: null,
              }
            : (input.work as Job["work"]),
        progress: {
          status: "not_started",
          label: null,
          detail: null,
          percent: null,
          reportedByAgentId: null,
          reportedAt: null,
        },
        assignmentHistory: [],
      };
      s.jobs.push(value);
      changed(project);
      return value;
    }
    if (command === "assignJob") {
      const value = s.jobs.find((item) => item.id === args.jobId);
      if (value) {
        value.assignment.assignedToAgentId = args.agentId as string | null;
        value.assignment.instruction = args.instruction as string | null;
        changed(project);
      }
      return value;
    }
    if (command === "respondToHelp") {
      s.helpRequests = s.helpRequests.filter((item) => item.id !== args.helpId);
      s.ownerInbox = s.ownerInbox.filter(
        (item) => item.helpRequestId !== args.helpId,
      );
      changed(project);
      return null;
    }
    if (command === "respondToNativeApproval") {
      s.nativeApprovals = s.nativeApprovals.filter(
        (item) => item.approvalId !== args.approvalId,
      );
      changed(project);
      return success(null);
    }
    if (command === "prepare") return s.readiness;
    if (["reconcileMessage", "retryMessage"].includes(command)) {
      s.pendingMessages = s.pendingMessages.filter(
        (item) => item.id !== args.messageId,
      );
      changed(project);
      return null;
    }
    throw new Error(`The ${command} action is not available in UI preview.`);
  }
  function skills(project: PreviewProject, command: string, args: Row) {
    const documents = object((project.extras.skillDocuments ??= {}));
    if (command === "skills.list") return project.snapshot.skills;
    let skill = project.snapshot.skills.find(
      (item) => item.id === args.skillId,
    );
    if (command === "skills.read") {
      if (!skill) throw new Error("Choose a skill.");
      return (
        documents[skill.id] ?? {
          skill,
          markdown:
            object(project.extras.skillContents)[skill.id] ??
            `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n# ${skill.name}\n\nFollow the project guidelines, record progress, and ask for help when needed.`,
          resources: [],
        }
      );
    }
    const markdown = String(args.markdown ?? "");
    const name = /^name:\s*(.+)$/m.exec(markdown)?.[1] ?? "New skill";
    const description =
      /^description:\s*(.+)$/m.exec(markdown)?.[1] ?? "Project workflow";
    if (!skill) {
      skill = {
        id: id(),
        projectId: project.snapshot.projectId,
        revision: 1,
        name,
        description,
        directoryRef: "preview",
        updatedAt: now(),
      };
      project.snapshot.skills.push(skill);
    } else {
      skill.name = name;
      skill.description = description;
      skill.revision++;
      skill.updatedAt = now();
    }
    const value = {
      skill,
      markdown,
      resources: args.resources ?? object(documents[skill.id]).resources ?? [],
    };
    documents[skill.id] = value;
    changed(project);
    return value;
  }
  function environments(project: PreviewProject, command: string, args: Row) {
    const environment = object(
      (project.extras.environments ??= { workspaces: [] }),
    );
    const templates = object(
      (project.extras.templates ??= { templates: [], assignments: [] }),
    );
    if (command === "environments.snapshot") return environment;
    if (command === "environments.projectFolder")
      return {
        directory:
          project.extras.projectFolder ??
          `/Preview/${project.snapshot.projectName}`,
      };
    if (command === "environments.templates.snapshot") return templates;
    if (command === "environments.templates.save") {
      const values = templates.templates as Row[];
      const index = values.findIndex((item) => item.id === args.id);
      const value = {
        ...object(args.draft ?? args.definition),
        id: args.id ?? id(),
        projectId: project.snapshot.projectId,
        revision: index >= 0 ? Number(values[index].revision) + 1 : 1,
        updatedAt: now(),
      };
      if (index < 0) values.push(value);
      else values[index] = value;
      changed(project);
      return value;
    }
    if (command === "environments.templates.inspect") {
      const value = (templates.templates as Row[]).find(
        (item) => item.id === args.templateId,
      );
      return {
        templateId: value?.id,
        templateRevision: value?.revision,
        checkedAt: now(),
        tools: ((value?.tools ?? []) as Row[]).map((tool) => ({
          name: tool.name,
          state: "available",
          requestedVersion: tool.versionRequirement,
          observedVersion: "Preview",
          executablePath: `/preview/bin/${tool.name}`,
          reason: null,
        })),
        limitations: ["Simulated inspection. No tools were executed."],
      };
    }
    if (command === "environments.templates.assign") {
      const assignments = templates.assignments as Row[];
      const previous = assignments.findIndex(
        (item) => item.agentId === args.agentId,
      );
      const value = {
        agentId: args.agentId,
        templateId: args.templateId ?? null,
        templateRevision: args.templateRevision ?? null,
        revision:
          previous >= 0 ? Number(assignments[previous].revision) + 1 : 1,
        updatedAt: now(),
      };
      if (previous >= 0) assignments[previous] = value;
      else assignments.push(value);
      changed(project);
      return value;
    }
    if (
      command === "environments.prepareFolderAccess" ||
      command === "environments.approveWorkspace"
    ) {
      const input =
        command === "environments.approveWorkspace" ? object(args.input) : args;
      const path = String(
        input.workspaceDirectory ??
          project.extras.projectFolder ??
          "/preview/project",
      );
      const access =
        input.access ?? (input.writable ? "read_write" : "read_only");
      const workspaces = environment.workspaces as Row[];
      let workspace = workspaces.find(
        (item) =>
          object(item.workspace).path === path &&
          item.writable === (access === "read_write"),
      );
      if (!workspace && access !== "none") {
        const policy = {
          id: String(input.policyId ?? id()),
          projectId: project.snapshot.projectId,
          revision: 1,
          enforcementConfigRef: "preview://folder-policy",
        };
        workspace = {
          policy,
          workspace: { path, device: 0, inode: workspaces.length + 1 },
          writable: access === "read_write",
          executableDirectories: [],
          managedWorktreeRoot: null,
          gitDirectory: null,
        };
        workspaces.push(workspace);
        project.access.environmentPolicies.push(policy);
      }
      changed(project);
      return {
        access,
        canonicalPath: path,
        policy: workspace?.policy ?? null,
        requiredGrants: {
          crew: [],
          services: [],
          environmentPolicyIds: workspace ? [object(workspace.policy).id] : [],
        },
      };
    }
    throw new Error("Environment execution is unavailable in UI preview.");
  }
  const bridge: DesktopBridge = {
    integratedTitlebar: false,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async request(method, value) {
      const args = object(value);
      if (method === "snapshot") return clone(desktop());
      if (method === "selectProject") {
        const project = findProject(args.projectId);
        selected = project === projects.empty ? "empty" : "full";
        applicationChanged();
        return;
      }
      if (method === "copyText") {
        if (typeof value === "string")
          await navigator.clipboard?.writeText(value);
        return;
      }
      if (method === "openWebLink") {
        throw new Error(
          "External links are disabled in UI preview. Copy the link if needed.",
        );
      }
      if (method === "chooseProjectDirectory")
        return {
          directory: "/Preview/New project",
          suggestedName: "New project",
        };
      if (method === "createProject")
        throw new Error(
          "Use the Empty project sample to preview project setup.",
        );
      if (method === "prepareQuit") {
        quit = {
          ...quit,
          state: "ready",
          detail: "Preview prepared. No processes were stopped.",
        };
        applicationChanged();
        return quit;
      }
      if (method === "cancelQuit") {
        quit = { ...quit, state: "idle", detail: null };
        applicationChanged();
        return quit;
      }
      if (method === "quit")
        throw new Error("Close this browser tab to leave the preview.");
      if (method === "updates")
        throw new Error("Updates are disabled in UI preview.");
      const project = findProject(args.projectId);
      if (method === "ownerSnapshot") return clone(project.snapshot);
      if (method === "ownerCommand")
        return clone(
          await ownerCommand(project, String(args.command), object(args.args)),
        );
      if (method === "browser") return clone(browser(project, args));
      if (method === "renameProject") {
        project.snapshot.projectName = String(args.name);
        applicationChanged();
        return;
      }
      throw new Error(`The ${method} action is disabled in UI preview.`);
    },
  };
  return {
    bridge,
    reset() {
      projects = {
        empty: createPreviewProject("empty"),
        full: createPreviewProject("full"),
      };
      browsers.clear();
      applicationChanged();
      Object.values(projects).forEach(changed);
    },
    select(kind: "empty" | "full") {
      selected = kind;
      applicationChanged();
    },
  };
}
