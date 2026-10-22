import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { decodeApi, decodeManagerEvent } from "../contracts/decode.ts";

// Render the real shared component without a browser or a second test-only presenter.
const code = buildSync({
  entryPoints: [
    fileURLToPath(new URL("./PreparationProgress.tsx", import.meta.url)),
  ],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  jsx: "automatic",
  tsconfig: "tsconfig.renderer.json",
}).outputFiles[0].text;
const {
  PreparationProgress,
  participantAcknowledgement,
  participantLabel,
  preparationPhase,
} = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
);
const at = "2026-10-22T10:00:00.000Z";
const participant = (change = {}) => ({
  id: "worker-one",
  role: "worker",
  taskId: "task-one",
  taskLabel: "GH-62",
  runId: "run-one",
  threadId: "thread-one",
  requestId: "prepare-one",
  required: true,
  message: "Save factual continuation notes, then report readiness.",
  delivery: { state: "attempted", at },
  response: null,
  projectId: "project-one",
  projectName: "Project One",
  ...change,
});
const plan = (participants, purpose = "update") => ({
  id: "plan-one",
  purpose,
  phase: "blocked",
  preparation: {
    id: "preparation-one",
    purpose,
    phase: "preparing",
    participants,
  },
  reasons: ["Project One: resolve the pending native approval."],
});
const render = (value) =>
  renderToStaticMarkup(createElement(PreparationProgress, { plan: value }));

test("native completion and execution settlement never fabricate a preparation acknowledgement", () => {
  const stopped = participant({
    settled: true,
    workflowState: { value: "Paused" },
    nativeStatus: "completed",
  });
  assert.equal(
    participantAcknowledgement(stopped),
    "Waiting for agent acknowledgement",
  );
  const html = render(plan([stopped]));
  assert.match(html, /Waiting for agent acknowledgement/);
  assert.match(html, /Execution settled\./);
  assert.doesNotMatch(html, /Agent ready/);
  assert.match(html, /Project One/);
  assert.match(html, /GH-62/);
  assert.match(html, /prepare-one/);
  assert.match(html, /run-one/);
});

test("explicit agent ready and late execution proof remain separate visible observations", () => {
  const response = {
    responseId: "ready-one",
    state: "ready",
    note: "Changes and continuation notes saved.",
    continuation: "Continue with the final check.",
    at,
  };
  const waiting = render(
    plan([participant({ response, settled: false })], "quit"),
  );
  assert.match(waiting, /Agent ready/);
  assert.match(waiting, /Waiting for final messages and execution to settle\./);
  assert.match(waiting, /Changes and continuation notes saved/);
  assert.match(waiting, /Continue with the final check/);
  const settled = render(
    plan([participant({ response, settled: true })], "quit"),
  );
  assert.match(settled, /Execution settled\./);
  assert.doesNotMatch(settled, /Waiting for final messages/);
});

test("needs-input, failed delivery and already stopped participants stay truthful and distinguishable", () => {
  const html = render(
    plan([
      participant({
        id: "manager",
        role: "manager",
        taskId: null,
        response: {
          responseId: "input-one",
          state: "needs-input",
          note: "Please answer the current native approval.",
          at,
        },
      }),
      participant({
        id: "worker-two",
        taskId: "task-two",
        taskLabel: undefined,
        delivery: { state: "failed", at, error: "Native delivery failed." },
      }),
      participant({ id: "stopped", taskId: "task-stopped", required: false }),
    ]),
  );
  assert.match(html, /Needs your input/);
  assert.match(
    html,
    /existing manager conversation to resolve native approvals/,
  );
  assert.match(
    html,
    /For new directions or other decisions, cancel this request, then choose Return to work/,
  );
  assert.match(
    html,
    /Prepared workers stay paused; Resume paused work is a separate explicit action/,
  );
  assert.doesNotMatch(html, /conversation to answer questions/);
  assert.match(html, /Preparation request failed/);
  assert.match(html, /Native delivery failed/);
  assert.match(html, /task-two/);
  assert.match(html, /Already stopped; no preparation needed/);
  assert.doesNotMatch(html, /Agent ready/);
});

test("purpose-specific phase copy and validated shared HTTP/SSE preparation state preserve exact response identity", () => {
  assert.equal(
    preparationPhase({ ...plan([], "quit"), phase: "blocked" }),
    "Quitting needs your review.",
  );
  assert.equal(
    preparationPhase({ ...plan([]), phase: "blocked" }),
    "The update needs your review.",
  );
  const snapshot = {
    phase: "downloaded",
    workspacePlan: plan([participant()], "quit"),
  };
  assert.equal(decodeApi("updates", snapshot), snapshot);
  const event = { type: "update-plan-state", plan: snapshot.workspacePlan };
  assert.equal(decodeManagerEvent(event), event);
  const malformed = structuredClone(snapshot);
  malformed.workspacePlan.preparation.participants[0].delivery.state = "ready";
  assert.throws(
    () => decodeApi("updates", malformed),
    /Invalid updates response/,
  );
  const malformedResponse = structuredClone(snapshot);
  malformedResponse.workspacePlan.preparation.participants[0].response = {
    state: "ready",
    note: "Missing response identity",
  };
  assert.throws(
    () => decodeApi("updates", malformedResponse),
    /Invalid updates response/,
  );
});

test("workers with the same ticket remain distinguishable before opening request details", () => {
  const first = participant({
      id: "first",
      taskId: "task-first",
      taskLabel: "GH-62",
    }),
    second = participant({
      id: "second",
      taskId: "task-second",
      taskLabel: "GH-62",
    });
  assert.equal(
    participantLabel(first, [first, second]),
    "Worker · GH-62 · task-first",
  );
  assert.equal(
    participantLabel(second, [first, second]),
    "Worker · GH-62 · task-second",
  );
});
