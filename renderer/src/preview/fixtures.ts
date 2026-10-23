import { sampleProfilePictures } from "./profile-pictures";
import type { AgentsSnapshot } from "../agents/client";
import type { AccessOwnerView } from "../../../src/access/owner-contracts.mjs";
import type {
  Agent,
  AgentCreationPreset,
  CrewAction,
  Job,
  JobStatus,
  PermissionGroup,
  RuntimeHistoryItem,
  ServiceCapability,
  ServiceConnection,
  Skill,
} from "../../../src/agents/contracts.mjs";
import type { EnvironmentTemplate } from "../../../src/agents/environment-templates.mjs";
import type { VoiceTranscriptArtifact } from "../../../src/agents/voice-artifacts.mjs";
import type { ManagerSchedules } from "../contracts/manager";

/** Entirely fictional display fixtures. These references never resolve to host files or services. */
export interface PreviewProject {
  snapshot: AgentsSnapshot;
  histories: Record<string, RuntimeHistoryItem[]>;
  access: AccessOwnerView;
  extras: Record<string, unknown>;
}
const id = (n: number) =>
  `13500000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (minutes = 0) =>
  new Date(Date.UTC(2026, 9, 26, 9, minutes)).toISOString();
const text = (value: string) => [{ type: "text" as const, text: value }];
const commonActions: CrewAction[] = [
  "agents.read",
  "messages.send",
  "history.read",
  "help.request",
  "jobs.read",
  "jobs.update",
  "scratchpad.read",
  "scratchpad.write",
  "skills.read",
  "resources.read",
  "environments.read",
];
const domainNames = [
  "Engineering",
  "Marketing",
  "Customer support",
  "Personal assistance",
];

export function createPreviewProject(kind: "empty" | "full"): PreviewProject {
  const populated = kind === "full";
  const projectId = id(populated ? 1 : 2);
  const ownerId = id(3);
  const owner = { type: "user" as const, userId: ownerId };
  const skills: Skill[] = populated
    ? [
        [
          "Feature delivery",
          "Research a request, implement a focused change, and prepare it for review.",
        ],
        [
          "Code review",
          "Review correctness, maintainability, and the user-facing result.",
        ],
        [
          "Campaign planning",
          "Create a campaign brief with audience, message, channels, and success measures.",
        ],
        [
          "Brand voice",
          "Write clear, friendly copy using the project’s editorial guidelines.",
        ],
        [
          "Customer triage",
          "Investigate support requests and escalate cases that require a decision.",
        ],
        [
          "Inbox briefing",
          "Summarise important messages and prepare drafts for review.",
        ],
      ].map(([name, description], index) => ({
        id: id(200 + index),
        projectId,
        revision: index === 0 ? 3 : 1,
        name,
        description,
        directoryRef: `preview://skills/${index}`,
        updatedAt: at(-1440 + index * 30),
      }))
    : [];
  const connections: ServiceConnection[] = populated
    ? [
        [
          "GitHub · Studio engineering",
          "github",
          "Studio automation",
          "dedicated",
        ],
        ["GitHub · Personal projects", "github", "Alex Morgan", "personal"],
        ["Linear · Studio roadmap", "linear", "Studio team", "dedicated"],
        ["Gmail · Personal inbox", "gmail", "Alex Morgan", "personal"],
        ["Slack · Studio team", "slack", "Studio workspace", "dedicated"],
      ].map(([name, service, displayName, accountKind], index) => ({
        id: id(300 + index),
        projectId,
        name,
        service,
        revision: 1,
        identity: {
          displayName,
          externalAccountId: `sample-${accountKind}-${index}`,
          emailAddress: index === 3 ? "alex@example.com" : null,
        },
        transport: {
          type: "mcp",
          serverConfigRef: `preview://connections/${index}`,
        },
        authentication: { method: "none" },
        observedState: index === 4 ? "reauthentication-required" : "connected",
        lastVerifiedAt: at(-20 - index),
      }))
    : [];
  const capabilities: ServiceCapability[] = connections.flatMap(
    (connection) => {
      const names: Record<string, string[]> = {
        github: ["read_issues", "create_pull_request", "read_checks"],
        linear: ["read_issues", "update_issue"],
        gmail: ["read_messages", "create_draft"],
        slack: ["read_channels", "send_message"],
      };
      return names[connection.service].map((name) => ({
        id: `${connection.id}:${name}`,
        connectionId: connection.id,
        upstreamName: name,
        description: name.replaceAll("_", " "),
        inputSchema: { type: "object", properties: {} },
        outputSchema: null,
        verification: "read_only" as const,
      }));
    },
  );
  const policies = populated
    ? [0, 1].map((index) => ({
        id: id(400 + index),
        projectId,
        revision: 1,
        enforcementConfigRef: `preview://policies/${index}`,
      }))
    : [];
  const groups: PermissionGroup[] = populated
    ? domainNames.map((name, index) => ({
        id: id(100 + index),
        projectId,
        name,
        description: [
          "Source code, project tooling, code review, and engineering services.",
          "Campaigns, creative production, and editorial resources.",
          "Customer questions, service knowledge, and support handoffs.",
          "Inbox organisation, calendar preparation, and personal communications.",
        ][index],
        revision: 2,
        updatedAt: at(-120),
        grants: {
          crew: [
            ...commonActions,
            ...(index === 0
              ? ([
                  "browser.control",
                  "browser.external",
                  "environments.create",
                  "environments.attach",
                  "environments.execute",
                ] as CrewAction[])
              : (["browser.control"] as CrewAction[])),
          ].map((action) => ({ action })),
          services: (index === 0
            ? [connections[0], connections[1], connections[2]]
            : index === 3
              ? [connections[3]]
              : [connections[2], connections[4]]
          ).map((connection) => ({
            connectionId: connection.id,
            capabilities: capabilities
              .filter((capability) => capability.connectionId === connection.id)
              .map((capability) => capability.id),
          })),
          environmentPolicyIds:
            index === 0 ? policies.map((policy) => policy.id) : [],
          skillIds:
            index === 0
              ? skills.slice(0, 2).map((skill) => skill.id)
              : index === 1
                ? skills.slice(2, 4).map((skill) => skill.id)
                : [skills[index === 2 ? 4 : 5].id],
          resourceIds: [],
        },
      }))
    : [];
  if (populated)
    groups.push({
      id: id(104),
      projectId,
      name: "Team coordination",
      description:
        "Supplemental delegation and session controls for specialist leads.",
      revision: 1,
      updatedAt: at(-100),
      grants: {
        crew: [
          "agents.create",
          "agents.update",
          "agents.archive",
          "sessions.start",
          "sessions.stop",
          "sessions.restart",
          "jobs.create",
          "jobs.assign",
          "help.respond",
          "groups.read",
        ].map((action) => ({ action: action as CrewAction })),
        services: [],
        environmentPolicyIds: [],
        skillIds: [],
      },
    });
  const definitions: [string, string, number, number | null][] = [
    ["Avery", "Engineering lead", 0, null],
    ["Robin", "Marketing lead", 1, null],
    ["Jamie", "Customer support", 2, null],
    ["Morgan", "Personal assistant", 3, null],
    ["Website worker", "Dashboard development", 0, 0],
    ["API worker", "Billing integration", 0, 0],
    ["Review worker", "Code review", 0, 0],
    ["Research worker", "Accessibility research", 0, 0],
    ["Campaign worker", "Launch campaign", 1, 1],
    ["Content worker", "Editorial production", 1, 1],
    ["Support worker", "Customer triage", 2, 2],
    ["Inbox worker", "Inbox briefing", 3, 3],
    ["Launch research", "Archived research", 1, 1],
    ["API prototype", "Archived prototype", 0, 0],
  ];
  const agents: Agent[] = populated
    ? definitions.map(([name, role, groupIndex, parent], index) => {
        const archived = index > 11;
        const stopped = archived || index === 7 || index === 10;
        const error = index === 11;
        const agentId = id(10 + index);
        const memberships = [
          groups[groupIndex],
          ...(parent === null ? [groups[4]] : []),
        ];
        return {
          id: agentId,
          projectId,
          createdAt: at(-10080 + index * 12),
          updatedAt: at(-index * 3),
          archivedAt: archived ? at(-1440 * (index - 11)) : null,
          lastUsedAt: archived ? at(-1440 * (index - 11) - 30) : at(-index * 2),
          profile: {
            revision: index === 0 ? 4 : 1,
            name,
            pictureRef:
              parent === null ? `preview:profile-${groupIndex}` : null,
            personality:
              parent === null
                ? [
                    "Thoughtful and practical. Brings clear recommendations and protects your attention.",
                    "Creative, curious, and concise. Explains the thinking behind a campaign.",
                    "Patient and reassuring. Prioritises clear, useful customer outcomes.",
                    "Warm, organised, and discreet. Keeps your day moving without unnecessary interruptions.",
                  ][groupIndex]
                : "",
            systemPrompt: name === "Avery" ? "Lead software engineering for Set1. Turn agreed product requirements into working, reviewable changes and coordinate specialist workers when useful.\n\nBefore starting\n- Read the relevant ticket, repository guidance and assigned skills.\n- Inspect the existing implementation. Clarify missing acceptance criteria or decisions that materially affect scope.\n- Keep plans proportionate to the task.\n\nDelivery\n- Delegate independent work with a clear objective, acceptance criteria and reporting expectations. Give workers only the groups they need.\n- Follow existing architecture and UI conventions. Reuse established components and avoid unrelated refactors.\n- Run the project’s relevant checks and verify the changed user flow. Report any checks you could not complete.\n- Review delegated changes before presenting the result.\n\nTracking and completion\n- Keep the source ticket updated with progress, decisions and blockers. Use your scratchpad for working notes rather than duplicating the ticket.\n- Report what changed, how it was verified, remaining limitations and links to the pull request or other deliverables.\n- Ask for approval before merging, deploying, deleting shared resources or expanding access, unless that action was already explicitly authorised.\n- If blocked, explain what is needed and continue independent work where possible." : `You are ${name}, responsible for ${role.toLowerCase()} in this fictional Studio preview. Choose your own approach, maintain useful notes, report progress, and ask for help when needed. Follow your assigned project skills and permissions.`,
            voice:
              parent === null
                ? ["marin", "cedar", "marin", "cedar"][groupIndex]
                : null,
          },
          skills: memberships.flatMap((group) =>
            (group.grants.skillIds ?? []).map((skillId) => ({
              skillId,
              enabled: true,
            })),
          ),
          access: {
            permissionGroupIds: memberships.map((group) => group.id),
            serviceConnectionIds: [
              ...new Set(
                memberships.flatMap((group) =>
                  group.grants.services.map((service) => service.connectionId),
                ),
              ),
            ],
            inheritPersonalServiceCredentials: false,
          },
          runtime: {
            provider: "codex",
            modelAccessId: id(500),
            configRef: "preview://runtime/studio",
            threadId: id(600 + index),
            session: {
              sessionId: stopped ? null : id(700 + index),
              desiredState: stopped ? "stopped" : "started",
              observedState: error ? "error" : stopped ? "stopped" : "started",
              activeTurnId: [4, 5, 8, 9].includes(index)
                ? id(800 + index)
                : null,
              startedAt: stopped ? null : at(-90),
              lastObservedAt: at(),
              lastError: error
                ? {
                    code: "disconnected",
                    message:
                      "The sample session disconnected. Restart to reconnect.",
                    retryable: true,
                  }
                : null,
              appliedConfiguration: stopped
                ? null
                : {
                    profileRevision: index === 0 ? 3 : 1,
                    permissionGroups: memberships.map((group) => ({
                      id: group.id,
                      revision: group.revision,
                    })),
                    serviceConnections: [],
                    skills: [],
                    runtimeConfigRevision: 1,
                    appliedAt: at(-90),
                  },
            },
          },
          scratchpad: {
            markdown: `# ${name} — ${role}\n\n## Current focus\n${["Coordinate the new reporting dashboard and prepare the accessibility review.", "Prepare the autumn product launch campaign and draft customer stories.", "Resolve customer questions and improve the onboarding knowledge base.", "Prepare today’s briefing and organise the messages that need a decision."][groupIndex]}\n\n## Next steps\n- Review current work and record the outcome.\n- Keep related tickets up to date.\n- Escalate decisions with a short recommendation.\n\n## Working notes\n${parent === null ? "The owner prefers a combined update rather than a notification for every completed item." : "Keep implementation focused. Confirm the outcome with the lead before taking on additional scope."}`,
            revision: 3,
            updatedAt: at(-15),
          },
          reportsTo:
            parent === null
              ? owner
              : { type: "agent", agentId: id(10 + parent) },
          resources: [],
        };
      })
    : [];
  const jobDefinitions: [string, JobStatus, string, number | null, number][] = [
    ["Build the reporting dashboard", "in_progress", "Building charts", 68, 4],
    ["Connect billing usage data", "blocked", "Awaiting access", 35, 5],
    ["Review dashboard accessibility", "ready", "Review ready", 100, 6],
    ["Research keyboard navigation", "not_started", "Not started", null, 7],
    ["Prepare the autumn launch", "in_progress", "Drafting campaign", 54, 8],
    ["Write three customer stories", "in_progress", "Editing copy", 80, 9],
    ["Investigate onboarding question", "blocked", "Needs decision", 45, 10],
    ["Prepare the morning briefing", "ready", "Briefing ready", 100, 11],
    ["Publish release notes", "completed", "Published", 100, 9],
    ["Audit inactive projects", "completed", "Audit complete", 100, 0],
    ["Refresh help centre examples", "in_progress", "Updating examples", 42, 2],
    ["Prototype pricing calculator", "cancelled", "Scope changed", 20, 5],
    ["Explore campaign photography", "not_started", "Brief agreed", 0, 1],
    ["Prepare launch QA checklist", "ready", "Ready to review", 100, 6],
    ["Triage feature requests", "in_progress", "Grouping requests", 27, 10],
    [
      "Compare onboarding options",
      "completed",
      "Recommendation saved",
      100,
      12,
    ],
    ["Set up API prototype", "completed", "Prototype complete", 100, 13],
    [
      "Plan next week’s priorities",
      "not_started",
      "Awaiting planning",
      null,
      0,
    ],
  ];
  const jobs: Job[] = populated
    ? jobDefinitions.map(
        ([title, status, label, percent, agentIndex], index) => ({
          id: id(900 + index),
          projectId,
          createdAt: at(-2880 + index * 20),
          updatedAt: at(-index),
          assignment: {
            assignedBy: owner,
            assignedToAgentId: agents[agentIndex].id,
            instruction: `Deliver ${title.toLowerCase()} and keep your lead informed of decisions.`,
          },
          work:
            index % 3 === 1
              ? {
                  type: "ticket",
                  ticket: {
                    provider: index % 2 ? "linear" : "github",
                    connectionId: connections[index % 2 ? 2 : 0].id,
                    externalId:
                      index % 2 ? `STU-${120 + index}` : String(40 + index),
                    url: `https://example.com/${index % 2 ? "linear/studio/issue/STU-" : "github/studio/issues/"}${120 + index}`,
                  },
                }
              : {
                  type: "local",
                  title,
                  objective: `${title}. Prepare a practical result that can be reviewed, with clear notes on any remaining limitations.`,
                  updates: [
                    {
                      id: id(1000 + index),
                      recordedByAgentId: agents[agentIndex].id,
                      recordedAt: at(-25),
                      kind: "progress",
                      text: `Latest update: ${label.toLowerCase()}. ${status === "blocked" ? "I have raised the specific decision with my lead." : "The current scope is documented and the next step is clear."}`,
                      links: [],
                    },
                  ],
                  outcome:
                    status === "completed"
                      ? {
                          summary:
                            "The agreed work is complete and the result is available for review.",
                          links: [
                            {
                              label: "Sample result",
                              url: "https://example.com/studio/results",
                            },
                          ],
                          recordedByAgentId: agents[agentIndex].id,
                          recordedAt: at(-30),
                        }
                      : null,
                },
          progress: {
            status,
            label,
            detail:
              status === "blocked"
                ? "Waiting for a decision on the permitted data source. The implementation can continue once that is confirmed."
                : `${title}: ${label.toLowerCase()}. Next I’ll check the result and share a concise update.`,
            percent,
            reportedByAgentId: agents[agentIndex].id,
            reportedAt: at(-index),
          },
          assignmentHistory: [],
        }),
      )
    : [];
  const presets: AgentCreationPreset[] = populated
    ? domainNames.map((name, index) => ({
        id: id(1100 + index),
        projectId,
        revision: 1,
        name: `${name} worker`,
        enabled: true,
        profile: {
          name: `${name} worker`,
          pictureRef: null,
          personality: "",
          systemPrompt: `Deliver the assigned ${name.toLowerCase()} objective. Maintain notes and communicate with your lead.`,
          voice: null,
        },
        skills: [],
        modelAccessId: id(500),
        configRef: "preview://runtime/studio",
        permissionGroupIds: [groups[index].id],
        serviceConnectionIds: groups[index].grants.services.map(
          (service) => service.connectionId,
        ),
        environmentTemplate: {
          id: id(1200 + (index === 0 ? 0 : index === 1 ? 1 : 2)),
          revision: 1,
        },
      }))
    : [];
  const histories: Record<string, RuntimeHistoryItem[]> = {};
  for (const [index, agent] of agents.entries()) {
    const messages: [boolean, string][] = [
      [
        true,
        index === 0
          ? "Can you give me an overview of the engineering work and anything that needs my attention?"
          : `What’s the latest on ${definitions[index][1].toLowerCase()}?`,
      ],
      [
        false,
        "I’ve reviewed the current priorities and saved a short plan in my work notes. I’ll coordinate the work and bring you the decisions that need your input.",
      ],
      [
        true,
        "Keep the first version focused. Show me something usable before spending time polishing it.",
      ],
      [
        false,
        "Understood. The first pass will cover the complete flow, with any limitations recorded alongside it.",
      ],
      [true, "How are we getting on now?"],
      [
        false,
        index === 0
          ? "Three updates:\n\n- **Reporting dashboard:** the charts are taking shape; the worker estimates 68%.\n- **Accessibility review:** ready for you to look at.\n- **Billing data:** blocked on which account we should use.\n\nMy recommendation is to review the dashboard while I resolve the data-access question. The [sample project brief](https://example.com/studio/brief) has the current scope."
          : "The main work is moving forward. I’ve grouped the results in my notes and raised one question for review. There’s no action needed from you until that recommendation is ready.",
      ],
    ];
    histories[agent.id] = messages.map(([user, body], messageIndex) => ({
      runtimeRef: id(2000 + index * 20 + messageIndex),
      turnId: id(2500 + index * 10 + Math.floor(messageIndex / 2)),
      timestamp: at(-180 + messageIndex * 10),
      timestampSource: "native_item",
      kind: "message",
      sender: user ? owner : { type: "assistant", agentId: agent.id },
      content: text(body),
      metadata: {},
    }));
    histories[agent.id].splice(3, 0, {
      runtimeRef: id(2800 + index),
      turnId: id(2501 + index * 10),
      timestamp: at(-155),
      timestampSource: "native_item",
      kind: "tool",
      sender: { type: "tool", name: "crew.jobs_list" },
      content: text(
        "Reviewed the assigned work and recorded the current progress.",
      ),
      metadata: { toolName: "crew.jobs_list", state: "completed" },
    });
  }
  const voiceArtifacts: Record<string, VoiceTranscriptArtifact[]> = {};
  for (const [index, agent] of agents.slice(0, 4).entries())
    voiceArtifacts[agent.id] = [
      {
        id: id(3000 + index),
        projectId,
        agentId: agent.id,
        threadId: agent.runtime.threadId!,
        callId: id(3100 + index),
        voiceSessionId: id(3200 + index),
        realtimeSessionId: id(3300 + index),
        createdAt: at(-110),
        updatedAt: at(-108),
        state: "closed",
        items: [
          {
            itemId: id(3400 + index * 2),
            role: "user",
            text: "One more thing: keep the updates brief, and let me know if a decision is holding anything up.",
            done: true,
            ordinal: 0,
            observedAt: at(-110),
          },
          {
            itemId: id(3401 + index * 2),
            role: "assistant",
            text: "I will. I’ll collect routine progress in my notes and bring you a clear recommendation when your input would help.",
            done: true,
            ordinal: 1,
            observedAt: at(-109),
          },
        ],
      },
    ];
  const helpRequests: AgentsSnapshot["helpRequests"] = populated
    ? [0, 1].map((index) => ({
        id: id(3500 + index),
        projectId,
        requesterAgentId: agents[index === 0 ? 5 : 10].id,
        target: index === 0 ? { type: "agent", agentId: agents[0].id } : owner,
        jobId: jobs[index === 0 ? 1 : 6].id,
        messageId: id(3600 + index),
        replyToHelpRequestId: null,
        state: "open",
        responseMessageId: null,
        createdAt: at(-15 + index),
      }))
    : [];
  const snapshot: AgentsSnapshot = {
    projectId,
    projectName: populated ? "Set1 Studio (sample)" : "Empty project (sample)",
    ownerId,
    voiceArtifactsRevision: populated ? 1 : 0,
    primaryAgentId: agents[0]?.id ?? null,
    projectSettings: {
      projectId,
      revision: 1,
      primaryAgentId: agents[0]?.id ?? null,
      contactAgentId: agents[0]?.id ?? null,
    },
    creationPresets: presets,
    agents,
    jobs,
    skills,
    pendingMessages: populated
      ? [
          {
            id: id(3700),
            projectId,
            sender: owner,
            visibility: "public",
            recipientAgentId: agents[4].id,
            jobId: jobs[0].id,
            replyToMessageId: null,
            kind: "message",
            content: text(
              "Please include an empty-data view in the first dashboard review.",
            ),
            deliveryMode: "queue",
            createdAt: at(-2),
            delivery: {
              state: "queued",
              attempts: [],
              runtimeMessageRef: null,
              deliveredAt: null,
              error: null,
            },
          },
        ]
      : [],
    receipts: [],
    helpRequests,
    ownerInbox: populated
      ? [
          {
            helpRequestId: helpRequests[1].id,
            content: text(
              "A customer is asking whether archived projects can be restored. Should I offer the preview workflow or wait for the next release?",
            ),
          },
        ]
      : [],
    nativeApprovals: populated
      ? [
          {
            agentId: agents[5].id,
            approvalId: id(3800),
            turnId: id(3801),
            request: {
              command: "npm run dev",
              reason: "Start the sample dashboard preview for local review.",
            },
            state: "pending",
            choices: [
              { label: "Allow once", response: "accept" },
              { label: "Decline", response: "decline" },
            ],
          },
        ]
      : [],
    readiness: [],
    serviceConnections: connections.map(
      ({
        authentication: _authentication,
        transport: _transport,
        revision: _revision,
        ...connection
      }) => connection,
    ),
  };
  const requestId = id(3900);
  const access: AccessOwnerView = {
    projectId,
    agents,
    runtimeDefaults: {
      modelAccessId: id(500),
      configRef: "preview://runtime/studio",
    },
    groups,
    skills,
    presets,
    creationDefaults: { revision: 1, presetId: presets[0]?.id ?? null },
    assignments: agents.map((agent) => ({
      agentId: agent.id,
      permissionGroupIds: agent.access.permissionGroupIds,
      serviceConnectionIds: agent.access.serviceConnectionIds,
      revision: 1,
    })),
    connections,
    environmentPolicies: policies,
    requests: populated
      ? [
          {
            id: requestId,
            caller: { projectId, agentId: agents[5].id, sessionId: id(705) },
            jobId: jobs[1].id,
            operation: {
              invocationId: id(3901),
              connectionId: connections[0].id,
              operation: capabilities[1].id,
              arguments: { title: "Add billing usage projection" },
              argumentsFingerprint: "sample-display-only",
            },
            requestedScope: {
              type: "capability",
              connectionId: connections[0].id,
              capabilities: [capabilities[1].id],
              constraints: [],
            },
            justification:
              "Open a pull request for the billing usage integration so the engineering lead can review it.",
            createdAt: at(-12),
            updatedAt: at(-12),
            state: "pending",
            grantId: null,
            decidedBy: null,
            reason: null,
          },
        ]
      : [],
    grants: populated
      ? [
          {
            id: id(3950),
            projectId,
            requestId: id(3951),
            agentId: agents[8].id,
            approvedBy: owner,
            approvedAt: at(-120),
            duration: { type: "persistent" },
            scope: {
              type: "capability",
              connectionId: connections[2].id,
              capabilities: [
                capabilities.find(
                  (capability) => capability.connectionId === connections[2].id,
                )!.id,
              ],
              constraints: [],
            },
            state: "active",
            reservedInvocationId: null,
            revokedAt: null,
            revokedBy: null,
          },
        ]
      : [],
    audit: populated
      ? [
          {
            id: id(3960),
            at: at(-120),
            actor: owner,
            action: "grant.approved",
            subjectId: id(3950),
          },
          {
            id: id(3961),
            at: at(-90),
            actor: owner,
            action: "group.updated",
            subjectId: groups[0].id,
          },
        ]
      : [],
    setupChoices: [],
    capabilities,
    catalogue: connections.map((connection) => ({
      connectionId: connection.id,
      state: "available",
    })),
    crewCapabilities: [
      ...new Set(
        groups.flatMap((group) =>
          group.grants.crew.map((grant) => grant.action),
        ),
      ),
    ].map((action) => ({
      action,
      label: action.replaceAll(".", " ").replaceAll("_", " "),
      description: `Allow agents in this group to ${action.replaceAll(".", " ")}.`,
    })),
    canVerifyConnections: false,
    canGuideConnections: false,
    connectionSetups: [],
  };
  const templates: EnvironmentTemplate[] = populated
    ? [
        "Web development",
        "Creative and marketing",
        "Research and administration",
      ].map((name, index) => ({
        id: id(1200 + index),
        projectId,
        revision: 1,
        name,
        description: [
          "Node.js, npm, Git, and a local development server.",
          "Image tools and editorial resources for campaign work.",
          "A minimal environment for research and service-connected tasks.",
        ][index],
        tools: (index === 0
          ? ["node", "npm", "git"]
          : index === 1
            ? ["python3", "magick"]
            : ["python3"]
        ).map((name) => ({
          name,
          versionRequirement: name === "node" ? ">=22" : null,
        })),
        executableDirectories: ["/preview/tools/bin"],
        readableDirectories: ["/preview/studio"],
        environment: { NODE_ENV: "development" },
        capabilities: {
          packageDownloads: index === 0,
          network: true,
          localhostPorts: [],
        },
        preparation: {
          instructions:
            "Check the available tools and prepare an isolated working environment before starting the assigned work.",
          commands: [],
        },
        updatedAt: at(-1440),
      }))
    : [];
  const schedules: Record<string, ManagerSchedules> = {};
  for (const [index, agent] of agents.slice(0, 4).entries())
    schedules[agent.id] = {
      revision: "preview-1",
      schedules: [
        {
          id: id(4000 + index * 2),
          name: "Review team progress",
          instruction:
            "Check your workers’ status and notes. Help resolve blockers and collect important updates for the owner.",
          enabled: true,
          timing: { kind: "interval", minutes: 10 },
          run: {
            lastAt: Date.parse(at(-8)),
            nextAt: Date.parse(at(2)),
            status: "completed",
          },
        },
        {
          id: id(4001 + index * 2),
          name: "Morning briefing",
          instruction:
            "Prepare a concise summary of priorities, decisions, and important results.",
          enabled: index < 2,
          timing: { kind: "daily", time: "09:00", timeZone: "Europe/London" },
          run: { nextAt: Date.parse(at(1440)) },
        },
      ],
    };
  return {
    snapshot,
    histories,
    access,
    extras: {
      ...(populated ? sampleProfilePictures() : {}),
      voiceArtifacts,
      schedules,
      templates: {
        templates,
        assignments: agents
          .filter((agent) => !agent.archivedAt)
          .map((agent, index) => ({
            agentId: agent.id,
            revision: 1,
            templateId:
              templates[
                definitions[index][2] === 0
                  ? 0
                  : definitions[index][2] === 1
                    ? 1
                    : 2
              ].id,
            templateRevision: 1,
            updatedAt: at(-120),
          })),
        notifications: [],
      },
      environments: {
        workspaces: policies.map((policy, index) => ({
          policy,
          workspace: {
            path:
              index === 0
                ? "/preview/studio/website"
                : "/preview/studio/shared-assets",
            device: 0,
            inode: 135 + index,
          },
          writable: index === 0,
          executableDirectories: [],
          managedWorktreeRoot: null,
          gitDirectory: null,
        })),
        environments: [],
      },
      setup: null,
      voices: [
        { id: "marin", name: "Marin" },
        { id: "cedar", name: "Cedar" },
      ],
      projectFolder: "/preview/studio",
      skillDocuments: Object.fromEntries(
        skills.map((skill) => [
          skill.id,
          {
            skill,
            resources: [],
            markdown: `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n# ${skill.name}\n\n${skill.description}\n\n1. Understand the assigned outcome.\n2. Choose a focused approach and maintain useful notes.\n3. Verify the result and report decisions or limitations.\n`,
          },
        ]),
      ),
      usage: {
        status: "available",
        snapshot: {
          observedAt: at(),
          ordinaryUsageAllowed: true,
          limits: [
            {
              limitId: "sample-subscription",
              limitName: "Sample subscription",
              normalModelSlug: "gpt-6.1-sol",
              primary: {
                usedPercent: 34,
                windowDurationMins: 300,
                resetsAt: Date.parse(at(180)) / 1000,
              },
              secondary: {
                usedPercent: 61,
                windowDurationMins: 10080,
                resetsAt: Date.parse(at(4320)) / 1000,
              },
            },
          ],
          resetCredits: {
            availableCount: 2,
            credits: [
              {
                resetType: "codexRateLimits",
                status: "available",
                grantedAt: Date.parse(at(-10080)) / 1000,
                expiresAt: Date.parse(at(2880)) / 1000,
                title: "Sample full reset",
                description: "Fictional preview data.",
              },
            ],
          },
        },
      },
    },
  };
}
