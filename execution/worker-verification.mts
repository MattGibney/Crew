import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { Project, TaskRecord, ResultCandidate } from "./contracts.mjs";
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
  report: ResultCandidate;
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
  const successfulCommands = (exit.commands || []).filter(
    (c) => c.exitCode === 0,
  );
  if (project?.mode === "repository") {
    const verification = {
      scope: "native-execution-evidence",
      semanticCorrectnessVerified: false,
      productionValidated: false,
      successfulCommands: successfulCommands.length,
      at: now(),
    };
    try {
      if (task.worktree) {
        const [{ stdout: head }, { stdout: changes }] = await Promise.all([
          exec("git", ["-C", task.worktree, "rev-parse", "HEAD"]),
          exec("git", ["-C", task.worktree, "status", "--porcelain"]),
        ]);
        Object.assign(verification, {
          worktree: task.worktree,
          commit: head.trim(),
          clean: !changes.trim(),
          changedFiles: changes.trim() ? changes.trimEnd().split("\n") : [],
        });
      }
    } catch {}
    await updateTask(stateDir, task.id, (n) => {
      if (n.runId !== task.runId) return;
      n.status = "completed";
      n.endedAt = now();
      n.threadId = exit.threadId;
      n.result = {
        message: report.message,
        evidence: report.evidence || [],
        finalMessage: exit.finalMessage,
        verification,
      };
      n.question = null;
      attention(
        n,
        `${n.runId}:completion`,
        "completion",
        "Native Codex work completed. Result and execution history are available.",
      );
    });
    return;
  }
  if (!task.worktree)
    throw new Error("Worker has no retained worktree evidence.");
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
  const repositoryMode = false;
  const repoPath = repositoryMode ? task.repositoryPath : task.fixtureRepo;
  if (!repoPath) throw new Error("Worker repository evidence is unavailable.");
  const { stdout: list } = await exec("git", [
    "-C",
    repoPath,
    "worktree",
    "list",
    "--porcelain",
  ]);
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
