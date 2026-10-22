#!/usr/bin/env node
import { parse } from "./options.mjs";
import type { CliOptions } from "./options.mjs";
import { packageSource } from "./source-package.mjs";
import type { LoadedConfig } from "../config/contracts.mjs";
import { parseConfig } from "../config/shape.mjs";
import { parseRecord } from "../shared/errors.mjs";
import { errorCode, errorMessage } from "../shared/errors.mjs";
// AI-006: dependency-free macOS local lifecycle and portable source packaging.
import {
  readFile,
  writeFile,
  mkdir,
  copyFile,
  access,
  open,
  stat,
  unlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { prepareCrewStorage } from "../desktop/storage.mjs";
import { appRoot, loadAppConfig } from "../config/index.mjs";
const run = promisify(execFile);
const sleep = (milliseconds: number) =>
  new Promise((done) => setTimeout(done, milliseconds));
const safe = (value: unknown) =>
  String(value)
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/sk-[\w-]+/g, "[redacted]")
    .slice(0, 1200);
const exists = async (path: string) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};
const defaultInstanceConfig = join(
  homedir(),
  "Library",
  "Application Support",
  "Crew",
  "instances",
  "default",
  "project.json",
);
const usage = `Crew — one project per instance

  node runtime/cli.mjs init [--template fixture|set1] [--config path]
  node runtime/cli.mjs doctor [--config path]
  node runtime/cli.mjs validate [--config path]
  node runtime/cli.mjs start [--config path] [--background]
  node runtime/cli.mjs status [--config path]
  node runtime/cli.mjs stop [--config path]
  node runtime/cli.mjs package [--output path.tar.gz]

init never overwrites configuration or prompts. start stays in the foreground
unless --background is supplied. stop ends only this instance's local server;
already launched workers retain their independent lifecycle. No login daemon
or cloud deployment is installed. Each other project needs a separate instance,
configuration, data directory and port. Use existing ChatGPT sign-in only.`;
async function initialize(options: CliOptions) {
  const template = options["--template"] || "fixture";
  if (!["fixture", "set1"].includes(template))
    throw new Error("--template must be fixture or set1.");
  const target = resolve(
    options["--config"] ||
      process.env.AI_MANAGER_CONFIG ||
      defaultInstanceConfig,
  );
  const folder = dirname(target),
    promptDir = join(folder, "prompts");
  const targets = [
    target,
    join(promptDir, "manager.md"),
    join(promptDir, "worker.md"),
  ];
  for (const path of targets)
    if (await exists(path))
      throw new Error(
        `Refusing to overwrite ${path}. Edit the existing instance files, or select a new config directory.`,
      );
  const config = parseConfig(
    await readFile(join(appRoot, "config", `${template}.example.json`), "utf8"),
  );
  config.runtime.dataDir =
    folder === resolve(appRoot, "config") ? "../.data" : ".data";
  config.project.prompts = {
    manager: "prompts/manager.md",
    worker: "prompts/worker.md",
  };
  await mkdir(promptDir, { recursive: true, mode: 0o700 });
  const created = [];
  try {
    for (const role of ["manager", "worker"]) {
      const promptTarget = join(promptDir, `${role}.md`);
      await copyFile(
        join(appRoot, "prompts", `${role}.md`),
        promptTarget,
        constants.COPYFILE_EXCL,
      );
      created.push(promptTarget);
    }
    await writeFile(target, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    created.push(target);
  } catch (error) {
    for (const path of created) await unlink(path).catch(() => {});
    throw error;
  }
  console.log(
    `Created ${target}\nEditable manager/worker prompts: ${promptDir}\n${template === "set1" ? "Set1 is a template: confirm repository paths, base refs and Linear identifiers before dispatch. No work was launched." : "Disposable read-only fixture selected. No worker was launched."}\nNext: node runtime/cli.mjs doctor --config ${JSON.stringify(target)}`,
  );
}
async function readMarker(config: LoadedConfig) {
  if (!(await exists(config.serverStatePath))) return null;
  let marker;
  try {
    marker = parseRecord(await readFile(config.serverStatePath, "utf8"));
  } catch {
    throw new Error(
      `Cannot read this instance's server marker at ${config.serverStatePath}. No process was stopped.`,
    );
  }
  if (
    typeof marker.pid !== "number" ||
    typeof marker.port !== "number" ||
    !Number.isInteger(marker.pid) ||
    !Number.isInteger(marker.port) ||
    typeof marker.token !== "string" ||
    !/^[\w-]{16,100}$/.test(marker.token) ||
    marker.projectId !== config.project.id ||
    marker.configPath !== config.configPath
  )
    throw new Error(
      "Server marker does not match this instance configuration. No process was stopped; inspect its data directory and original configuration.",
    );
  return { pid: marker.pid, port: marker.port, token: marker.token };
}
function sanitizedEnv(configPath: string | null) {
  const env = { ...process.env };
  for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"])
    delete env[key];
  if (configPath) env.AI_MANAGER_CONFIG = configPath;
  else delete env.AI_MANAGER_CONFIG;
  return env;
}
async function doctor(config: LoadedConfig) {
  console.log(
    `Node: ${config.runtime.nodeVersion}\nGit: ${config.runtime.gitVersion}\nCodex: ${config.runtime.codexVersion}\nExecutable: ${config.executable}\nConfiguration: ${config.configPath || "built-in disposable fixture (no local configuration)"}\nProject: ${config.project.name} (${config.project.id})\nState: ${config.projectStateDir}${config.legacyState ? " (existing fixture state preserved)" : ""}\nURL: http://127.0.0.1:${config.port}`,
  );
  let subscription = false;
  try {
    const status = await run(
      config.executable || "codex",
      ["login", "status"],
      {
        env: sanitizedEnv(config.configPath),
        timeout: 10000,
        maxBuffer: 65536,
      },
    );
    subscription = /logged in using chatgpt/i.test(
      `${status.stdout}\n${status.stderr}`,
    );
  } catch {}
  console.log(
    `ChatGPT sign-in: ${subscription ? "available (CLI login status; server preparation still required)" : "not confirmed; run Codex login and choose ChatGPT, not an API key"}`,
  );
  console.log(
    `Dispatch configuration: ${config.project.readiness.ready ? "ready" : "incomplete"}`,
  );
  for (const issue of config.project.readiness.issues)
    console.log(`  - ${issue}`);
  console.log(
    "Realtime voice and MCP availability depend on your installed Codex version/account/configuration. Confirm them in the browser before real work. This check starts no voice or worker.",
  );
  if (!subscription) process.exitCode = 1;
}
async function start(config: LoadedConfig, background = false) {
  const marker = await readMarker(config);
  if (marker)
    throw new Error(
      `An existing server marker is present for PID ${marker.pid}. Use stop with the same configuration or inspect the marker; no duplicate server was launched.`,
    );
  const env = sanitizedEnv(config.configPath);
  if (!background) {
    const child = spawn(process.execPath, [join(appRoot, "server.mjs")], {
      cwd: appRoot,
      env,
      stdio: "inherit",
    });
    let forwarded = false;
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.on(signal, () => {
        if (!forwarded) {
          forwarded = true;
          child.kill(signal);
        }
      });
    child.on("error", (error) => {
      console.error(safe(errorMessage(error)));
      process.exitCode = 1;
    });
    child.on("exit", (code, signal) => {
      process.exitCode = code ?? (signal ? 1 : 0);
    });
    return;
  }
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const logPath = join(config.dataDir, "server.log");
  const log = await open(logPath, "a", 0o600);
  let child;
  try {
    child = spawn(process.execPath, [join(appRoot, "server.mjs")], {
      cwd: appRoot,
      env,
      stdio: ["ignore", log.fd, log.fd],
      detached: true,
    });
  } finally {
    await log.close();
  }
  let spawnError: Error | undefined;
  child.on("error", (error) => {
    spawnError = error;
  });
  child.unref();
  for (let attempt = 0; attempt < 150; attempt++) {
    if (spawnError || child.exitCode !== null)
      throw new Error(
        `Server did not start. Inspect ${logPath}${spawnError ? ` (${safe(errorMessage(spawnError))})` : ""}.`,
      );
    const next = await readMarker(config);
    if (next && next.pid === child.pid) {
      console.log(
        `Started local server PID ${child.pid}: http://127.0.0.1:${next.port}\nLog: ${logPath}\nMicrophone remains off until you connect. Stop with the same --config.`,
      );
      return;
    }
    await sleep(100);
  }
  throw new Error(
    `Server startup was not confirmed within 15 seconds. It may still be starting; inspect ${logPath} before trying again. No process was killed.`,
  );
}
async function stop(config: LoadedConfig) {
  const marker = await readMarker(config);
  if (!marker) {
    console.log("No server marker for this instance. No process was stopped.");
    return;
  }
  const origin = `http://127.0.0.1:${marker.port}`;
  let response;
  try {
    response = await fetch(`${origin}/api/shutdown`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ token: marker.token }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new Error(
      "This instance did not answer its authenticated shutdown request. No PID was killed. Check whether it is still running before removing a stale server marker.",
    );
  }
  if (response.status !== 202)
    throw new Error(
      `This instance rejected shutdown (${response.status}). No PID was killed.`,
    );
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!(await exists(config.serverStatePath))) {
      console.log(
        "Local server stopped. Independently launched workers were not canceled.",
      );
      return;
    }
    const current = await readMarker(config);
    if (!current || current.token !== marker.token)
      throw new Error(
        "Server marker changed during shutdown; another server may have started. No further action taken.",
      );
    await sleep(100);
  }
  throw new Error(
    "Shutdown was accepted but marker removal is not yet confirmed. Inspect server.log before restarting.",
  );
}
async function status(config: LoadedConfig) {
  const marker = await readMarker(config);
  if (!marker) {
    console.log("This instance has no running-server marker.");
    return;
  }
  const origin = `http://127.0.0.1:${marker.port}`;
  try {
    const response = await fetch(`${origin}/api/state`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("Status request failed.");
    const state = await response.json();
    console.log(
      `Local server responds: ${origin}\nProject: ${config.project.name}\nManager: ${state.status || "idle"}\nVoice: ${state.voiceActive ? "connected" : "disconnected"}\nThis command did not prepare a chat, activate a microphone or launch work.`,
    );
  } catch {
    throw new Error(
      "A server marker exists but its local server did not answer. No process was stopped. Inspect server.log before restarting.",
    );
  }
}

try {
  const options = parse(process.argv.slice(2));
  if (
    ["init", "start"].includes(options.command) &&
    !options["--config"] &&
    !process.env.AI_MANAGER_CONFIG
  ) {
    const storage = await prepareCrewStorage({
      appData: join(homedir(), "Library", "Application Support"),
    });
    if (storage.issue)
      throw new Error(
        storage.issue +
          " Open Crew setup for recovery, or pass the original --config explicitly.",
      );
    options["--config"] = storage.configPath;
  }
  if (options.command === "help") console.log(usage);
  else if (options.command === "init") await initialize(options);
  else if (options.command === "package") {
    const metadata = parseRecord(
      await readFile(join(appRoot, "package.json"), "utf8"),
    );
    if (typeof metadata.version !== "string")
      throw new Error("Invalid package version.");
    await packageSource(options, metadata.version);
  } else {
    const requestedConfig =
      options["--config"] ||
      process.env.AI_MANAGER_CONFIG ||
      defaultInstanceConfig;
    const config = await loadAppConfig({
      configPath: requestedConfig ? resolve(requestedConfig) : undefined,
    });
    if (options.command === "doctor") await doctor(config);
    else if (options.command === "validate") {
      console.log(
        `Configuration valid: ${config.configPath || config.sourceConfigPath}\nProject: ${config.project.name}\nDispatch configuration: ${config.project.readiness.ready ? "ready" : "incomplete"}`,
      );
      for (const issue of config.project.readiness.issues)
        console.log(`  - ${issue}`);
      if (!config.project.readiness.ready) process.exitCode = 1;
    } else if (options.command === "start")
      await start(config, options["--background"]);
    else if (options.command === "status") await status(config);
    else await stop(config);
  }
} catch (error) {
  console.error(safe(errorMessage(error)));
  process.exitCode = 1;
}
