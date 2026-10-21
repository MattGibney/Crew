import path from "node:path";
import { isRecord } from "./errors.mjs";
export interface ToolSource {
  path: string;
  content: string;
}
import type { ToolRequirements } from "./contracts.mjs";
export type { ToolRequirements } from "./contracts.mjs";
const fail = (code: string, message: string) =>
  Object.assign(new Error(message), { code });
export const version = (value: unknown) => String(value).replace(/^v/, "");
const tuple = (value: unknown) => version(value).split(".").map(Number);
export const compare = (a: string, b: string) => {
  const x = tuple(a),
    y = tuple(b);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

// Intentionally bounded semver grammar: unsupported expressions must be clarified,
// never interpreted as permission to install an arbitrary newest version.
export function satisfiesToolVersion(candidate: string, range: string) {
  if (!/^\d+\.\d+\.\d+$/.test(version(candidate))) return false;
  const branches = String(range)
    .trim()
    .split(/\s*\|\|\s*/)
    .map((branch) => {
      if (branch.trim() === "*" || branch.trim() === "x") return [];
      return branch
        .trim()
        .split(/\s+/)
        .map((token) => {
          const match = token.match(
            /^(>=|<=|>|<|=|\^|~)?v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/i,
          );
          if (!match)
            throw fail(
              "TOOL_REQUIREMENT_UNSUPPORTED",
              `Unsupported tool version requirement "${range}". Specify a numeric version or a supported semver range.`,
            );
          return match;
        });
    });
  return branches.some((tokens) =>
    tokens.every((match) => {
      const [, op = "", major, minor, patch] = match;
      const floor = `${major}.${/^\d+$/.test(minor) ? minor : 0}.${/^\d+$/.test(patch) ? patch : 0}`;
      const n = compare(candidate, floor);
      if (op === ">=") return n >= 0;
      if (op === "<=") return n <= 0;
      if (op === ">") return n > 0;
      if (op === "<") return n < 0;
      if (op === "^") {
        const upper = Number(major)
          ? `${Number(major) + 1}.0.0`
          : Number(minor || 0)
            ? `0.${Number(minor) + 1}.0`
            : `0.0.${Number(patch || 0) + 1}`;
        return n >= 0 && compare(candidate, upper) < 0;
      }
      if (op === "~")
        return (
          n >= 0 &&
          compare(
            candidate,
            minor == null
              ? `${Number(major) + 1}.0.0`
              : `${major}.${Number(minor) + 1}.0`,
          ) < 0
        );
      const c = tuple(candidate);
      return (
        c[0] === Number(major) &&
        (!/^\d+$/.test(minor) || c[1] === Number(minor)) &&
        (!/^\d+$/.test(patch) || c[2] === Number(patch))
      );
    }),
  );
}

export function discoverToolRequirements({
  sources = [],
}: { sources?: ToolSource[] } = {}) {
  const result: ToolRequirements = {
    node: [],
    npm: [],
    sources: [],
    nodeProject: false,
  };
  const add = (tool: "node" | "npm", range: string, source: string) => {
    range = String(range).trim();
    satisfiesToolVersion("22.0.0", range); // validate even when no release currently matches
    if (!result[tool].includes(range)) result[tool].push(range);
    result.sources.push({ tool, requirement: range, path: source });
  };
  for (const source of sources) {
    const name = path.basename(source.path || "");
    const content = String(source.content || "");
    if (content.length > 262144)
      throw fail(
        "TOOL_REQUIREMENT_TOO_LARGE",
        `Tool requirements source is too large: ${source.path}`,
      );
    if (name === "package.json") {
      result.nodeProject = true;
      let json: unknown;
      try {
        json = JSON.parse(content);
      } catch {
        throw fail(
          "TOOL_REQUIREMENT_INVALID",
          `Cannot read tool requirements from invalid JSON: ${source.path}`,
        );
      }
      if (!isRecord(json))
        throw fail(
          "TOOL_REQUIREMENT_INVALID",
          `Cannot read tool requirements from invalid JSON: ${source.path}`,
        );
      const engines = isRecord(json.engines) ? json.engines : {};
      for (const tool of ["node", "npm"] as const)
        if (engines[tool]) add(tool, String(engines[tool]), source.path);
      if (json.packageManager) {
        const match = String(json.packageManager).match(
          /^npm@([^+]+)(?:\+.*)?$/,
        );
        if (!match)
          throw fail(
            "TOOL_REQUIREMENT_UNSUPPORTED",
            `Crew currently manages Node/npm only. The packageManager declaration in ${source.path} requires a different package manager; resolve that project requirement before execution.`,
          );
        add("npm", match[1], source.path);
      }
      const volta = isRecord(json.volta) ? json.volta : {};
      if (volta.node) add("node", String(volta.node), source.path);
      if (volta.npm) add("npm", String(volta.npm), source.path);
    } else if ([".nvmrc", ".node-version"].includes(name))
      add("node", content.trim(), source.path);
    else if (name === ".tool-versions") {
      for (const line of content.split("\n")) {
        const match = line.match(
          /^\s*(nodejs|node|npm)\s+([^#]+?)(?:\s*#.*)?$/,
        );
        if (match)
          add(
            match[1] === "npm" ? "npm" : "node",
            match[2].trim(),
            source.path,
          );
      }
    } else if (/^(AGENTS|CLAUDE|SKILL)\.md$/i.test(name)) {
      // Only explicit version instructions; prose mentioning a tool alone is not a requirement.
      for (const match of content.matchAll(
        /\b(Node(?:\.js)?|npm)\s*(?:version\s*|v)?(\d+(?:\.\d+){0,2})(?:\.x)?(\+)?(?=$|[^\w.]|\.(?!\d))/gi,
      ))
        add(
          match[1].toLowerCase().startsWith("node") ? "node" : "npm",
          `${match[3] ? ">=" : ""}${match[2]}`,
          source.path,
        );
    }
  }
  return result;
}
