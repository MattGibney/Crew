import test from "node:test";
import assert from "node:assert/strict";
import { agentObjectives } from "../renderer/src/agents/agent-objectives.ts";
const job = (
  id,
  status,
  agent = "avery",
  type = "local",
  date = "2026-10-24T10:00:00Z",
) => ({
  id,
  assignment: { assignedToAgentId: agent },
  work: { type },
  progress: { status },
  updatedAt: date,
});
test("personal objectives exclude external tickets, delegated work, and cancelled items", () => {
  const result = agentObjectives(
    [
      job("own", "not_started"),
      job("ticket", "not_started", "avery", "ticket"),
      job("delegated", "in_progress", "worker"),
      job("cancelled", "cancelled"),
      job("active", "in_progress"),
      job("blocked", "blocked"),
      job("review", "ready"),
    ],
    "avery",
  );
  assert.deepEqual(
    result.notStarted.map((item) => item.id),
    ["own"],
  );
  assert.deepEqual(
    result.inProgress.map((item) => item.id),
    ["active", "blocked", "review"],
  );
  assert.deepEqual(result.completed, []);
});
test("recent completions prefer recorded outcomes and keep only the latest five", () => {
  const jobs = Array.from({ length: 7 }, (_, i) =>
    job(
      String(i),
      "completed",
      "avery",
      "local",
      `2026-10-${10 + i}T10:00:00Z`,
    ),
  );
  jobs[0].work.outcome = { recordedAt: "2026-10-24T11:00:00Z" };
  const result = agentObjectives(jobs, "avery");
  assert.deepEqual(
    result.completed.map((item) => item.id),
    ["0", "6", "5", "4", "3"],
  );
  assert.deepEqual(agentObjectives(jobs, "other").completed, []);
});
