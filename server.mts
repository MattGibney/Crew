import { projectApi } from "./backend/project-api.mjs";
import { createSettingsView } from "./backend/settings-view.mjs";
import { record as isRecord, parseRecord } from "./shared/errors.mjs";
import type { PausePlan } from "./shared/update.mjs";
import { errorCode, errorMessage } from "./shared/errors.mjs";
// AI-002: narrow localhost HTTP surface for the native Codex bridge.
import http from "node:http";
import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { loadAppConfig, configurationRoot } from "./config.mjs";
import { fileURLToPath } from "node:url";
import { createPromptSettings } from "./prompt-settings.mjs";
import { createManagerProfile } from "./manager-profile.mjs";
import { createManagerLifecycle } from "./manager-lifecycle.mjs";
import { createBridge, safeError } from "./codex-bridge.mjs";
import { createController } from "./controller.mjs";
import { readWorkerDetail } from "./worker-detail.mjs";
import { readTask, requestWorkerAction } from "./orchestration-store.mjs";
import {
  listWorkerRequests,
  decideWorkerRequest,
} from "./worker-approvals.mjs";
import { createHash, randomUUID } from "node:crypto";
import { createRendererAssets } from "./renderer-assets.mjs";
import { createUpdateBridge } from "./update-bridge.mjs";
import { updateActivity } from "./update-activity.mjs";
import { inspectUpdateEvidence } from "./update-evidence.mjs";
import { createUpdateAdmission } from "./update-admission.mjs";
import { globalAdmissionPaused } from "./global-capacity.mjs";
import {
  createUpdatePlan,
  readUpdatePlan,
  isUpdatePlanHolding,
} from "./update-plan.mjs";
const root = fileURLToPath(new URL(".", import.meta.url));
let renderer;
try {
  renderer = await createRendererAssets(path.join(root, "renderer-dist"));
} catch (error) {
  console.error(`Crew could not start: ${safeError(error)}`);
  process.exit(1);
}
let configuration;
try {
  configuration = await loadAppConfig({ root: configurationRoot });
} catch (error) {
  console.error(`Crew could not start: ${safeError(error)}`);
  process.exit(1);
}
const {
  port,
  executable,
  projectStateDir: orchestrationDir,
  managerStatePath,
  project,
  managerPrompt,
  workerPrompt,
  dataDir,
  serverStatePath,
} = configuration;
const origin = `http://127.0.0.1:${port}`;
await mkdir(dataDir, { recursive: true, mode: 0o700 });
try {
  const prior = parseRecord(await readFile(serverStatePath, "utf8"));
  if (
    typeof prior.pid !== "number" ||
    !Number.isInteger(prior.pid) ||
    prior.pid < 1
  )
    throw new Error(
      "Malformed instance runtime marker; inspect it before restarting.",
    );
  let running = true;
  try {
    process.kill(prior.pid, 0);
  } catch (error) {
    if (errorCode(error) === "ESRCH") running = false;
    else throw error;
  }
  if (running)
    throw new Error(
      "This instance may already be running. Use its status/stop command or a separate dataDir.",
    );
  await unlink(serverStatePath);
} catch (error) {
  if (errorCode(error) !== "ENOENT") {
    console.error(`Crew could not start: ${safeError(error)}`);
    process.exit(1);
  }
}

const clients = new Set<http.ServerResponse>();
await mkdir(orchestrationDir, { recursive: true, mode: 0o700 });
const bindingPath = path.join(orchestrationDir, "instance-project.json");
try {
  const bound = parseRecord(await readFile(bindingPath, "utf8"));
  if (bound.projectId !== project.id)
    throw new Error(
      "This state directory belongs to a different project. Give each instance its own dataDir.",
    );
} catch (error) {
  if (errorCode(error) !== "ENOENT") throw error;
  await writeFile(
    bindingPath,
    JSON.stringify({ projectId: project.id }) + "\n",
    { mode: 0o600, flag: "wx" },
  );
}
const runtimeProjectPath = path.join(orchestrationDir, "project-runtime.json");
const shutdownToken = randomUUID();
const broadcast = (event: { type: string; [key: string]: unknown }) => {
  if (
    typeof process.send === "function" &&
    process.env.ELECTRON_RUN_AS_NODE === "1" &&
    ["work-state", "orchestration-state", "worker-approval-state"].includes(
      event.type,
    )
  ) {
    try {
      process.send({ type: "crew:attention:state", event }, () => {});
    } catch {
      /* The native owner may already be quitting. */
    }
  }
  for (const client of clients) {
    try {
      client.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      clients.delete(client);
    }
  }
};
let workerApprovalSnapshot = "";
const publishWorkerApprovals = async () => {
  const requests = await listWorkerRequests({
    stateDir: orchestrationDir,
    pendingOnly: true,
  });
  const serialized = JSON.stringify(requests);
  if (serialized !== workerApprovalSnapshot) {
    workerApprovalSnapshot = serialized;
    broadcast({ type: "worker-approval-state", requests });
  }
  return requests;
};
const workerApprovalTimer = setInterval(
  () =>
    void publishWorkerApprovals().catch((error) =>
      broadcast({ type: "notice", message: safeError(error) }),
    ),
  1000,
);
let drainHeld = false;
let updatePlan: ReturnType<typeof createUpdatePlan>;
let updatePlanTimer: NodeJS.Timeout;
const prompts = await createPromptSettings({
  stateDir: orchestrationDir,
  sourceDir: root,
  projectId: project.id,
  managerPrompt,
  workerPrompt,
});
const managerProfile = createManagerProfile({
  stateDir: orchestrationDir,
  projectId: project.id,
});
const controller = await createController({
  admissionHeld: async () =>
    (await globalAdmissionPaused(process.env.CREW_GLOBAL_CAPACITY_DIR)) ||
    drainHeld ||
    isUpdatePlanHolding(await readUpdatePlan(orchestrationDir)),
  stateDir: orchestrationDir,
  sourceDir: root,
  executable: executable || "codex",
  project,
  workerPrompt,
  getWorkerPrompt: () => prompts.snapshot("worker"),
  globalCapacity: process.env.CREW_GLOBAL_CAPACITY_DIR
    ? { dir: process.env.CREW_GLOBAL_CAPACITY_DIR }
    : null,
  onChange: (state) => broadcast({ type: "orchestration-state", state }),
});
await writeFile(
  `${runtimeProjectPath}.tmp`,
  JSON.stringify({ project, workerPrompt }) + "\n",
  { mode: 0o600 },
);
await rename(`${runtimeProjectPath}.tmp`, runtimeProjectPath);
const bridge = createBridge({
  cwd: root,
  statePath: managerStatePath,
  executable: executable || "codex",
  orchestrationDir,
  project,
  managerPrompt,
  runtimeProjectPath,
  onEvent: broadcast,
});
const manager = await createManagerLifecycle({
  stateDir: orchestrationDir,
  projectId: project.id,
  bridge,
  prompts,
  onChange: (state) => broadcast({ type: "manager-lifecycle", state }),
});
const settingsView = createSettingsView({
  prompts,
  manager,
  managerProfile,
  project,
});
const metadata = parseRecord(
  await readFile(new URL("./package.json", import.meta.url), "utf8"),
);
if (typeof metadata.version !== "string")
  throw new Error("Invalid application version.");
const version = metadata.version;
const updates = createUpdateBridge({
  version,
  onStatus: (status) =>
    broadcast({
      type: "update-state",
      status: { ...status, plan: updatePlan?.status() || null },
    }),
});
const updateAdmission = createUpdateAdmission();
const activity = async () => {
  const view = await inspectUpdateEvidence({
    stateDir: orchestrationDir,
    view: await controller.view(),
  });
  const result = updateActivity({ view, work: bridge.state() });
  const lifecycle = manager.view();
  if (!["running", "stopped"].includes(lifecycle.state)) {
    result.safe = false;
    result.reasons.push(
      `Manager lifecycle is ${lifecycle.state}. Resolve it in Settings before installing an update.`,
    );
  }
  return result;
};
const synchronizePlan = (plan: PausePlan | null) => {
  drainHeld = isUpdatePlanHolding(plan);
  if (drainHeld) updateAdmission.hold();
  else updateAdmission.releaseHold();
  broadcast({ type: "update-plan-state", plan });
};
updatePlan = createUpdatePlan({
  stateDir: orchestrationDir,
  version,
  getView: async () =>
    inspectUpdateEvidence({
      stateDir: orchestrationDir,
      view: await controller.view(),
    }),
  getManager: () => {
    const state = bridge.state(),
      lifecycle = manager.view();
    return ["running", "stopped"].includes(lifecycle.state)
      ? state
      : {
          ...state,
          status: `manager-lifecycle-${lifecycle.state}`,
          workStarting: true,
        };
  },
  stopVoice: () => bridge.stopVoice({ cooperative: true }),
  interruptManager: (input) => bridge.interrupt(input),
  requestAction: (input) => requestWorkerAction(orchestrationDir, input),
  activity,
  onChange: synchronizePlan,
});
await updatePlan.ready;
synchronizePlan(updatePlan.status());
await updatePlan.recover();
updatePlanTimer = setInterval(
  () =>
    void updatePlan
      .tick()
      .catch((error) =>
        broadcast({ type: "notice", message: safeError(error) }),
      ),
  500,
);
const server = http.createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' https:; media-src 'self' blob:; frame-ancestors 'none'",
  );
  res.setHeader("Permissions-Policy", "microphone=(self), camera=()");
  const send = (code: number, value: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  };
  if (req.headers.host !== `127.0.0.1:${port}`)
    return send(403, { error: "Use the loopback URL printed by the bridge." });
  if (req.headers.origin && req.headers.origin !== origin)
    return send(403, { error: "Cross-origin requests are not allowed." });
  try {
    if (req.method === "GET" && req.url === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }
    if (req.method === "GET") {
      const asset = await renderer.read(req.url || "");
      if (asset) {
        res.writeHead(200, { "Content-Type": asset.type });
        return res.end(asset.body);
      }
      if (req.url === "/crew-mark.png") {
        const body = await readFile(
          new URL("build/crew-mark.png", import.meta.url),
        );
        res.writeHead(200, { "Content-Type": "image/png" });
        return res.end(body);
      }
    }
    if (
      req.method === "GET" &&
      /^\/api\/workers\/[a-zA-Z0-9_-]{8,80}$/.test(req.url || "")
    )
      return send(
        200,
        await readWorkerDetail(
          orchestrationDir,
          req.url!.split("/").at(-1)!,
          project,
        ),
      );
    if (req.method === "GET" && req.url === "/api/settings")
      return send(200, await settingsView());
    if (req.method === "GET" && req.url === "/events") {
      if (clients.size)
        return send(409, {
          error: "Only one browser tab can control this chat.",
        });
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
      });
      res.write(
        `data: ${JSON.stringify({ type: "work-state", state: bridge.state() })}\n\n`,
      );
      clients.add(res);
      res.write(
        `data: ${JSON.stringify({ type: "manager-lifecycle", state: manager.view() })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ type: "orchestration-state", state: await controller.view() })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ type: "worker-approval-state", requests: await publishWorkerApprovals() })}\n\n`,
      );
      res.on("error", () => {
        clients.delete(res);
        void bridge
          .stopVoice({ preserveWork: true })
          .catch((error) =>
            broadcast({ type: "error", message: safeError(error) }),
          );
      });
      const timer = setInterval(() => res.write(": heartbeat\n\n"), 15000);
      req.on("close", () => {
        clearInterval(timer);
        clients.delete(res);
        void bridge
          .stopVoice({ preserveWork: true })
          .catch((error) =>
            broadcast({ type: "error", message: safeError(error) }),
          );
      });
      return;
    }
    if (
      !["POST", "PUT"].includes(req.method || "") ||
      !req.url?.startsWith("/api/")
    )
      return send(404, { error: "Not found." });
    if (
      req.headers.origin !== origin ||
      !req.headers["content-type"]?.startsWith("application/json")
    )
      return send(403, { error: "Same-origin JSON requests only." });
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (
        Buffer.byteLength(body) >
        (req.url === "/api/settings/prompts" ? 400000 : 70000)
      )
        return send(413, { error: "Request too large." });
    }
    const rawInput: unknown = JSON.parse(body || "{}");
    if (
      [
        "/api/work",
        "/api/connect",
        "/api/prepare",
        "/api/voices",
        "/api/voice-ready",
        "/api/discuss-attention",
        "/api/manager/lifecycle",
        "/api/settings/prompts",
        "/api/settings/manager-profile",
      ].includes(req.url) &&
      (await globalAdmissionPaused(process.env.CREW_GLOBAL_CAPACITY_DIR))
    )
      return send(409, {
        error:
          "Crew is preparing an update across projects. Work admission is paused until you resume or return to work.",
      });
    if (req.method === "PUT") {
      if (req.url === "/api/settings/manager-profile") {
        await managerProfile.save(rawInput);
        return send(200, await settingsView());
      }
      if (req.url !== "/api/settings/prompts")
        return send(404, { error: "Not found." });
      await prompts.save(rawInput);
      return send(200, await settingsView());
    }
    const reply = await projectApi(req.url, rawInput, {
      configuration,
      bridge,
      manager,
      controller,
      updatePlan,
      updateAdmission,
      updates,
      shutdownToken,
      drainHeld,
      hold: () => {
        drainHeld = true;
      },
      synchronizePlan,
      activity,
      publishWorkerApprovals,
      hasClient: () => clients.size > 0,
      shutdownRequest: () => {
        setImmediate(() => void shutdown().then(() => process.exit(0)));
      },
    });
    return send(reply.status, reply.body);
  } catch (error) {
    const account = isRecord(error) ? error.account : undefined;
    return send(account ? 409 : 400, {
      error: safeError(error),
      ...(account ? { stage: "chat", account } : {}),
    });
  }
});
let shuttingDown: Promise<void> | undefined;
async function shutdown() {
  clearInterval(updatePlanTimer);
  clearInterval(workerApprovalTimer);
  if (shuttingDown) return shuttingDown;
  shuttingDown = (async () => {
    for (const client of clients) client.end();
    clients.clear();
    updates.close();
    await bridge.stopVoice({ preserveWork: false });
    await bridge.shutdown();
    await controller.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      const marker = parseRecord(await readFile(serverStatePath, "utf8"));
      if (marker.token === shutdownToken) await unlink(serverStatePath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT")
        console.error("Could not remove this instance’s runtime marker.");
    }
  })();
  return shuttingDown;
}
try {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeFile(
    serverStatePath,
    JSON.stringify({
      pid: process.pid,
      port,
      token: shutdownToken,
      configPath: configuration.configPath,
      projectId: project.id,
      startedAt: new Date().toISOString(),
    }) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    `Crew · ${project.name}: ${origin} (microphone off until Connect)`,
  );
} catch (error) {
  console.error(
    `Crew could not start: ${errorCode(error) === "EADDRINUSE" ? `Port ${port} is in use. Give this instance a different runtime.port.` : safeError(error)}`,
  );
  await shutdown();
  process.exit(1);
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => void shutdown().then(() => process.exit(0)));
