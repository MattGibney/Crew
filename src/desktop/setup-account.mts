import { openSetupRpc, initializeSetupRpc } from "./setup-rpc.mjs";
import { record, errorMessage } from "./validation.mjs";
import type { SetupContext, SetupCheck } from "./setup-service.mjs";
const optionalRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? record(value)
    : {};
export async function probeCodex({
  executable,
  root,
  env,
  startLogin = false,
  openLogin = async () => {},
}: Omit<SetupContext, "configPath"> & {
  executable: string;
  startLogin?: boolean;
  openLogin?: (url: string) => Promise<unknown>;
}): Promise<Record<string, SetupCheck>> {
  const client = openSetupRpc({ executable, root, env });
  let loginDone: ((result: Record<string, unknown>) => void) | undefined;
  client.onNotification((method, params) => {
    if (method === "account/login/completed") loginDone?.(params);
  });
  try {
    await initializeSetupRpc(client, "crew_setup");
    if (startLogin) {
      let timer: NodeJS.Timeout | undefined;
      const completion = new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          loginDone = resolve;
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "Sign-in was not completed within three minutes. Retry when ready.",
                ),
              ),
            180000,
          );
        },
      );
      completion.catch(() => {});
      try {
        const login = await client.request("account/login/start", {
          type: "chatgpt",
        });
        if (typeof login.authUrl !== "string")
          throw new Error("Codex returned an invalid sign-in destination.");
        const url = new URL(login.authUrl);
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          !["auth.openai.com", "auth0.openai.com", "login.openai.com"].includes(
            url.hostname,
          )
        )
          throw new Error(
            "Codex returned an unexpected sign-in destination. Use the installed Codex app to sign in, then retry.",
          );
        await openLogin(url.href);
        if (!(await completion).success)
          throw new Error(
            "ChatGPT sign-in did not complete. Use Codex to sign in, then retry.",
          );
      } finally {
        clearTimeout(timer);
        loginDone = undefined;
      }
    }
    const account = optionalRecord(
      (await client.request("account/read", { refreshToken: false })).account,
    );
    const result: Record<string, SetupCheck> = {
      protocol: {
        status: "verified",
        detail: "App-server handshake succeeded. No model work started.",
      },
      auth: {
        status: account.type === "chatgpt" ? "verified" : "unavailable",
        detail:
          account.type === "chatgpt"
            ? `ChatGPT sign-in confirmed${account.planType ? ` (${account.planType})` : ""}. Usage limits and voice availability still apply.`
            : "ChatGPT sign-in required. API-key authentication is not supported.",
      },
      voices: {
        status: "unknown",
        detail: "Sign in to check the realtime voice catalog.",
      },
      tools: {
        status: "unknown",
        detail: "Sign in, then check connected tools.",
      },
    };
    if (account.type === "chatgpt") {
      try {
        const voices = optionalRecord(
          (await client.request("thread/realtime/listVoices")).voices,
        );
        if (!Array.isArray(voices.v3) || !voices.v3.length)
          throw new Error("No v3 voices returned.");
        result.voices = {
          status: "verified",
          detail: `${voices.v3.length} v3 voices advertised. No audio session started; device audio is checked separately.`,
        };
      } catch (error) {
        result.voices = { status: "unavailable", detail: errorMessage(error) };
      }
      try {
        const rows: Record<string, unknown>[] = [];
        let cursor: unknown = null;
        for (let i = 0; i < 5; i++) {
          const page = await client.request("mcpServerStatus/list", {
            cursor,
            limit: 100,
            detail: "toolsAndAuthOnly",
          });
          if (!Array.isArray(page.data))
            throw new Error("Codex returned an invalid tool catalog.");
          rows.push(...page.data.map((value) => record(value)));
          cursor = page.nextCursor;
          if (!cursor) break;
        }
        const servers = rows.map((server) => ({
          name: typeof server.name === "string" ? server.name : "unknown",
          status:
            typeof server.runtimeStatus === "string"
              ? server.runtimeStatus
              : "unknown",
          auth:
            typeof server.authStatus === "string"
              ? server.authStatus
              : "unknown",
          tools: Object.keys(optionalRecord(server.tools)),
        }));
        const linearTools = servers
          .flatMap((server) =>
            server.tools.map((name) => `${server.name}/${name}`),
          )
          .filter((name) =>
            /linear.*(get_issue|search|fetch|list_teams|get_team|list_projects)/i.test(
              name,
            ),
          );
        result.tools = {
          status: "discovered",
          detail:
            "Tool discovery advertises capabilities, not verified resource access. Only selected integrations need resource reads; tracking is optional.",
          servers,
          truncated: Boolean(cursor),
          github: {
            status: servers.some((server) =>
              server.tools.some((name) =>
                /github.*(fetch_issue|get_repo|list_repositories|get_pr_info|search)/i.test(
                  `${server.name}/${name}`,
                ),
              ),
            )
              ? "advertised"
              : "unavailable",
            detail:
              "Repository, issue, review and check access need separate real reads through connected tools. Retry account discovery or switch/disable this optional integration.",
          },
          linear: {
            status: linearTools.length
              ? "advertised"
              : cursor
                ? "unknown"
                : "unavailable",
            detail: linearTools.length
              ? `${linearTools.length} possible Linear read tools advertised. Team/project access still needs a real read.`
              : "No Linear read tool was identified in this discovery. Connect the intended tools in Codex and retry; discovery may not expose every dynamic tool.",
          },
        };
      } catch (error) {
        result.tools = { status: "unavailable", detail: errorMessage(error) };
      }
    }
    return result;
  } finally {
    await client.close();
  }
}
