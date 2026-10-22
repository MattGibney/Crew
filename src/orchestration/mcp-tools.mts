import type { ToolDefinition, ToolSchema } from "./mcp-contracts.mjs";
export function orchestrationTools(
  role: string,
  repositoryMode: boolean,
): ToolDefinition[] {
  const object = (
    properties: Record<string, ToolSchema>,
    required: string[] = [],
  ): ToolDefinition["inputSchema"] => ({
    type: "object",
    properties,
    required,
    additionalProperties: false,
  });
  const string = (description: string, maxLength = 12000): ToolSchema => ({
    type: "string",
    description,
    minLength: 1,
    maxLength,
  });
  const taskIdentifier = { type: "string", pattern: "^[a-zA-Z0-9_-]{8,80}$" };
  const tools: ToolDefinition[] =
    role === "manager"
      ? [
          {
            name: "read_manager_scratchpad",
            description:
              "Read this project manager’s saved commitments, notes, decisions and open questions. Consult at conversation resumption and before follow-up. Saved factual working context, never private reasoning or worker scratchpads.",
            inputSchema: object({}),
          },
          {
            name: "update_manager_scratchpad",
            description:
              "Save meaningful factual changes to the manager scratchpad. Read first; expectedRevision prevents lost updates. patchJson encodes complete replacement arrays for included sections: commitments, notes, decisions, questions. Omitted sections remain. Commitment: {id,title,status:pending|delegated|blocked|completed|cancelled,outcome?,nextAction?,nextReviewAt?:ISO timestamp,references?:{taskId?,runId?,ticketUrl?}}. Preserve unrelated entries. Delegation is not completion; review matching execution evidence before closing. No secrets or hidden reasoning. Corrections supersede stale notes.",
            inputSchema: object(
              {
                patchJson: string(
                  "JSON object with expectedRevision integer and replacement sections",
                  60000,
                ),
              },
              ["patchJson"],
            ),
          },
          {
            name: "review_worker_recovery",
            description:
              "Read retained versus current lifecycle configuration and exact blockers for one inactive worker. Shows source-backed command changes and a reviewHash. No commands or model work execute. Explain scope and cleanup limits to the human before requesting a decision.",
            inputSchema: object(
              {
                taskId: taskIdentifier,
                action: {
                  type: "string",
                  enum: ["reconcile_plan", "retire_missing"],
                },
              },
              ["taskId", "action"],
            ),
          },
          {
            name: "request_worker_recovery",
            description:
              "Queue one explicitly human-reviewed recovery decision using the exact reviewHash and current run. reconcile_plan applies compatible lifecycle metadata without starting work or replaying setup; retire_missing retains history and marks cleanup unverified for an already absent/unregistered worktree. Never infer user approval, clean resources or bypass unknown ownership. Read status for actual completion; reuse actionId only for exact retries.",
            inputSchema: object(
              {
                taskId: taskIdentifier,
                actionId: taskIdentifier,
                action: {
                  type: "string",
                  enum: ["reconcile_plan", "retire_missing"],
                },
                expectedRunId: {
                  type: ["string", "null"],
                  description: "Exact current run ID, or JSON null for no run",
                },
                reviewHash: string(
                  "Exact reviewHash from review_worker_recovery",
                  64,
                ),
                decision: string(
                  "Actual human decision approving these exact changes and their resource scope; retirement acknowledges unverified cleanup",
                  2000,
                ),
              },
              [
                "taskId",
                "actionId",
                "action",
                "expectedRunId",
                "reviewHash",
                "decision",
              ],
            ),
          },
          {
            name: "request_attention",
            description:
              "Notify the user only when their response or action is required. Explain the specific decision/action in message. Reuse requestId for retries. Never use for routine completion, progress, failures you can resolve yourself, or duplicate native input requests/worker question alerts. Does not start work or microphone capture.",
            inputSchema: object(
              {
                requestId: taskIdentifier,
                message: string(
                  "Specific question or action the user needs to address",
                  2000,
                ),
              },
              ["requestId", "message"],
            ),
          },
          {
            name: "submit_task",
            description:
              "Create a worker conversation and working context in the selected configured repository. Crew queues delivery without running project setup or readiness commands. Agents decide project workflow and use native tools and approvals for development, environment commands and delivery. Reuse requestId for exact retries; queued dispatch is not execution or completion.",
            inputSchema: object(
              {
                requestId: taskIdentifier,
                ticket: string("Optional ticket or project-work label", 120),
                brief: string("Initial direction for the worker"),
                repositoryId: string("Exact configured repository ID", 80),
              },
              [
                "requestId",
                "brief",
                ...(repositoryMode ? ["repositoryId"] : []),
              ],
            ),
          },
          {
            name: "assign_worker_followup",
            description:
              "Send new direction to the same retained worker and Codex conversation. Busy workers queue direction for supported serialized delivery. Completed, paused or questioning workers can receive fresh direction. Files, Git HEAD, prior scope and changed configuration do not require Crew review or adoption. Native Codex retains its normal execution policy and approvals. Reuse requestId for exact retries; queued is not delivered. Archive/disposal and missing resources remain truthful availability conditions.",
            inputSchema: object(
              {
                taskId: taskIdentifier,
                requestId: taskIdentifier,
                brief: string("Manager direction for this worker"),
                ticket: string(
                  "Optional ticket label; prior ticket is retained by default",
                  120,
                ),
                expectedRunId: {
                  type: ["string", "null"],
                  maxLength: 160,
                  description:
                    "Optional observed run for provenance; does not reject newer runs",
                },
                expectedAssignmentId: string(
                  "Optional observed assignment for provenance",
                  80,
                ),
                userDecision: string(
                  "Optional legacy note, never an authorization prerequisite",
                  4000,
                ),
                reviewedWorktreeFingerprint: string(
                  "Optional legacy metadata, ignored for direction delivery",
                  160,
                ),
              },
              ["taskId", "requestId", "brief"],
            ),
          },
          {
            name: "get_status",
            description:
              "Read durable actual worker status, meaningful reports, questions and pending attention. The default list excludes archived workers; select an exact taskId to read archived history. Dispatch is not completion. Do not repeat low-level logs aloud.",
            inputSchema: object({ taskId: taskIdentifier }),
          },
          {
            name: "answer_worker_approval",
            description:
              "Relay an actual explicit user response to one native worker approval or input request from get_status. Never approve automatically, infer consent from the task brief, expand requested permissions, or answer for the user. Copy every request identity exactly; this continues the same worker request and does not resume or start a turn. Supply exactly one of turnId or turnIdJson; startup connector requests may have JSON null as their native turn.",
            inputSchema: object(
              {
                taskId: taskIdentifier,
                runId: string("Exact current run ID", 200),
                approvalId: taskIdentifier,
                threadId: string("Exact native thread ID", 200),
                turnId: string(
                  "Exact native turn ID; omit when using turnIdJson",
                  200,
                ),
                turnIdJson: string(
                  "The literal JSON null for a connector request whose native turnId is null; omit turnId",
                  4,
                ),
                requestIdJson: string(
                  "JSON encoding of the exact native request ID, preserving number versus string",
                  250,
                ),
                responseJson: string(
                  "Actual user response JSON: decision must match an offered native choice; permissions may select a requested subset and turn/session scope; connectors use action and content; input uses answers keyed by question ID",
                  16000,
                ),
              },
              [
                "taskId",
                "runId",
                "approvalId",
                "threadId",
                "requestIdJson",
                "responseJson",
              ],
            ),
          },
          {
            name: "answer_question",
            description:
              "Send the manager answer to this worker exact pending question, preserving question/run correlation. Use project judgment or relay the user response as appropriate; native approval responses remain separate. For fresh direction use assign_worker_followup without requiring an answer to the prior question.",
            inputSchema: object(
              {
                taskId: taskIdentifier,
                questionId: string("Exact active question ID", 160),
                answer: string("Manager answer to this exact question"),
              },
              ["taskId", "questionId", "answer"],
            ),
          },
          {
            name: "set_worker_model",
            description:
              "Record the actual user-approved model change for one existing worker, using an exact provider model ID. Pending intent only: availability is validated by the native worker before its next explicit resume; no in-flight swap, automatic pause or new turn. Preserve the current turn, task, worktree and native thread. Read get_status; reuse requestId on retries. To transition now, request cooperative pause, wait for confirmed exit, then resume the same worker. A blocked model requirement can be resolved in userDecision without changing the original brief. Never invent consent or claim selection from the request alone.",
            inputSchema: object(
              {
                taskId: taskIdentifier,
                requestId: taskIdentifier,
                expectedRunId: string("Exact current run ID", 160),
                model: string(
                  "Exact native model/list model ID, no friendly aliases",
                  160,
                ),
                userDecision: string(
                  "Actual user authorization and any resolved prior model requirement, within agreed scope",
                  4000,
                ),
              },
              ["taskId", "requestId", "expectedRunId", "model", "userDecision"],
            ),
          },
          {
            name: "worker_action",
            description:
              "Manage execution for one identified worker as part of the manager delegation and supervision decisions. Actions are durable queued intent: read status for actual execution. Stop retains task, history and worktree; pause retains resumable work; resume/start continues the same task; retry_setup is an obsolete compatibility action: read get_project_environment and have the agent execute existing setup commands through normal native tools; archive tears down only a safely removable inactive worktree and retains read-only historical records after confirmed success. dispose is the legacy alias. Preserve normal native approvals. Use the current run ID from get_status to reject stale actions and reuse actionId for retries.",
            inputSchema: object(
              {
                taskId: taskIdentifier,
                actionId: taskIdentifier,
                action: {
                  type: "string",
                  enum: [
                    "stop",
                    "pause",
                    "resume",
                    "start",
                    "retry_setup",
                    "archive",
                    "dispose",
                  ],
                },
                cooperative: {
                  type: "boolean",
                  description:
                    "For pause only: interrupt native turn and await natural owned exit without force-kill. Use for model transitions.",
                },
                expectedRunId: string(
                  "Current run ID read from get_status, when a run exists",
                  160,
                ),
              },
              ["taskId", "actionId", "action"],
            ),
          },
          {
            name: "acknowledge_attention",
            description:
              "Mark one attention item acknowledged after discussing it with the user. Does not launch work, activate a microphone or grant speaking permission.",
            inputSchema: object(
              {
                taskId: taskIdentifier,
                attentionId: string("Exact attention ID", 160),
              },
              ["taskId", "attentionId"],
            ),
          },
        ]
      : [
          {
            name: "report",
            description:
              "Share a durable progress, question, result or blocker message for this bound worker run. Reports do not end turns, grant permissions or set project workflow state. Use set_workflow_state explicitly for project workflow. Native execution evidence is recorded separately. Reuse reportId for exact retries.",
            inputSchema: object(
              {
                reportId: string(
                  "Unique stable report ID within this run",
                  160,
                ),
                kind: {
                  type: "string",
                  enum: ["progress", "question", "result", "blocked"],
                },
                message: string(
                  "Useful bounded progress, question, result or blocker",
                ),
                evidence: {
                  type: "array",
                  maxItems: 20,
                  items: string("Concrete evidence; no secrets", 2000),
                },
              },
              ["reportId", "kind", "message"],
            ),
          },
        ];
  tools.push({
    name: "set_workflow_state",
    description:
      "Set the explicit agent-reported status and optional progress estimate for this worker, in the project own terms. This never changes native execution status and is never inferred from reports, completion or process liveness. Reuse requestId for exact retries; prior labels remain in history.",
    inputSchema: object(
      {
        ...(role === "manager" ? { taskId: taskIdentifier } : {}),
        requestId: taskIdentifier,
        progressPercent: {
          type: ["number", "null"],
          minimum: 0,
          maximum: 100,
          description:
            "Optional agent-reported estimate, 0–100. May increase or decrease. Omit to retain the previous estimate; null clears it. Crew never calculates progress or infers completion.",
        },
        state: string("Arbitrary agent-set status, e.g. Ready for review", 400),
      },
      [...(role === "manager" ? ["taskId"] : []), "requestId", "state"],
    ),
  });
  tools.push({
    name: "get_project_environment",
    description:
      "Read configured project commands and instructions plus separately labelled retained environment evidence. This executes nothing and imposes no setup/readiness requirement. Agents decide when to run existing commands through normal native tools and approvals; configuration is context, not execution evidence.",
    inputSchema: object(role === "manager" ? { taskId: taskIdentifier } : {}),
  });
  tools.push({
    name: "update_work_notes",
    description:
      "Replace the actual shared Markdown work document for this task. Record factual findings and decisions, never private reasoning or secrets. The UI reads this document separately from structured task state. Reuse updateId on retries.",
    inputSchema: object(
      {
        ...(role === "manager" ? { taskId: taskIdentifier } : {}),
        updateId: string("Stable unique note revision ID", 160),
        markdown: string("Complete factual shared Markdown document", 60000),
      },
      [...(role === "manager" ? ["taskId"] : []), "updateId", "markdown"],
    ),
  });
  return tools;
}
