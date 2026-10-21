#!/usr/bin/env node
import type { TaskRecord } from "./execution/contracts.mjs";
import type { LoadedProject } from "./config/contracts.mjs";
import {
  parseRuntimeProject,
  requireExecutionProject,
} from "./config/shape.mjs";
import { orchestrationTools } from "./backend/mcp-tools.mjs";
import { toolArguments, mcpMessage } from "./backend/mcp-contracts.mjs";
import type { ToolDefinition, ToolSchema } from "./backend/mcp-contracts.mjs";
import {
  parseApprovalResponse,
  parseRequestId,
} from "./backend/approval-input.mjs";
import { parseRecord, record } from "./shared/errors.mjs";
import { errorCode, errorMessage } from "./shared/errors.mjs";
import readline from "node:readline";
import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  createTask,
  readTask,
  loadTasks,
  reportTask,
  answerQuestion,
  acknowledgeAttention,
  requestWorkerAction,
  updateWorkNotes,
} from "./orchestration-store.mjs";
import { requestWorkerRecovery } from "./orchestration-store.mjs";
import { reviewProjectRecovery } from "./project-environment.mjs";
import {
  listWorkerRequests,
  decideWorkerRequest,
} from "./worker-approvals.mjs";
import { requestWorkerModel } from "./orchestration-store.mjs";

const [stateDirArg, role, taskId, runId] = process.argv.slice(2);
if (
  !stateDirArg ||
  !["manager", "worker"].includes(role) ||
  (role === "worker" && (!taskId || !runId))
) {
  process.stderr.write(
    "Usage: node orchestration-mcp.mjs <stateDir> manager | <stateDir> worker <taskId> <runId>\n",
  );
  process.exit(1);
}
const stateDir = path.resolve(stateDirArg);
const runtime =
  role === "manager" && taskId
    ? parseRecord(await readFile(path.resolve(taskId), "utf8"))
    : null;
const project = runtime?.project ? parseRuntimeProject(runtime.project) : null;
const repositoryMode = project?.mode === "repository";
function scoped(task: TaskRecord) {
  if (
    project &&
    task &&
    task.projectId !== project.id &&
    !(project.mode === "fixture" && !task.projectId)
  )
    throw new Error("Task belongs to another project");
  return task;
}
const tools = orchestrationTools(role, repositoryMode);
async function callTool(name: unknown, input: unknown) {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error("Unknown tool for this role");
  const argsFor = <T,>() => toolArguments<T>(tool, input);
  if (name === "update_work_notes") {
    const args = argsFor<{
      taskId?: string;
      updateId: string;
      markdown: string;
    }>();
    const id = role === "worker" ? taskId! : args.taskId!;
    scoped(await readTask(stateDir, id));
    return updateWorkNotes(stateDir, id, {
      ...args,
      runId: role === "worker" ? runId : null,
    });
  }
  if (role === "worker")
    return reportTask(
      stateDir,
      taskId!,
      runId!,
      argsFor<Parameters<typeof reportTask>[3]>(),
    );
  switch (name) {
    case "request_attention": {
      const args = argsFor<{ requestId: string; message: string }>();
      return {
        ok: true,
        attention: { requestId: args.requestId, message: args.message },
      };
    }
    case "submit_task": {
      const args = argsFor<Parameters<typeof createTask>[1]>();
      if (project && !project.readiness?.ready)
        throw new Error(
          `Project configuration is not ready: ${(project.readiness?.issues || ["configuration incomplete"]).join("; ")}`,
        );
      if (repositoryMode) {
        if (
          !project.repositories?.some((repo) => repo.id === args.repositoryId)
        )
          throw new Error("Unknown configured repositoryId");
        const key = project.linear?.teamKey;
        if (
          !key ||
          !/^[A-Z][A-Z0-9]*$/.test(key) ||
          !args.ticket.startsWith(`${key}-`) ||
          !/^[1-9][0-9]*$/.test(args.ticket.slice(key.length + 1))
        )
          throw new Error(
            "Ticket must match the configured Linear team key; manager must verify the actual ticket",
          );
      } else if (args.repositoryId)
        throw new Error("Fixture tasks do not accept repositoryId");
      return createTask(stateDir, { ...args, projectId: project?.id || null });
    }
    case "get_status": {
      const args = argsFor<{ taskId?: string }>();
      const requests = await listWorkerRequests({ stateDir });
      const withApprovals = (task: TaskRecord) => ({
        ...scoped(task),
        approvals: requests.filter(
          (request) =>
            request.taskId === task.id &&
            request.runId === task.runId &&
            ["pending", "decided", "delivered", "delivery-unknown"].includes(
              request.status,
            ),
        ),
      });
      return args.taskId
        ? withApprovals(await readTask(stateDir, args.taskId))
        : (await loadTasks(stateDir)).map(withApprovals);
    }
    case "answer_worker_approval": {
      const args = argsFor<{
        taskId: string;
        runId: string;
        approvalId: string;
        threadId: string;
        turnId?: string | null;
        turnIdJson?: string;
        requestIdJson: string;
        responseJson: string;
      }>();
      scoped(await readTask(stateDir, args.taskId));
      const { requestIdJson, responseJson, turnIdJson, ...identity } = args;
      const hasTurn = Object.hasOwn(args, "turnId"),
        hasJsonTurn = Object.hasOwn(args, "turnIdJson");
      if (hasTurn === hasJsonTurn)
        throw new Error("Supply exactly one of turnId or turnIdJson");
      if (hasJsonTurn) {
        if (JSON.parse(turnIdJson || "") !== null)
          throw new Error("turnIdJson must encode JSON null");
        identity.turnId = null;
      }
      return decideWorkerRequest({
        ...identity,
        stateDir,
        turnId: identity.turnId ?? null,
        requestId: parseRequestId(requestIdJson),
        response: parseApprovalResponse(responseJson),
      });
    }
    case "review_worker_recovery": {
      const args = argsFor<{ taskId: string; action: string }>();
      return reviewProjectRecovery({
        stateDir,
        task: scoped(await readTask(stateDir, args.taskId)),
        project: project ? requireExecutionProject(project) : null,
        mode: args.action,
      });
    }
    case "request_worker_recovery": {
      const args = argsFor<Parameters<typeof requestWorkerRecovery>[1]>();
      scoped(await readTask(stateDir, args.taskId));
      return requestWorkerRecovery(stateDir, args);
    }
    case "answer_question": {
      const args = argsFor<Parameters<typeof answerQuestion>[1]>();
      scoped(await readTask(stateDir, args.taskId));
      return answerQuestion(stateDir, args);
    }
    case "set_worker_model": {
      const args = argsFor<Parameters<typeof requestWorkerModel>[1]>();
      scoped(await readTask(stateDir, args.taskId));
      return requestWorkerModel(stateDir, args);
    }
    case "worker_action": {
      const args = argsFor<Parameters<typeof requestWorkerAction>[1]>();
      scoped(await readTask(stateDir, args.taskId));
      return requestWorkerAction(stateDir, args);
    }
    case "acknowledge_attention": {
      const args = argsFor<Parameters<typeof acknowledgeAttention>[1]>();
      scoped(await readTask(stateDir, args.taskId));
      return acknowledgeAttention(stateDir, args);
    }
  }
}
function send(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
async function request(input: unknown) {
  const message = mcpMessage(input);
  if (!message) {
    send({
      jsonrpc: "2.0",
      id: record(input) ? (input.id ?? null) : null,
      error: { code: -32600, message: "Invalid Request" },
    });
    return;
  }
  if (!Object.hasOwn(message, "id")) return; // initialized/cancelled notifications need no response.
  const result = (value: unknown) =>
    send({ jsonrpc: "2.0", id: message.id, result: value });
  switch (message.method) {
    case "initialize":
      result({
        protocolVersion: message.params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: `local-worker-${role}`, version: "0.1.0" },
      });
      return;
    case "ping":
      result({});
      return;
    case "tools/list":
      result({ tools });
      return;
    case "tools/call":
      try {
        const value = await callTool(
          message.params?.name,
          message.params?.arguments ?? {},
        );
        result({
          content: [{ type: "text", text: JSON.stringify(value) }],
          ...(message.params?.name === "request_attention"
            ? { structuredContent: value }
            : {}),
        });
      } catch (error) {
        result({
          isError: true,
          content: [{ type: "text", text: errorMessage(error) }],
        });
      }
      return;
    default:
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Method not found" },
      });
  }
}
const lines = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});
let pending = Promise.resolve();
lines.on("line", (line) => {
  if (!line.trim()) return;
  if (line.length > 100000) {
    send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Request exceeds limit" },
    });
    return;
  }
  pending = pending
    .then(async () => {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        send({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        });
        return;
      }
      await request(parsed);
    })
    .catch((error) => {
      process.stderr.write(`${errorMessage(error)}\n`);
    });
});
