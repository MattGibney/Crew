import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { decodeEnvelope } from "./protocol.mjs";
import type { Rpc, WireEnvelope } from "./protocol.mjs";
import type { BridgeChild, PrepareResult } from "./contracts.mjs";
export function launchManagerPeer({
  executable,
  cwd,
  sessionCwd,
  orchestrationDir,
  runtimeProjectPath,
  onFailure,
  onEnvelope,
  onNotice,
}: {
  executable: string;
  cwd: string;
  sessionCwd: string;
  orchestrationDir?: string;
  runtimeProjectPath?: string;
  onFailure: (proc: BridgeChild, error: unknown) => void;
  onEnvelope: (proc: BridgeChild, envelope: WireEnvelope) => void;
  onNotice: (proc: BridgeChild, error: unknown) => void;
}) {
  const env = { ...process.env };
  for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"])
    delete env[key];
  const args = [
    "app-server",
    "--stdio",
    "-c",
    'forced_login_method="chatgpt"',
    "-c",
    'model_provider="openai"',
  ];
  if (orchestrationDir)
    args.push(
      "-c",
      `mcp_servers.local_orchestration.command=${JSON.stringify(process.execPath)}`,
      "-c",
      `mcp_servers.local_orchestration.args=${JSON.stringify([`${cwd}/orchestration-mcp.mjs`, orchestrationDir, "manager", ...(runtimeProjectPath ? [runtimeProjectPath] : [])])}`,
      "-c",
      "mcp_servers.local_orchestration.required=true",
      "-c",
      'mcp_servers.local_orchestration.default_tools_approval_mode="approve"',
    );
  if (orchestrationDir && process.env.ELECTRON_RUN_AS_NODE === "1")
    args.push(
      "-c",
      'mcp_servers.local_orchestration.env.ELECTRON_RUN_AS_NODE="1"',
    );
  const proc = spawn(executable, args, {
    cwd: sessionCwd,
    env,
    stdio: ["pipe", "pipe", "ignore"],
  });

  proc.on("error", (error) => onFailure(proc, error));
  proc.on("exit", () =>
    onFailure(
      proc,
      new Error("Codex process stopped. Reconnect to resume this chat."),
    ),
  );
  createInterface({ input: proc.stdout }).on("line", (line) => {
    try {
      onEnvelope(proc, decodeEnvelope(JSON.parse(line)));
    } catch (error) {
      onNotice(proc, error);
    }
  });
  return proc;
}
export async function initializeManagerPeer(
  rpc: Rpc,
  send: (value: unknown) => void,
): Promise<PrepareResult> {
  await rpc("initialize", {
    clientInfo: { name: "crew_manager", version: "0.6.0" },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
      mcpServerOpenaiFormElicitation: true,
    },
  });
  send({ method: "initialized", params: {} });
  const { account } = await rpc("account/read", { refreshToken: false });
  if (account?.type !== "chatgpt")
    throw new Error(
      "ChatGPT sign-in required. API-key authentication is not allowed.",
    );
  return { auth: account.type, plan: account.planType };
}
