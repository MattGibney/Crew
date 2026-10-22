import { load, JSON_SCHEMA } from "js-yaml";
import type { SkillResource } from "./types.mjs";
export type { SkillResource, SkillDocumentInput } from "./types.mjs";

export const skillLimits = Object.freeze({
  markdownBytes: 128 * 1024,
  metadataBytes: 16 * 1024,
  resourceBytes: 256 * 1024,
  resourceCount: 64,
  totalBytes: 2 * 1024 * 1024,
  skills: 500,
  revisions: 10_000,
});

export class ProjectSkillError extends Error {
  constructor(
    readonly code:
      "invalid" | "conflict" | "missing" | "unsafe_store" | "busy" | "denied",
    message: string,
  ) {
    super(message);
    this.name = "ProjectSkillError";
  }
}

export function fields(
  value: unknown,
  allowed: string[],
  required = allowed,
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    throw new ProjectSkillError(
      "invalid",
      "Unexpected or missing skill fields.",
    );
  return value as Record<string, unknown>;
}

export function textBytes(
  value: unknown,
  max: number,
  label: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    Buffer.byteLength(value) > max ||
    Buffer.from(value).toString("utf8") !== value
  )
    throw new ProjectSkillError(
      "invalid",
      `${label} must be valid UTF-8 text within its size limit.`,
    );
}

export function identifier(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/.test(value)
  )
    throw new ProjectSkillError(
      "invalid",
      "Invalid skill or project identity.",
    );
}

export function expectedRevision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new ProjectSkillError(
      "invalid",
      "A current positive skill revision is required.",
    );
}

export function resourcePath(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > 240 ||
    value.includes("\\") ||
    !/^(?:scripts|references|assets|agents)\/[a-zA-Z0-9_.\/-]+$/.test(value) ||
    value
      .split("/")
      .some(
        (part) =>
          !part || part === "." || part === ".." || part.startsWith("."),
      ) ||
    value.split("/").length > 8 ||
    value.split("/").at(-1)?.toLocaleLowerCase("en-US") === "skill.md"
  )
    throw new ProjectSkillError(
      "invalid",
      "Resource paths must stay within scripts/, references/, assets/, or agents/ without hidden or parent paths.",
    );
}

/** Native YAML frontmatter, parsed without custom YAML tags or executable values. */
export function validateMarkdown(value: unknown): {
  markdown: string;
  name: string;
  description: string;
} {
  textBytes(value, skillLimits.markdownBytes, "SKILL.md");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(value);
  if (!match || Buffer.byteLength(match[1]) > skillLimits.metadataBytes)
    throw new ProjectSkillError(
      "invalid",
      "SKILL.md needs YAML frontmatter between --- lines.",
    );
  let metadata: unknown;
  try {
    metadata = load(match[1], { schema: JSON_SCHEMA, json: false });
  } catch {
    throw new ProjectSkillError(
      "invalid",
      "SKILL.md contains invalid YAML metadata, duplicate fields, or unsupported tags.",
    );
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    throw new ProjectSkillError(
      "invalid",
      "Skill metadata must contain name and description fields.",
    );
  const { name, description } = metadata as Record<string, unknown>;
  if (
    typeof name !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
    name.length > 64
  )
    throw new ProjectSkillError(
      "invalid",
      "Use a skill name of 1–64 lowercase letters, digits, and single hyphens.",
    );
  if (
    typeof description !== "string" ||
    !description.trim() ||
    description.length > 1024 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(description)
  )
    throw new ProjectSkillError(
      "invalid",
      "Skill description must contain 1–1024 readable characters.",
    );
  if (!match[2].trim())
    throw new ProjectSkillError(
      "invalid",
      "Add instructions below the skill metadata.",
    );
  return { markdown: value, name, description: description.trim() };
}

export function validateResources(value: unknown): SkillResource[] {
  if (!Array.isArray(value) || value.length > skillLimits.resourceCount)
    throw new ProjectSkillError(
      "invalid",
      `A skill supports at most ${skillLimits.resourceCount} text resources.`,
    );
  const seen = new Set<string>();
  return value.map((input) => {
    const item = fields(
      input,
      ["path", "content", "executable"],
      ["path", "content"],
    );
    resourcePath(item.path);
    textBytes(item.content, skillLimits.resourceBytes, "Skill resource");
    if (item.executable !== undefined && typeof item.executable !== "boolean")
      throw new ProjectSkillError(
        "invalid",
        "Resource executable must be true or false.",
      );
    if (item.executable === true && !item.path.startsWith("scripts/"))
      throw new ProjectSkillError(
        "invalid",
        "Only scripts/ resources may be marked executable.",
      );
    const key = item.path.toLocaleLowerCase("en-US");
    if (seen.has(key))
      throw new ProjectSkillError(
        "conflict",
        "Resource paths must be unique, including letter case.",
      );
    if (
      [...seen].some(
        (other) => key.startsWith(other + "/") || other.startsWith(key + "/"),
      )
    )
      throw new ProjectSkillError(
        "conflict",
        "A resource file cannot also be a directory for another resource.",
      );
    seen.add(key);
    return {
      path: item.path,
      content: item.content,
      executable: item.executable === true,
    };
  });
}

export function validateDocument(
  input: unknown,
  retained: SkillResource[] = [],
) {
  const value = fields(input, ["markdown", "resources"], ["markdown"]);
  const metadata = validateMarkdown(value.markdown);
  const resources =
    value.resources === undefined
      ? retained
      : validateResources(value.resources);
  if (
    Buffer.byteLength(metadata.markdown) +
      resources.reduce(
        (sum, item) => sum + Buffer.byteLength(item.content),
        0,
      ) >
    skillLimits.totalBytes
  )
    throw new ProjectSkillError(
      "invalid",
      "This skill exceeds the 2 MiB total text size limit.",
    );
  return { ...metadata, resources };
}
