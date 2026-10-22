import test from "node:test";
import assert from "node:assert/strict";
import { decodeApi, decodeManagerEvent } from "../contracts/decode.ts";

test("renderer rejects malformed consumed HTTP payloads before setting UI state", () => {
  assert.throws(
    () =>
      decodeApi("voices", {
        voices: [{ id: 42, name: "Broken" }],
        defaultVoice: "broken",
      }),
    /Invalid voices response/,
  );
  assert.throws(
    () =>
      decodeApi("state", {
        approvals: [],
        items: [],
        status: "idle",
        messages: [{ role: "assistant", text: "Missing native identity" }],
      }),
    /Invalid state response/,
  );
  const valid = {
    voices: [{ id: "fixture", name: "Fixture" }],
    defaultVoice: "fixture",
    futureCapability: true,
  };
  assert.equal(decodeApi("voices", valid), valid);
});

test("live decoder remains passive for unknown protocol events and rejects malformed observed state", () => {
  assert.equal(
    decodeManagerEvent({ type: "transcript-delta", text: "Observed only" }),
    null,
  );
  assert.equal(decodeManagerEvent({ type: "backend-started" }), null);
  assert.throws(
    () =>
      decodeManagerEvent({
        type: "worker-approval-state",
        requests: [{ taskId: "task", runId: "run" }],
      }),
    /Invalid live event/,
  );
  assert.throws(
    () =>
      decodeManagerEvent({ type: "manager-lifecycle", state: { state: 7 } }),
    /Invalid live event/,
  );
  const notice = { type: "notice", message: "Retained work needs review" };
  assert.equal(decodeManagerEvent(notice), notice);
});

test("production nullable lifecycle/update/notes observations remain unavailable rather than malformed", () => {
  const lifecycle = {
    type: "manager-lifecycle",
    state: {
      state: "running",
      error: null,
      activeVersion: "version",
      retainedVersion: "version",
    },
  };
  assert.equal(decodeManagerEvent(lifecycle), lifecycle);
  const updates = {
    type: "update-state",
    status: {
      phase: "idle",
      error: null,
      workspacePlan: null,
      plan: null,
      availableVersion: null,
    },
  };
  assert.equal(decodeManagerEvent(updates), updates);
  const clearedPlan = { type: "update-plan-state", plan: null };
  assert.equal(decodeManagerEvent(clearedPlan), clearedPlan);
  const detail = {
    revision: 2,
    conversation: [],
    historyNotice: null,
    notes: {
      exists: false,
      markdown: null,
      updatedAt: null,
      path: "/private/task.notes.md",
    },
    links: [],
  };
  assert.equal(decodeApi("workers/task", detail), detail);
});

test("new profile, environment and scratchpad observations retain nullable and version boundaries", () => {
  const settings = {
    managerProfile: {
      voice: null,
      version: "profile-1",
      name: "Alex",
      picture: null,
      personality: "Direct",
    },
    managerLifecycle: { state: "running", error: null },
    manager: { saved: { text: "Manager", version: "m1" } },
    worker: { saved: { text: "Worker", version: "w1" } },
    workerEnvironment: {
      available: false,
      revision: null,
      configPath: null,
      environment: {},
    },
  };
  assert.equal(decodeApi("settings", settings), settings);
  const configured = structuredClone(settings);
  configured.workerEnvironment = {
    available: true,
    revision: "revision-1",
    configPath: "/private/config.json",
    environment: {
      start: {
        command: "/exact path/tool",
        args: ['one argument "quoted"\nnext line', ""],
        timeoutMs: 12345,
      },
    },
  };
  assert.equal(
    decodeApi("settings/worker-environment", configured),
    configured,
  );
  const state = {
    status: "idle",
    approvals: [],
    items: [],
    messages: [],
    managerScratchpad: {
      updatedAt: null,
      commitments: [],
      notes: [],
      decisions: [],
      questions: [],
    },
    managerScratchpadError: null,
  };
  assert.equal(decodeApi("state", state), state);
  const malformed = structuredClone(configured);
  malformed.workerEnvironment.environment.start.args =
    "not an ordered argument list";
  assert.throws(
    () => decodeApi("settings", malformed),
    /Invalid settings response/,
  );
  const invalidNotes = {
    ...state,
    managerScratchpad: { ...state.managerScratchpad, notes: [42] },
  };
  assert.throws(
    () => decodeApi("state", invalidNotes),
    /Invalid state response/,
  );
});

test("retained worker assignment/workflow state and exact native approval identities pass through", () => {
  const orchestration = {
    tasks: [
      {
        id: "task",
        status: "completed",
        runId: null,
        assignments: [
          {
            id: "next",
            ticket: "GH-50",
            brief: "Continue the same worker",
            status: "queued",
            runIds: [],
          },
        ],
        currentAssignmentId: "initial",
        workflowState: { value: "Ready for review" },
        workflowHistory: [
          { requestId: "state-1", value: "Ready for review", actor: "worker" },
        ],
        archiveRestoration: { requiresRecovery: true },
      },
    ],
  };
  assert.equal(decodeApi("orchestration", orchestration), orchestration);
  const event = {
    type: "worker-approval-state",
    requests: [
      {
        taskId: "task",
        runId: "run",
        approvalId: "approval",
        threadId: "thread",
        turnId: null,
        method: "item/commandExecution/requestApproval",
        requestId: 42,
      },
    ],
  };
  assert.equal(decodeManagerEvent(event), event);
});

test('reported progress validates identically in HTTP and SSE projections', () => {
  for (const progressPercent of [undefined, null, 0, 35.5, 100]) {
    const state = { tasks: [{ id: 'worker', status: 'running', workflowState: { value: 'Investigating', ...(progressPercent === undefined ? {} : { progressPercent }) } }] };
    assert.equal(decodeApi('orchestration', state), state);
    const event = { type: 'orchestration-state', state };
    assert.deepEqual(decodeManagerEvent(event), event);
  }
  for (const progressPercent of [-1, 101, Infinity, '35', true]) {
    const state = { tasks: [{ id: 'worker', status: 'running', workflowState: { value: 'Investigating', progressPercent } }] };
    assert.throws(() => decodeApi('orchestration', state), /Invalid orchestration response/);
    assert.throws(() => decodeManagerEvent({ type: 'orchestration-state', state }), /Invalid/);
  }
});

test('manager schedule responses validate interval/daily timing before rendering',()=>{
 const settings={managerProfile:{voice:null,version:'profile'},managerLifecycle:{state:'running'},manager:{saved:{text:'manager',version:'m1'}},worker:{saved:{text:'worker',version:'w1'}},managerSchedules:{revision:'r1',schedules:[{id:'interval',name:'Check',instruction:'Check my work',enabled:true,timing:{kind:'interval',minutes:30},run:{nextAt:1234}}]}};
 assert.equal(decodeApi('settings/manager-schedules',settings),settings);
 const broken=structuredClone(settings);delete broken.managerSchedules.schedules[0].timing.minutes;assert.throws(()=>decodeApi('settings',broken));
 broken.managerSchedules.schedules[0].timing={kind:'daily',time:'09:00',timeZone:'Europe/London'};assert.equal(decodeApi('settings',broken),broken);
});
