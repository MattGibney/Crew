import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {lstat,readFile} from 'node:fs/promises';
import {isRecord,errorCode} from '../execution/errors.mjs';
import type {JsonValue} from '../execution/contracts.mjs';
import type {DiscoveryRunOptions} from './contracts.mjs';
import {abort} from './safety.mjs';
// Separate short-lived CLI run, not the manager thread or a controller task. No project commands.
export async function runDiscoveryWorker({
  executable,
  prompt,
  cwd,
  schemaPath,
  outputPath,
  signal,
  env = process.env,
  timeoutMs = 180000,
}: DiscoveryRunOptions): Promise<unknown> {
  abort(signal);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180000)
    throw new Error(
      "Discovery timeout must be between 1 and 180000 milliseconds.",
    );
  const childEnv = { ...env };
  for (const key of [
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_ORG_ID",
    "OPENAI_PROJECT_ID",
  ])
    delete childEnv[key];
  const args = [
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--skip-git-repo-check",
    "--json",
    "-C",
    cwd,
    "--sandbox",
    "read-only",
    "-c",
    'forced_login_method="chatgpt"',
    "-c",
    'model_provider="openai"',
    "-c",
    'approval_policy="never"',
    "-c",
    'web_search="disabled"',
    "-c",
    "project_doc_max_bytes=0",
  ];
  for (const feature of [
    "shell_tool",
    "apps",
    "plugins",
    "hooks",
    "memories",
    "multi_agent",
    "multi_agent_v2",
    "code_mode",
    "code_mode_host",
    "browser_use",
    "computer_use",
    "image_generation",
    "view_image",
  ])
    args.push("--disable", feature);
  args.push("--output-schema", schemaPath, "-o", outputPath, "-");
  const child = spawn(executable, args, {
    cwd,
    env: childEnv,
    stdio: ["pipe", "pipe", "ignore"],
  });
  let completed = false,
    failed = false,
    oversized = false,
    bytes = 0,
    stopped = false,
    escalation: NodeJS.Timeout | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    child.kill("SIGTERM");
    escalation = setTimeout(() => child.kill("SIGKILL"), 1500);
    escalation.unref();
  };
  const lines = createInterface({ input: child.stdout });
  child.stdout.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > 262144 && !stopped) {
      oversized = true;
      stop();
    }
  });
  lines.on("line", (line) => {
    try {
      const event: unknown = JSON.parse(line);
      if (!isRecord(event)) return;
      const item = isRecord(event.item) ? event.item : {};
      if (event.type === "turn.completed") completed = true;
      if (
        ["error", "turn.failed"].includes(String(event.type)) ||
        ["command_execution", "mcp_tool_call", "web_search"].includes(
          String(item.type),
        )
      )
        failed = true;
    } catch {}
  });
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  const timer = setTimeout(stop, timeoutMs);
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", () =>
        reject(new Error("Could not launch Codex discovery worker.")),
      );
      child.once("close", resolve);
    });
    abort(signal);
    if (stopped || oversized)
      throw new Error(
        "Discovery exceeded its bounded time or output limit. Retry with a smaller project.",
      );
    if (code !== 0 || failed || !completed)
      throw new Error(
        "Codex discovery did not complete. Confirm ChatGPT sign-in and available subscription allowance, then retry.",
      );
    const info = await lstat(outputPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 100000)
      throw new Error("Discovery response exceeded its output limit.");
    const output: unknown = JSON.parse(await readFile(outputPath, "utf8"));
    return output;
  } finally {
    clearTimeout(timer);
    clearTimeout(escalation);
    signal?.removeEventListener("abort", stop);
    lines.close();
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
}

