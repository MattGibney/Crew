import { promises as fs } from "node:fs";
import path from "node:path";
import type { TaskRecord, Project } from "./contracts.mjs";
import { inspectUpdateEvidence } from "../update-evidence.mjs";
import { isArchivedTask } from "../worker-archive.mjs";
import { withStateLock } from "./state-lock.mjs";
import { identifier } from "./task-fields.mjs";
import { errorCode, isRecord } from "./errors.mjs";
const now = () => new Date().toISOString();
interface ArchiveStore {
  readUnlocked: (dir: string, id: string) => Promise<TaskRecord>;
  save: (dir: string, task: TaskRecord) => Promise<TaskRecord>;
  recordHistory: (task: TaskRecord, previous: TaskRecord | null) => void;
  atomic: (file: string, content: string) => Promise<void>;
}
export function createArchiveStore({
  readUnlocked,
  save,
  recordHistory,
  atomic,
}: ArchiveStore) {
  async function ensureArchiveExecutionStopped(dir: string, task: TaskRecord) {
    const checked = await inspectUpdateEvidence({
      stateDir: dir,
      view: { tasks: [task] },
    });
    const evidence = checked.tasks[0].updateEvidence;
    if (
      !evidence ||
      !["stopped", "absent"].includes(evidence.worker) ||
      !["stopped", "absent"].includes(evidence.runtime) ||
      evidence.hooks.some((hook) => !["stopped", "absent"].includes(hook.state))
    )
      throw new Error(
        "Archived worker execution is live or unverified; preserve its records until ownership and terminal evidence are resolved",
      );
  }

  // Explicit archive record operations never run project commands or touch provider history.
  async function manageArchivedTask(
    dir: string,
    {
      taskId,
      action,
      operationId,
      expectedRevision,
    }: {
      taskId: string;
      action: string;
      operationId: string;
      expectedRevision: number;
    },
    project: Project | null,
  ) {
    identifier(taskId);
    identifier(operationId, "operation ID");
    if (
      !["restore", "delete"].includes(action) ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 1
    )
      throw new Error("Invalid archive operation");
    if (!project?.id)
      throw new Error("Archive operation requires the selected project");
    return withStateLock(dir, ".schedule.lock", async () => {
      const root = await fs.realpath(dir);
      const safeDirectory = async (target: string) => {
        const stat = await fs.lstat(target);
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          (await fs.realpath(target)) !== target
        )
          throw new Error("Archive storage ownership could not be verified");
      };
      await safeDirectory(path.join(root, "tasks"));
      const journalDir = path.join(root, "archive-actions");
      await fs.mkdir(journalDir, { recursive: true, mode: 0o700 });
      await safeDirectory(journalDir);
      const journalFile = path.join(
        journalDir,
        `${taskId}.${operationId}.json`,
      );
      const safeFile = async (file: string) => {
        try {
          const stat = await fs.lstat(file);
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            (await fs.realpath(file)) !== file
          )
            throw new Error("Archive record is not a safe regular file");
          return true;
        } catch (error) {
          if (errorCode(error) === "ENOENT") return false;
          throw error;
        }
      };
      const journalValue: unknown = (await safeFile(journalFile))
        ? JSON.parse(await fs.readFile(journalFile, "utf8"))
        : null;
      let journal: Record<string, unknown> | null = isRecord(journalValue)
        ? journalValue
        : null;
      if (journalValue !== null && !journal)
        throw new Error("Archive journal is malformed");
      const identity = {
        taskId,
        action,
        operationId,
        expectedRevision,
        projectId: project.id,
      };
      if (
        journal &&
        Object.entries(identity).some(
          ([key, value]) => journal?.[key] !== value,
        )
      )
        throw new Error("Archive operation ID reused with changed content");
      if (journal?.status === "deleting" && journal.validatedTerminal !== true)
        throw new Error(
          "Archive deletion journal lacks verified terminal evidence; preserve remaining records",
        );
      if (journal?.status === "completed") return { ok: true, taskId, action };
      let task: TaskRecord | undefined;
      try {
        await safeFile(path.join(root, "tasks", `${taskId}.json`));
        task = await readUnlocked(root, taskId);
      } catch (error) {
        if (errorCode(error) !== "ENOENT" || journal?.status !== "deleting")
          throw error;
      }
      if (task) {
        if (
          task.projectId !== project.id &&
          !(project.mode === "fixture" && !task.projectId)
        )
          throw new Error("Task belongs to another project");
        if (
          action === "restore" &&
          task.archiveRestoration?.operationId === operationId
        ) {
          journal = {
            ...identity,
            status: "completed",
            at: task.archiveRestoration.at,
          };
          await atomic(journalFile, JSON.stringify(journal));
          return { ok: true, taskId, action };
        }
        if (!isArchivedTask(task))
          throw new Error(
            "Only a confirmed archived worker can be restored or permanently deleted",
          );
        if (task.revision !== expectedRevision)
          throw new Error("Archived worker changed; refresh and confirm again");
      }
      if (action === "restore") {
        if (!task) throw new Error("Archived worker history is unavailable");
        await ensureArchiveExecutionStopped(dir, task);
        const previous = structuredClone(task),
          at = now();
        task.status = "blocked";
        task.failure =
          "Restored worker history only. Its environment is absent or unavailable. Environment reconstruction is not currently supported; no setup or worker was started.";
        task.archiveRestorations ||= [];
        task.archiveRestoration = {
          operationId,
          at,
          requiresRecovery: true,
          reason: "history-only",
          archiveRevision: expectedRevision,
          previousStatus: previous.status,
          previousFailure: previous.failure || null,
        };
        task.archiveRestorations.push({ ...task.archiveRestoration });
        for (const item of task.attention)
          if (!item.ackedAt) {
            item.ackedAt = at;
            item.resolution =
              "Historical attention retained from archived worker";
          }
        if (task.question) {
          task.archivedQuestions ||= [];
          task.archivedQuestions.push(task.question);
          task.question = null;
        }
        (task.history ||= []).push({
          id: `archive-restore:${operationId}`,
          actor: "controller",
          kind: "lifecycle",
          message: task.failure,
          at,
          runId: task.runId || null,
        });
        recordHistory(task, previous);
        task.revision++;
        task.updatedAt = at;
        await save(root, task);
        await atomic(
          journalFile,
          JSON.stringify({ ...identity, status: "completed", at }),
        );
        return { ok: true, taskId, action };
      }
      return withStateLock(root, ".worker-approvals.lock", async () => {
        if (task && journal?.status !== "deleting") {
          await ensureArchiveExecutionStopped(dir, task);
        }
        const records = ["json", "md", "notes.md"].map((extension) =>
          path.join(root, "tasks", `${taskId}.${extension}`),
        );
        for (const file of records) await safeFile(file);
        const runsRoot = path.join(root, "runs"),
          runDir = path.join(runsRoot, taskId);
        const inspectTree = async (target: string) => {
          let stat;
          try {
            stat = await fs.lstat(target);
          } catch (error) {
            if (errorCode(error) === "ENOENT") return false;
            throw error;
          }
          if (stat.isSymbolicLink() || (await fs.realpath(target)) !== target)
            throw new Error(
              "Worker run evidence has an unsafe path; nothing was deleted",
            );
          if (stat.isDirectory()) {
            for (const name of await fs.readdir(target))
              await inspectTree(path.join(target, name));
          } else if (!stat.isFile())
            throw new Error("Worker run evidence contains an unsupported file");
          return true;
        };
        const hasRuns = await fs.lstat(runsRoot).then(
          async () => {
            await safeDirectory(runsRoot);
            return inspectTree(runDir);
          },
          (error) => {
            if (errorCode(error) === "ENOENT") return false;
            throw error;
          },
        );
        const approvalDir = path.join(root, "worker-approvals");
        let approvalFiles: string[] = [];
        if (
          await fs.lstat(approvalDir).then(
            () => true,
            (error) => {
              if (errorCode(error) === "ENOENT") return false;
              throw error;
            },
          )
        ) {
          await safeDirectory(approvalDir);
          for (const name of await fs.readdir(approvalDir))
            if (name.endsWith(".json"))
              await safeFile(path.join(approvalDir, name));
          const { listWorkerRequests } =
            await import("../worker-approvals.mjs");
          approvalFiles = (
            await listWorkerRequests({ stateDir: root, taskId })
          ).map((record) =>
            path.join(approvalDir, `${record.approvalId}.json`),
          );
        }
        await atomic(
          journalFile,
          JSON.stringify({
            ...identity,
            status: "deleting",
            validatedTerminal: true,
            at: journal?.at || now(),
          }),
        );
        if (hasRuns) await fs.rm(runDir, { recursive: true });
        for (const file of approvalFiles)
          if (await safeFile(file)) await fs.unlink(file);
        for (const file of records.slice(1))
          if (await safeFile(file)) await fs.unlink(file);
        if (await safeFile(records[0])) await fs.unlink(records[0]);
        await atomic(
          journalFile,
          JSON.stringify({
            ...identity,
            status: "completed",
            at: journal?.at || now(),
          }),
        );
        return { ok: true, taskId, action };
      });
    });
  }

  return { manageArchivedTask, ensureArchiveExecutionStopped };
}
