// GH-78: bounded discovery through existing authenticated native tools, never a GitHub API client.
import { withClient, payload, type Rpc } from "./project-options.mjs";
import { record, errorMessage } from "./validation.mjs";
import { repositoryName } from "../shared/tracking.mjs";
export interface GitHubCatalog {
  status: "verified" | "partial" | "advertised" | "unavailable";
  detail: string;
  repositories: { fullName: string; url: string }[];
  truncated: boolean;
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? record(value)
    : {};
}
export async function discoverGitHubOptions(options: {
  executable?: string;
  root: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  rpc?: Rpc;
  repository?: string;
}): Promise<GitHubCatalog> {
  const empty: GitHubCatalog = {
    status: "unavailable",
    detail: "",
    repositories: [],
    truncated: false,
  };
  const discover = async (rpc: Rpc): Promise<GitHubCatalog> => {
    if (
      object(record(await rpc("account/read", { refreshToken: false })).account)
        .type !== "chatgpt"
    )
      return {
        ...empty,
        detail:
          "Sign in to Codex with ChatGPT, then retry. Tracking is optional.",
      };
    if (options.repository && !repositoryName.test(options.repository))
      throw Error("Enter the exact GitHub owner/repository name.");
    let cursor: unknown = null;
    const candidates: {
      server: string;
      tool: string;
      schema: Record<string, unknown>;
    }[] = [];
    for (let i = 0; i < 5; i++) {
      const page = record(
        await rpc("mcpServerStatus/list", {
          cursor,
          limit: 100,
          detail: "toolsAndAuthOnly",
        }),
      );
      for (const server of Array.isArray(page.data)
        ? page.data.map(object)
        : []) {
        for (const [name, spec] of Object.entries(object(server.tools))) {
          if (
            typeof server.name === "string" &&
            /github/i.test(`${server.name} ${name}`) &&
            new RegExp(
              `(?:^|[._/])${options.repository ? "get_repo" : "list_repositories"}$`,
            ).test(name) &&
            !/security|defense/i.test(`${server.name} ${name}`)
          )
            candidates.push({
              server: server.name,
              tool: name,
              schema: object(object(spec).inputSchema),
            });
        }
      }
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    if (candidates.length !== 1)
      return {
        ...empty,
        status: candidates.length ? "advertised" : "unavailable",
        truncated: Boolean(cursor),
        detail: candidates.length
          ? "Multiple GitHub repository tools are advertised. Ask the manager to verify the intended account/repository through your chosen connection; no account was selected automatically."
          : "No supported GitHub repository discovery tool was advertised. Connect GitHub in Codex and retry, or switch/disable tracking. The manager may discover other normal tools.",
      };
    const selected = candidates[0],
      properties = object(selected.schema.properties);
    if (
      Array.isArray(selected.schema.required) &&
      selected.schema.required.some(
        (field) => field !== "repository_full_name" || !options.repository,
      )
    )
      return {
        ...empty,
        status: "advertised",
        detail:
          "GitHub is advertised but this repository-list tool requires additional account information. Ask the manager to verify it using normal tools, or switch/disable tracking.",
      };
    const started = record(
      await rpc("thread/start", {
        cwd: options.root,
        ephemeral: true,
        environments: [],
      }),
    );
    const threadId = object(started.thread).id;
    if (typeof threadId !== "string" || !threadId)
      throw Error("Could not create a temporary tool connection. Retry.");
    try {
      const args: Record<string, unknown> = {};
      if (options.repository) {
        if (!properties.repository_full_name)
          throw Error(
            "This GitHub tool does not advertise an exact repository lookup. Ask the manager to verify through normal tools.",
          );
        args.repository_full_name = options.repository;
      }
      if (properties.page_size) args.page_size = 100;
      if (properties.perPage) args.perPage = 100;
      if (properties.per_page) args.per_page = 100;
      const response = payload(
        await rpc("mcpServer/tool/call", {
          threadId,
          server: selected.server,
          tool: selected.tool,
          arguments: args,
        }),
      );
      const data = object(response);
      const rows: unknown = options.repository
        ? [data.repository || data]
        : Array.isArray(response)
          ? response
          : data.repositories ||
            data.repos ||
            data.items ||
            object(data.data).repositories;
      if (!Array.isArray(rows))
        throw Error(
          "GitHub returned an unsupported repository list. Ask the manager to verify through normal tools; saved settings are retained.",
        );
      const repositories = rows
        .slice(0, 100)
        .map(object)
        .flatMap((row) => {
          const fullName =
            row.full_name ||
            row.fullName ||
            row.nameWithOwner ||
            row.repository_full_name;
          return typeof fullName === "string" && repositoryName.test(fullName)
            ? [{ fullName, url: `https://github.com/${fullName}` }]
            : [];
        });
      if (
        options.repository &&
        (repositories.length !== 1 ||
          repositories[0].fullName.toLowerCase() !==
            options.repository.toLowerCase())
      )
        throw Error(
          "GitHub returned a different repository identity. Saved mapping was not changed; confirm the intended owner/repository with the manager.",
        );
      const partial = repositories.length !== rows.slice(0, 100).length;
      return {
        status: partial ? "partial" : "verified",
        repositories,
        truncated:
          rows.length >= 100 ||
          Boolean(data.has_more || data.nextCursor || data.next_page),
        detail: partial
          ? "Read GitHub repositories, but some returned identities were unsupported. Retry or verify missing repositories with the manager."
          : "Read accessible GitHub repositories. Select the intended owner/repository explicitly. Issue, review and check access need their own reads; this list is bounded.",
      };
    } finally {
      await rpc("thread/unsubscribe", { threadId }).catch(() => {});
    }
  };
  try {
    return options.rpc
      ? await discover(options.rpc)
      : await withClient(
          {
            ...options,
            executable: options.executable || "",
            timeoutMs: options.timeoutMs || 20000,
          },
          discover,
        );
  } catch (error) {
    return { ...empty, detail: errorMessage(error) };
  }
}
