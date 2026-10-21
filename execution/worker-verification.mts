import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { Project, TaskRecord, TaskReport } from "./contracts.mjs";
import type { RunnerRecord } from "./evidence.mjs";
import { isRecord } from "./errors.mjs";
import { selectWorktreeRoot } from "../worktree-paths.mjs";
import { updateTask } from "../orchestration-store.mjs";
function parseRecord(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error("Invalid fixture evidence");
  return value;
}
const exec = promisify(execFile),
  now = () => new Date().toISOString();
const attention = (
  task: TaskRecord,
  id: string,
  kind: string,
  message: string,
) => {
  if (!task.attention.some((a) => a.id === id))
    task.attention.push({ id, kind, message, at: now() });
};
export async function verifyWorkerCompletion({
  stateDir,
  project,
  task,
  exit,
  report,
}: {
  stateDir: string;
  project: Project | null;
  task: TaskRecord;
  exit: RunnerRecord;
  report: TaskReport;
}) {
  if (exit.exitCode !== 0 || !exit.completedTurn || !exit.threadId)
    throw new Error(
      "Worker did not produce a successful completed Codex turn and session.",
    );
  if (
    report?.runId !== task.runId ||
    report.kind !== "result" ||
    typeof report.message !== "string" ||
    !report.message.trim()
  )
    throw new Error(
      "Worker did not provide a non-empty durable result for this run.",
    );
  if (!task.worktree)
    throw new Error("Worker has no retained worktree evidence.");
  const successfulCommands = (exit.commands || []).filter(
    (c) => c.exitCode === 0,
  );
  if (!successfulCommands.length)
    throw new Error("No successful worker command evidence was recorded.");
  const { stdout: root } = await exec("git", [
    "-C",
    task.worktree,
    "rev-parse",
    "--show-toplevel",
  ]);
  const { stdout: changes } = await exec("git", [
    "-C",
    task.worktree,
    "status",
    "--porcelain",
  ]);
  const { stdout: commit } = await exec("git", [
    "-C",
    task.worktree,
    "rev-parse",
    "HEAD",
  ]);
  const repositoryMode = project?.mode === "repository";
  const repoPath = repositoryMode ? task.repositoryPath : task.fixtureRepo;
  if (!repoPath) throw new Error("Worker repository evidence is unavailable.");
  const { stdout: list } = await exec("git", [
    "-C",
    repoPath,
    "worktree",
    "list",
    "--porcelain",
  ]);
  if (repositoryMode) {
    const actualWorktree = await realpath(task.worktree),
      actualRepo = await realpath(repoPath);
    const expectedWorktree = await realpath(
      path.join(
        await selectWorktreeRoot(stateDir, task),
        task.worktreeName || task.id,
      ),
    );
    if (
      (await realpath(root.trim())) !== actualWorktree ||
      actualWorktree !== expectedWorktree ||
      actualWorktree === actualRepo ||
      !list.includes(`worktree ${actualWorktree}\n`) ||
      commit.trim() !== task.baseCommit
    )
      throw new Error(
        "Repository worktree isolation or baseline verification failed",
      );
    if (task.workerSandbox === "read-only" && changes.trim())
      throw new Error("Read-only worker changed the worktree");
    const verification = {
      scope: "execution-evidence-only",
      semanticCorrectnessVerified: false,
      productionValidated: false,
      worktree: actualWorktree,
      commit: commit.trim(),
      clean: !changes.trim(),
      changedFiles: changes.trim() ? changes.trimEnd().split("\n") : [],
      successfulCommands: successfulCommands.length,
      at: now(),
    };
    await updateTask(stateDir, task.id, (next) => {
      next.status = "completed";
      next.endedAt = now();
      next.threadId = exit.threadId;
      next.result = {
        message: report.message,
        evidence: report.evidence,
        finalMessage: exit.finalMessage,
        verification,
      };
      next.question = null;
      attention(
        next,
        `${next.runId}:completion`,
        "completion",
        "Worker finished; isolated execution evidence checked. Code correctness and production behavior are not independently validated. Review the result and tests with the manager.",
      );
    });
    return;
  }
  const { stdout: checks } = await exec(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import {sum} from "./src/totals.mjs";console.log(JSON.stringify({empty:sum([]),oneTwoThree:sum([1,2,3])}));',
    ],
    { cwd: task.worktree },
  );
  const actualWorktree = await realpath(task.worktree),
    actualRepo = await realpath(repoPath);
  if (
    root.trim() !== actualWorktree ||
    actualWorktree === actualRepo ||
    !list.includes(`worktree ${actualWorktree}\n`) ||
    commit.trim() !== task.fixtureCommit ||
    changes.trim()
  )
    throw new Error(
      "Worktree isolation, baseline, or read-only verification failed.",
    );
  const verification: {
    worktree: string;
    commit: string;
    clean: boolean;
    successfulCommands: number;
    checks: Record<string, unknown>;
    at: string;
    expected?: { empty: number; oneTwoThree: number };
    findingMatched?: boolean;
  } = {
    worktree: root.trim(),
    commit: commit.trim(),
    clean: true,
    successfulCommands: successfulCommands.length,
    checks: parseRecord(checks),
    at: now(),
  };
  const observed = verification.checks;
  const structured = (report.evidence || [])
    .map((text) => {
      try {
        return parseRecord(text);
      } catch {
        return null;
      }
    })
    .find((value) => value && typeof value.emptyActual === "number");
  const answer = task.answer?.text.toLowerCase() || "";
  const baseFee =
    /\b1\b|\bone\b/.test(answer) && !/\b0\b|\bzero\b/.test(answer) ? 1 : 0;
  const checkedByWorker = successfulCommands.some(
    (c) =>
      c.command.includes("totals.mjs") &&
      (c.output || "").split("\n").some((line) => {
        try {
          const j = parseRecord(line);
          return (
            j.emptyActual === observed.empty &&
            j.sumActual === observed.oneTwoThree
          );
        } catch {
          return false;
        }
      }),
  );
  if (
    !checkedByWorker ||
    !structured ||
    structured.emptyActual !== observed.empty ||
    structured.sumActual !== observed.oneTwoThree ||
    structured.emptyExpected !== baseFee ||
    structured.sumExpected !== 6 + baseFee ||
    structured.finding !== "initial_value_one"
  )
    throw new Error(
      "Worker result does not match independent audit evidence and the agreed expectation.",
    );
  verification.expected = { empty: baseFee, oneTwoThree: 6 + baseFee };
  verification.findingMatched = true;
  await updateTask(stateDir, task.id, (next) => {
    next.status = "completed";
    next.endedAt = now();
    next.threadId = exit.threadId;
    next.result = {
      message: report.message,
      evidence: report.evidence,
      finalMessage: exit.finalMessage,
      verification,
    };
    next.question = null;
    attention(
      next,
      `${next.runId}:completion`,
      "completion",
      "Worker finished; isolated read-only execution and check results verified. Review with the manager when ready.",
    );
  });
}
