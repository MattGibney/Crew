// AI-010: discover proven local choices and perform bounded, read-only Linear setup reads.
import { realpath, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  openSetupRpc,
  initializeSetupRpc,
  type SetupConnectionOptions,
} from "./setup-rpc.mjs";
import { record, parseJSON, errorMessage, isString } from "./validation.mjs";
export interface RepositoryOption {
  status: string;
  selectedPath?: string;
  path: string;
  name: string;
  id?: string;
  branches: Array<{ value: string; label: string; kind: string; ref?: string }>;
  baseRef?: string | null;
  defaultBranch?: string | null;
  currentBranch?: string | null;
  detail: string;
  verifiedExistingRef?: string;
}
export interface LinearTeam {
  id: string;
  name: string;
  key: string | null;
}
export interface LinearProject {
  id: string;
  name: string;
  teamIds: string[];
}
export interface LinearCatalog {
  teams: LinearTeam[];
  projects: LinearProject[];
  truncated: boolean;
  status: string;
  detail: string;
  teamsStatus?: string;
  projectsStatus?: string;
}
type Rpc = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;
const objectOrEmpty = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? record(value)
    : {};
const objects = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(objectOrEmpty) : [];
const run = promisify(execFile);
const clean = (v: unknown) =>
  typeof v === "string"
    ? v.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 300)
    : null;
export async function discoverRepository({
  path,
  env = process.env,
}: {
  path: string;
  env?: NodeJS.ProcessEnv;
}): Promise<RepositoryOption> {
  if (typeof path !== "string" || !path.trim() || path.includes("\0"))
    throw new Error("Choose a local project folder.");
  const selectedPath = await realpath(resolve(path));
  if (!(await stat(selectedPath)).isDirectory())
    throw new Error("Choose a folder, rather than a file.");
  const git = async (args: string[]) =>
    (
      await run("git", ["-C", selectedPath, ...args], {
        env: { ...env, GIT_OPTIONAL_LOCKS: "0" },
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      })
    ).stdout.trim();
  let repositoryPath;
  try {
    repositoryPath = await realpath(
      await git(["rev-parse", "--show-toplevel"]),
    );
  } catch {
    throw new Error(
      "This folder is not a Git repository. Choose the project repository folder.",
    );
  }
  const name = basename(repositoryPath),
    id =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^[^a-z]+/, "")
        .replace(/-$/, "")
        .slice(0, 64) || "project";
  const raw = await git([
    "for-each-ref",
    "--format=%(refname)%09%(symref)%09%(objecttype)",
    "refs/heads",
    "refs/remotes",
  ]);
  const branches: RepositoryOption["branches"] = [];
  for (const line of raw.split("\n")) {
    const [ref, symref, type] = line.split("\t");
    if (!ref || symref || type !== "commit") continue;
    branches.push({
      value: ref.replace(/^refs\/(heads|remotes)\//, ""),
      label: ref.replace(/^refs\/(heads|remotes)\//, ""),
      kind: ref.startsWith("refs/heads/") ? "local" : "remote",
    });
  }
  branches.sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label),
  );
  let origin = null,
    current = null;
  try {
    origin = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  } catch {}
  try {
    current = await git(["symbolic-ref", "--short", "HEAD"]);
  } catch {}
  let baseRef =
    [origin, "main", "master", current].find(
      (value) => value && branches.some((b) => b.value === value),
    ) || null;
  // A detached HEAD is a valid committed starting point, but an unborn HEAD is not.
  if (!baseRef) {
    try {
      const hash = await git(["rev-parse", "--verify", "HEAD^{commit}"]);
      if (/^[a-f0-9]{40,64}$/.test(hash)) {
        branches.push({
          value: hash,
          label: `Current commit (${hash.slice(0, 8)})`,
          kind: "commit",
        });
        baseRef = hash;
      }
    } catch {}
  }
  return {
    status: baseRef ? "verified" : "incomplete",
    selectedPath,
    path: repositoryPath,
    name,
    id,
    branches: branches.map((b) => ({ ...b, ref: b.value })),
    baseRef,
    defaultBranch: baseRef,
    currentBranch: current,
    detail: baseRef
      ? "Starting branch selected from this repository. You can change it later."
      : "This repository has no committed starting point yet. Make its first commit, then try again.",
  };
}
export async function verifyReference({
  path,
  ref,
  env = process.env,
}: {
  path: string;
  ref: string;
  env?: NodeJS.ProcessEnv;
}) {
  if (
    typeof ref !== "string" ||
    !ref.trim() ||
    ref.startsWith("-") ||
    /[\u0000-\u001f\u007f]/.test(ref) ||
    ref.length > 1024
  )
    throw new Error("Choose a valid starting branch.");
  const folder = await realpath(resolve(path));
  try {
    const { stdout } = await run(
      "git",
      [
        "-C",
        folder,
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${ref}^{commit}`,
      ],
      {
        env: { ...env, GIT_OPTIONAL_LOCKS: "0" },
        timeout: 10000,
        maxBuffer: 65536,
      },
    );
    const commit = stdout.trim();
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw Error();
    return { path: folder, ref, commit, status: "verified" };
  } catch {
    throw new Error(
      "That starting branch is not available in this repository. Refresh the branch list and choose an existing branch.",
    );
  }
}
async function withClient<T>(
  options: SetupConnectionOptions,
  body: (rpc: Rpc) => Promise<T>,
): Promise<T> {
  if (!options.executable)
    throw new Error("Install Codex and sign in with ChatGPT, then retry.");
  const client = openSetupRpc(options);
  try {
    await initializeSetupRpc(client, "crew_setup_options");
    return await body((method, params) => client.request(method, params));
  } finally {
    await client.close();
  }
}
function payload(result: unknown): Record<string, unknown> | unknown[] {
  const value = record(result);
  if (value.isError)
    throw new Error(
      "Linear could not read this workspace. Reconnect Linear in Codex and retry.",
    );
  if (value.structuredContent && typeof value.structuredContent === "object")
    return Array.isArray(value.structuredContent)
      ? value.structuredContent
      : record(value.structuredContent);
  for (const block of objects(value.content))
    if (block.type === "text" && typeof block.text === "string") {
      try {
        const parsed = parseJSON(block.text);
        return Array.isArray(parsed) ? parsed : record(parsed);
      } catch {}
    }
  throw new Error(
    "Linear returned an unrecognized response. Retry or connect it later.",
  );
}
function records(
  data: Record<string, unknown> | unknown[],
  kind: string,
): unknown {
  if (Array.isArray(data)) return data;
  return (
    data[kind] ||
    data.nodes ||
    objectOrEmpty(data.data)[kind] ||
    data.data ||
    []
  );
}
function normalizeTeam(rows: unknown): LinearTeam[] {
  if (!Array.isArray(rows))
    throw new Error(
      "Linear returned an unrecognized list. Retry or connect it later.",
    );
  return objects(rows)
    .filter((row) => typeof row.id === "string" && typeof row.name === "string")
    .map((row) => ({
      id: clean(row.uuid) || clean(row.id) || "",
      name: clean(row.name) || "",
      key: clean(row.key),
    }));
}
function normalizeProject(rows: unknown): LinearProject[] {
  if (!Array.isArray(rows))
    throw new Error(
      "Linear returned an unrecognized list. Retry or connect it later.",
    );
  return objects(rows)
    .filter((row) => typeof row.id === "string" && typeof row.name === "string")
    .map((row) => {
      const teams = Array.isArray(row.teams)
        ? row.teams
        : objectOrEmpty(row.teams).nodes;
      return {
        id: clean(row.uuid) || clean(row.id) || "",
        name: clean(row.name) || "",
        teamIds: Array.isArray(teams)
          ? teams
              .map((team) =>
                clean(typeof team === "string" ? team : objectOrEmpty(team).id),
              )
              .filter(isString)
          : clean(objectOrEmpty(row.team).id)
            ? [String(objectOrEmpty(row.team).id)]
            : [],
      };
    });
}
export async function discoverLinearOptions({
  executable,
  root,
  env = process.env,
  signal,
  teamId = null,
  timeoutMs = 20000,
  rpc: injectedRpc,
}: {
  executable?: string;
  root: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  teamId?: string | null;
  timeoutMs?: number;
  rpc?: Rpc;
}): Promise<LinearCatalog> {
  const empty = { teams: [], projects: [], truncated: false };
  const discover = async (rpc: Rpc): Promise<LinearCatalog> => {
    const account = objectOrEmpty(
      record(await rpc("account/read", { refreshToken: false })).account,
    );
    if (account.type !== "chatgpt")
      return {
        ...empty,
        status: "unavailable",
        detail:
          "Sign in to Codex with ChatGPT, connect Linear, then retry. You can continue without Linear.",
      };
    const tools: Array<{
      server: string;
      name: string;
      spec: Record<string, unknown>;
    }> = [];
    let cursor: unknown = null,
      catalogTruncated = false;
    for (let i = 0; i < 5; i++) {
      const page = record(
        await rpc("mcpServerStatus/list", {
          cursor,
          limit: 100,
          detail: "toolsAndAuthOnly",
        }),
      );
      for (const server of objects(page.data))
        for (const [name, spec] of Object.entries(objectOrEmpty(server.tools)))
          if (
            typeof server.name === "string" &&
            /linear/i.test(`${server.name} ${name}`)
          )
            tools.push({
              server: server.name,
              name,
              spec: objectOrEmpty(spec),
            });
      cursor = page.nextCursor;
      catalogTruncated = Boolean(cursor);
      if (!cursor) break;
    }
    const find = (kind: string) =>
      tools.find((tool) =>
        new RegExp(`(?:^|[._/])list_${kind}$`, "i").test(tool.name),
      );
    const teamTool = find("teams"),
      projectTool = find("projects");
    if (!teamTool && !projectTool)
      return {
        ...empty,
        status: catalogTruncated ? "unknown" : "unavailable",
        detail:
          "Linear is not available in Codex. Connect Linear in Codex and retry, or continue without it.",
      };
    const started = record(
        await rpc("thread/start", {
          cwd: root,
          ephemeral: true,
          sandbox: "read-only",
          approvalPolicy: "never",
          environments: [],
        }),
      ),
      threadId = objectOrEmpty(started.thread).id;
    if (typeof threadId !== "string" || !threadId)
      throw new Error(
        "Codex could not open a temporary connection for Linear. Retry.",
      );
    const result: LinearCatalog = {
      ...empty,
      status: "verified",
      detail:
        "Read available teams and projects from your connected Linear workspace.",
      teamsStatus: teamTool ? "verified" : "unavailable",
      projectsStatus: projectTool ? "verified" : "unavailable",
    };
    try {
      for (const [kind, tool] of [
        ["teams", teamTool],
        ["projects", projectTool],
      ] as const) {
        if (!tool) continue;
        try {
          const schema = objectOrEmpty(tool.spec.inputSchema),
            properties = objectOrEmpty(schema.properties),
            required = Array.isArray(schema.required) ? schema.required : [],
            allowed = new Set(["limit", "cursor", "team"]);
          if (
            required.some(
              (key) =>
                typeof key !== "string" ||
                !allowed.has(key) ||
                (key === "team" && !teamId),
            )
          )
            throw new Error(
              "This Linear connector requires additional information. You can connect it later.",
            );
          let next: unknown = null;
          const rows: unknown[] = [];
          for (let i = 0; i < 5; i++) {
            const args: Record<string, unknown> = {};
            if (properties.limit)
              args.limit = Math.min(
                100,
                Number(objectOrEmpty(properties.limit).maximum) || 100,
              );
            const fields = objectOrEmpty(
              objectOrEmpty(properties.fields).items,
            ).enum;
            if (
              kind === "projects" &&
              Array.isArray(fields) &&
              fields.includes("teams")
            )
              args.fields = ["id", "uuid", "name", "teams"].filter((field) =>
                fields.includes(field),
              );
            if (next && properties.cursor) args.cursor = next;
            if (teamId && kind === "projects" && properties.team)
              args.team = teamId;
            const data = payload(
              await rpc("mcpServer/tool/call", {
                threadId,
                server: tool.server,
                tool: tool.name,
                arguments: args,
              }),
            );
            const values = records(data, kind);
            if (!Array.isArray(values))
              throw new Error(
                "Linear returned an unrecognized list. Retry or connect it later.",
              );
            rows.push(...values);
            const pagination = Array.isArray(data) ? {} : data;
            const info = objectOrEmpty(
                pagination.pageInfo || objectOrEmpty(pagination.data).pageInfo,
              ),
              more = pagination.hasNextPage ?? info.hasNextPage ?? false;
            next = pagination.cursor || pagination.nextCursor || info.endCursor;
            if (!more && !pagination.nextCursor) break;
            if (!next || !properties.cursor || i === 4) {
              result.truncated = true;
              break;
            }
          }
          if (kind === "teams")
            result.teams = [
              ...new Map(
                normalizeTeam(rows).map((row) => [row.id, row]),
              ).values(),
            ];
          else
            result.projects = [
              ...new Map(
                normalizeProject(rows).map((row) => [row.id, row]),
              ).values(),
            ];
        } catch (error) {
          result[kind === "teams" ? "teamsStatus" : "projectsStatus"] =
            "unavailable";
          result.status = "partial";
          result.detail = errorMessage(error);
        }
      }
      if (
        result.teamsStatus === "unavailable" &&
        result.projectsStatus === "unavailable"
      )
        result.status = "unavailable";
      return result;
    } finally {
      await rpc("thread/unsubscribe", { threadId }).catch(() => {});
    }
  };
  try {
    return injectedRpc
      ? await discover(injectedRpc)
      : await withClient(
          { executable: executable || "", root, env, signal, timeoutMs },
          discover,
        );
  } catch (error) {
    return {
      ...empty,
      status: signal?.aborted ? "canceled" : "unavailable",
      detail: errorMessage(error),
    };
  }
}
