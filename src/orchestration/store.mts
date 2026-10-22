import {
  validateWorkLink,
  workLinkFromTicket,
  retainedWorkLink,
  sameWorkLink,
  type WorkLink,
} from "../shared/tracking.mjs";
import { text, identifier } from "./task-fields.mjs";
import {
  currentAssignment,
  synchronizeAssignment,
  preserveAssignments,
} from "./assignments.mjs";
export { currentAssignment, ensureAssignments } from "./assignments.mjs";
import type { TaskRecord, TaskReport } from "../workers/contracts.mjs";
import {
  validatePersistedTask as validate,
  REPORT_KINDS,
} from "./persisted-validation.mjs";
import { recordHistory } from "./task-history.mjs";
import { taskMarkdown } from "./task-markdown.mjs";
import { errorCode } from "../workers/errors.mjs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { withStateLock } from "./state-lock.mjs";
export { withStateLock } from "./state-lock.mjs";
import { isArchivedTask } from "../shared/worker-archive.mjs";

const now = () => new Date().toISOString();
const taskPath = (dir: string, id: string) =>
  path.join(dir, "tasks", `${identifier(id)}.json`);
async function readUnlocked(dir: string, id: string) {
  return validate(JSON.parse(await fs.readFile(taskPath(dir, id), "utf8")), id);
}
async function loadUnlocked(dir: string) {
  let names;
  try {
    names = await fs.readdir(path.join(dir, "tasks"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  const tasks = [];
  for (const name of names.sort()) {
    if (name.endsWith(".json"))
      tasks.push(await readUnlocked(dir, name.slice(0, -5)));
  }
  return tasks;
}
async function atomic(file: string, content: string) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, file);
  } finally {
    await fs.unlink(temp).catch((error) => {
      if (errorCode(error) !== "ENOENT") throw error;
    });
  }
}
async function save(dir: string, task: TaskRecord) {
  validate(task, task.id);
  await fs.mkdir(path.join(dir, "tasks"), { recursive: true, mode: 0o700 });
  // JSON is authoritative; Markdown is a human-readable projection only.
  await atomic(taskPath(dir, task.id), `${JSON.stringify(task, null, 2)}\n`);
  await atomic(path.join(dir, "tasks", `${task.id}.md`), taskMarkdown(task));
  return task;
}
export async function readTask(dir: string, id: string) {
  return readUnlocked(dir, identifier(id));
}
export async function loadTasks(dir: string) {
  return withStateLock(dir, ".schedule.lock", () => loadUnlocked(dir));
}
export async function createTask(
  dir: string,
  {
    requestId,
    ticket = "",
    workLink: requestedLink,
    brief,
    projectId = null,
    repositoryId = null,
  }: {
    requestId: string;
    ticket?: string;
    workLink?: WorkLink | null;
    brief: string;
    projectId?: string | null;
    repositoryId?: string | null;
  },
) {
  for (const [name, value] of Object.entries({ projectId, repositoryId }))
    if (
      value !== null &&
      (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(value))
    )
      throw new Error(`Invalid ${name}`);
  identifier(requestId);
  if (ticket) text(ticket, "ticket", 500);
  const workLink = validateWorkLink(
    requestedLink === undefined ? workLinkFromTicket(ticket) : requestedLink,
  );
  text(brief, "brief");
  return withStateLock(dir, ".schedule.lock", async () => {
    const retired = await fs
      .readdir(path.join(dir, "archive-actions"))
      .catch((error) => {
        if (errorCode(error) === "ENOENT") return [];
        throw error;
      });
    const tasks = await loadUnlocked(dir);
    const existing = tasks.find((task) => task.id === requestId);
    if (existing) {
      if (
        existing.ticket !== ticket ||
        !sameWorkLink(retainedWorkLink(existing), workLink) ||
        existing.brief !== brief ||
        (existing.projectId || null) !== projectId ||
        (existing.repositoryId || null) !== repositoryId
      )
        throw new Error(
          "Request ID already exists with different ticket or brief",
        );
      return existing;
    }
    if (
      retired.some(
        (name) => name.startsWith(`${requestId}.`) && name.endsWith(".json"),
      )
    )
      throw new Error(
        "Task ID is retained by an archive operation; choose a new task ID",
      );
    return withStateLock(dir, `.${requestId}.lock`, () => {
      const task: TaskRecord = {
        id: requestId,
        ticket,
        workLink,
        brief,
        projectId,
        repositoryId,
        status: "queued",
        revision: 1,
        createdAt: now(),
        updatedAt: now(),
        reports: [],
        attention: [],
        lifecycleRequests: [],
        answer: null,
        historyVersion: 1,
        history: [],
      };
      recordHistory(task);
      return save(dir, task);
    });
  });
}
export async function updateTask(
  dir: string,
  id: string,
  fn: (task: TaskRecord) => void | TaskRecord | Promise<void | TaskRecord>,
) {
  identifier(id);
  return withStateLock(dir, ".schedule.lock", () =>
    withStateLock(dir, `.${id}.lock`, async () => {
      const task = await readUnlocked(dir, id);
      const previous = structuredClone(task);
      const identity = {
        id: task.id,
        ticket: task.ticket,
        workLink: JSON.stringify(task.workLink),
        brief: task.brief,
        projectId: task.projectId,
        repositoryId: task.repositoryId,
        createdAt: task.createdAt,
        revision: task.revision,
        workerPromptSnapshot: task.workerPromptSnapshot
          ? JSON.stringify(task.workerPromptSnapshot)
          : null,
      };
      const returned = await fn(task);
      const next = returned === undefined ? task : returned;
      if (
        !next ||
        next.id !== identity.id ||
        next.ticket !== identity.ticket ||
        JSON.stringify(next.workLink) !== identity.workLink ||
        next.brief !== identity.brief ||
        next.projectId !== identity.projectId ||
        next.repositoryId !== identity.repositoryId ||
        next.createdAt !== identity.createdAt
      )
        throw new Error("Task identity is immutable");
      synchronizeAssignment(next, previous);
      preserveAssignments(next, previous);
      if (
        previous.workflowHistory &&
        JSON.stringify(
          next.workflowHistory?.slice(0, previous.workflowHistory.length),
        ) !== JSON.stringify(previous.workflowHistory)
      )
        throw new Error("Workflow history is immutable");
      if (
        previous.history &&
        JSON.stringify(next.history?.slice(0, previous.history.length)) !==
          JSON.stringify(previous.history)
      )
        throw new Error("Retained task history is immutable");
      if (JSON.stringify(next) === JSON.stringify(await readUnlocked(dir, id)))
        return next;
      recordHistory(next, previous);
      next.revision = identity.revision + 1;
      next.updatedAt = now();
      validate(next, id);
      return save(dir, next);
    }),
  );
}
export async function reportTask(
  dir: string,
  id: string,
  runId: string,
  { reportId, kind, message, evidence = [] }: Omit<TaskReport, "runId" | "at">,
) {
  text(runId, "run ID", 160);
  text(reportId, "report ID", 160);
  text(message, "message", 12000);
  if (
    !REPORT_KINDS.has(kind) ||
    !Array.isArray(evidence) ||
    evidence.length > 20
  )
    throw new Error("Invalid report kind or evidence");
  evidence.forEach((item) => text(item, "evidence", 2000));
  return updateTask(dir, id, (task) => {
    if (task.runId !== runId) throw new Error("Stale worker run");
    const existing = task.reports.find(
      (report) => report.reportId === reportId && report.runId === runId,
    );
    if (existing) {
      if (
        existing.kind !== kind ||
        existing.message !== message ||
        JSON.stringify(existing.evidence) !== JSON.stringify(evidence)
      )
        throw new Error("Report ID reused with changed content");
      return;
    }
    task.reports.push({
      reportId,
      runId,
      assignmentId: currentAssignment(task).id,
      kind,
      message,
      evidence,
      at: now(),
    });
  });
}
export async function answerQuestion(
  dir: string,
  {
    taskId,
    questionId,
    answer,
  }: { taskId: string; questionId: string; answer: string },
) {
  text(questionId, "question ID", 160);
  text(answer, "answer", 12000);
  return updateTask(dir, taskId, (task) => {
    if (
      !task.question ||
      task.question.id !== questionId ||
      task.question.runId !== task.runId
    )
      throw new Error("Question is stale or unknown");
    if (task.answer?.questionId === questionId) {
      if (task.answer.text !== answer)
        throw new Error("Question already answered differently");
      return;
    }
    if (!["awaiting_answer", "paused", "stopped"].includes(task.status))
      throw new Error("Task is not awaiting this answer");
    if (
      task.lifecycleRequests?.some((request) =>
        ["pending", "processing"].includes(request.status),
      )
    )
      throw new Error(
        "Wait for the pending worker lifecycle action before answering this question",
      );
    task.answer = { questionId, text: answer, at: now() };
    task.status = "resume_queued";
  });
}
export async function acknowledgeAttention(
  dir: string,
  { taskId, attentionId }: { taskId: string; attentionId: string },
) {
  text(attentionId, "attention ID", 160);
  return updateTask(dir, taskId, (task) => {
    const item = task.attention.find((entry) => entry.id === attentionId);
    if (!item) throw new Error("Unknown attention item");
    if (!item.ackedAt) item.ackedAt = now();
  });
}

// Requests are durable intent, not evidence that a process has stopped or restarted.
// The controller alone performs lifecycle transitions and marks each request handled.
// Recovery is a separate reviewed decision, never an implicit lifecycle retry.
export async function requestWorkerRecovery(
  dir: string,
  {
    taskId,
    actionId,
    action,
    expectedRunId,
    reviewHash,
    decision,
  }: {
    taskId: string;
    actionId: string;
    action: string;
    expectedRunId: string | null;
    reviewHash: string;
    decision: string;
  },
) {
  identifier(taskId);
  identifier(actionId, "action ID");
  if (
    !["reconcile_plan", "retire_missing"].includes(action) ||
    !/^[a-f0-9]{64}$/.test(reviewHash || "")
  )
    throw new Error("A matching recovery review is required");
  text(decision, "explicit user recovery decision", 2000);
  if (expectedRunId !== null) text(expectedRunId, "expected run ID", 160);
  return updateTask(dir, taskId, (task) => {
    const requests = (task.lifecycleRequests ||= []);
    const previous = requests.find((request) => request.id === actionId);
    if (previous) {
      if (
        previous.action !== action ||
        previous.expectedRunId !== expectedRunId ||
        previous.reviewHash !== reviewHash ||
        previous.decision !== decision
      )
        throw new Error("Recovery action ID reused with changed content");
      return;
    }
    if ((task.runId || null) !== expectedRunId)
      throw new Error("Stale worker run for recovery");
    if (
      !["paused", "stopped", "failed", "blocked", "completed"].includes(
        task.status,
      )
    )
      throw new Error("Stop or pause this worker before reviewed recovery");
    if (
      requests.some((request) =>
        ["pending", "processing"].includes(request.status),
      )
    )
      throw new Error("Worker already has a pending lifecycle action");
    if (requests.length >= 1000)
      throw new Error("Worker lifecycle request limit reached");
    requests.push({
      id: actionId,
      action,
      expectedRunId,
      reviewHash,
      decision,
      status: "pending",
      at: now(),
    });
  });
}

export async function requestWorkerAction(
  dir: string,
  {
    taskId,
    actionId,
    action,
    expectedRunId,
    cooperative = false,
    settleNaturally = false,
  }: {
    taskId: string;
    actionId: string;
    action: string;
    expectedRunId?: string | null;
    cooperative?: boolean;
    settleNaturally?: boolean;
  },
) {
  identifier(taskId);
  identifier(actionId, "action ID");
  if (
    ![
      "stop",
      "pause",
      "resume",
      "start",
      "retry_setup",
      "dispose",
      "archive",
    ].includes(action)
  )
    throw new Error("Invalid worker action");
  if (typeof cooperative !== "boolean" || (cooperative && action !== "pause"))
    throw new Error(
      "Cooperative interruption is supported only for pause requests",
    );
  if (
    typeof settleNaturally !== "boolean" ||
    (settleNaturally && (!cooperative || action !== "pause"))
  )
    throw new Error("Natural settlement requires a cooperative pause");
  if (expectedRunId !== undefined && expectedRunId !== null)
    text(expectedRunId, "expected run ID", 160);
  return updateTask(dir, taskId, (task) => {
    const requests = (task.lifecycleRequests ||= []);
    const existing = requests.find((request) => request.id === actionId);
    if (existing) {
      // An exact retry remains valid even after the controller advances to a new run.
      if (
        Boolean(existing.cooperative) !== cooperative ||
        Boolean(existing.settleNaturally) !== settleNaturally ||
        existing.action !== action ||
        (expectedRunId !== undefined &&
          existing.expectedRunId !== expectedRunId)
      )
        throw new Error("Action ID reused with changed content");
      return;
    }
    if (expectedRunId !== undefined && (task.runId || null) !== expectedRunId)
      throw new Error("Stale worker run for lifecycle action");
    if (
      isArchivedTask(task) ||
      ["disposed", "removed", "archived"].includes(task.status)
    )
      throw new Error("Worker has been archived");
    if (
      requests.some((request) =>
        ["pending", "processing"].includes(request.status),
      )
    )
      throw new Error("Worker already has a pending lifecycle action");
    if (requests.length >= 1000)
      throw new Error("Worker lifecycle request limit reached");
    requests.push({
      id: actionId,
      action,
      ...(cooperative ? { cooperative: true } : {}),
      ...(settleNaturally ? { settleNaturally: true } : {}),
      expectedRunId: task.runId || null,
      status: "pending",
      at: now(),
    });
  });
}

// A model request is next-turn intent, never an in-flight model swap or resume.
export async function requestWorkerModel(
  dir: string,
  {
    taskId,
    requestId,
    expectedRunId,
    model,
    userDecision,
  }: {
    taskId: string;
    requestId: string;
    expectedRunId: string;
    model: string;
    userDecision: string;
  },
) {
  identifier(taskId);
  identifier(requestId, "model request ID");
  text(expectedRunId, "expected run ID", 160);
  text(model, "model", 160);
  text(userDecision, "user decision", 4000);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(model))
    throw new Error("Use an exact provider model ID");
  return updateTask(dir, taskId, (task) => {
    const requests = (task.modelRequests ||= []);
    const existing = requests.find((request) => request.id === requestId);
    if (existing) {
      if (
        existing.expectedRunId !== expectedRunId ||
        existing.model !== model ||
        existing.userDecision !== userDecision
      )
        throw new Error("Model request ID reused with changed content");
      return;
    }
    if (task.runId !== expectedRunId)
      throw new Error("Stale worker run for model change");
    if (
      ![
        "running",
        "paused",
        "stopped",
        "blocked",
        "awaiting_answer",
        "failed",
      ].includes(task.status)
    )
      throw new Error(
        "Worker must be running or retained for explicit resume before changing its model",
      );
    if (
      task.lifecycleRequests?.some((request) =>
        ["pending", "processing"].includes(request.status),
      )
    )
      throw new Error(
        "Worker has a pending lifecycle action; wait for its boundary",
      );
    if (requests.length >= 100)
      throw new Error("Worker model request limit reached");
    if (["pending", "validating"].includes(task.modelSelection?.status || ""))
      throw new Error(
        "Worker already has a pending model change; apply or review it before another change",
      );
    const request = {
      id: requestId,
      expectedRunId,
      model,
      userDecision,
      at: now(),
    };
    requests.push(request);
    task.modelSelection = {
      ...request,
      status: "pending",
      message:
        "Pending provider validation on the next explicit resume; the current turn is unchanged.",
    };
    (task.history ||= []).push({
      id: `model:${requestId}`,
      actor: "manager",
      kind: "model_request",
      message: `Requested model ${model} for the next explicit resume. User decision: ${userDecision}`,
      at: request.at,
      runId: expectedRunId,
    });
  });
}

// Shared prose is a real separate Markdown document, never the generated task projection.
export async function updateWorkNotes(
  dir: string,
  id: string,
  {
    updateId,
    markdown,
    runId = null,
  }: { updateId: string; markdown: string; runId?: string | null },
) {
  text(updateId, "note update ID", 160);
  text(markdown, "work notes", 60000);
  if (Buffer.byteLength(markdown) > 60000)
    throw new Error("Work notes exceed the document byte limit");
  return updateTask(dir, id, async (task) => {
    if (isArchivedTask(task))
      throw new Error("Archived worker history is read-only");
    if (runId && task.runId !== runId) throw new Error("Stale worker run");
    if (task.workNotes?.updateId === updateId) {
      if (
        (await fs.readFile(
          path.join(dir, "tasks", `${id}.notes.md`),
          "utf8",
        )) !== markdown
      )
        throw new Error("Note update ID reused with changed content");
      return;
    }
    await atomic(path.join(dir, "tasks", `${id}.notes.md`), markdown);
    task.workNotes = {
      updateId,
      updatedAt: now(),
      actor: runId ? "worker" : "manager",
      runId,
    };
    (task.history ||= []).push({
      id: `notes:${randomUUID()}`,
      at: task.workNotes.updatedAt,
      actor: task.workNotes.actor,
      kind: "notes",
      message: "Updated shared work notes",
      runId,
    });
  });
}

import { createArchiveStore } from "./task-archive.mjs";
export const { manageArchivedTask, ensureArchiveExecutionStopped } =
  createArchiveStore({ readUnlocked, save, recordHistory, atomic });
export { requestWorkerFollowup, setWorkflowState } from "./task-directions.mjs";
