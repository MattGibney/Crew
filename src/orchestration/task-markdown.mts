import type { TaskRecord } from "../workers/contracts.mjs";
export function taskMarkdown(task: TaskRecord): string {
  const lines = [
    `# ${task.id}`,
    "",
    `Ticket: ${task.ticket}`,
    `Status: ${task.status}`,
    `Revision: ${task.revision}`,
    "",
    "Project: " + (task.projectId || "legacy fixture"),
    "Repository: " + (task.repositoryId || "fixture"),
    "",
    "## Agreed brief",
    "",
    task.brief,
    "",
    "## Reports",
    "",
  ];
  if (task.assignments) {
    lines.push("## Assignments", "");
    for (const assignment of task.assignments)
      lines.push(
        `### ${assignment.ticket} — ${assignment.status} (${assignment.id})`,
        "",
        assignment.brief,
        "",
        ...(assignment.userDecision
          ? ["User authorization: " + assignment.userDecision, ""]
          : []),
        ...(assignment.result
          ? ["Result: " + assignment.result.message, ""]
          : []),
      );
  }
  for (const report of task.reports)
    lines.push(
      `### ${report.kind} (${report.at})`,
      "",
      report.message,
      "",
      ...(report.evidence || []).map((item) => `- ${item}`),
      "",
    );
  if (task.question)
    lines.push(
      "## Current question",
      "",
      task.question.message ||
        "Question text unavailable in this retained record.",
      "",
    );
  if (task.answer) lines.push("## Answer", "", task.answer.text, "");
  lines.push(
    "## Attention",
    "",
    ...task.attention.map(
      (a) =>
        `- ${a.ackedAt ? "Acknowledged" : "Pending"}: ${a.message || a.kind || a.id}`,
    ),
    "",
  );
  return lines.join("\n");
}
