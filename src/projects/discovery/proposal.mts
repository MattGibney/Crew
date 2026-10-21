import type { JsonValue } from "../../workers/contracts.mjs";
import { Ajv } from "ajv";
import type { ProjectInventory, DiscoveryAnalysis } from "./contracts.mjs";
import { redact } from "./safety.mjs";
const stringSchema = { type: "string" };
export const discoveryOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "name",
    "summary",
    "components",
    "managerContext",
    "workerContext",
    "findings",
    "questions",
  ],
  properties: {
    name: stringSchema,
    summary: stringSchema,
    components: { type: "array", items: stringSchema },
    managerContext: stringSchema,
    workerContext: stringSchema,
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["statement", "status", "sources"],
        properties: {
          statement: stringSchema,
          status: { type: "string", enum: ["inferred", "unknown"] },
          sources: { type: "array", items: stringSchema },
        },
      },
    },
    questions: { type: "array", items: stringSchema },
  },
};
const analysisShape = new Ajv({ strict: false }).compile<DiscoveryAnalysis>(
  discoveryOutputSchema,
);
export function validateAnalysis(
  input: unknown,
  inventory: ProjectInventory,
): DiscoveryAnalysis {
  if (!analysisShape(input))
    throw new Error(
      "Discovery returned an invalid proposal. No configuration was applied.",
    );
  const value = input;
  const fail = () => {
    throw new Error(
      "Discovery returned an invalid proposal. No configuration was applied.",
    );
  };
  const keys = discoveryOutputSchema.required;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k)) ||
    keys.some((k) => !(k in value))
  )
    fail();
  const text = (x: unknown, max: number) =>
    typeof x === "string" && x.trim() && x.length <= max && !x.includes("\0");
  for (const [key, max] of [
    ["name", 200],
    ["summary", 16000],
    ["managerContext", 16000],
    ["workerContext", 16000],
  ] as const)
    if (!text(value[key], max)) fail();
  for (const [key, max] of [
    ["components", 100],
    ["questions", 30],
  ] as const)
    if (
      !Array.isArray(value[key]) ||
      value[key].length > max ||
      value[key].some((x) => !text(x, 1000))
    )
      fail();
  const sources = new Set(inventory.sources.map((s) => s.path));
  if (!Array.isArray(value.findings) || value.findings.length > 60) fail();
  for (const finding of value.findings) {
    if (
      !finding ||
      Object.keys(finding).sort().join() !== "sources,statement,status" ||
      !text(finding.statement, 2000) ||
      !["inferred", "unknown"].includes(finding.status) ||
      !Array.isArray(finding.sources) ||
      finding.sources.length > 24 ||
      finding.sources.some((s) => !sources.has(s)) ||
      (finding.status === "inferred" && !finding.sources.length)
    )
      fail();
  }
  // Secret-looking text is never persisted, including model-generated content.
  const sanitize = (x: JsonValue): JsonValue =>
    typeof x === "string"
      ? redact(x)
      : Array.isArray(x)
        ? x.map(sanitize)
        : x && typeof x === "object"
          ? Object.fromEntries(
              Object.entries(x).map(([k, v]) => [k, sanitize(v)]),
            )
          : x;
  return {
    ...value,
    name: redact(value.name),
    summary: redact(value.summary),
    managerContext: redact(value.managerContext),
    workerContext: redact(value.workerContext),
    components: value.components.map(redact),
    questions: value.questions.map(redact),
    findings: value.findings.map((finding) => ({
      ...finding,
      statement: redact(finding.statement),
      status: redact(finding.status),
      sources: finding.sources.map(redact),
    })),
  };
}

// Model prose is useful project context, not setup UI or a source of repository identity.
const setupDirective =
  /\b(?:confirm|ask|check|verify|review|choose|select|provide|fill|enter|set)\b[^.!?\n]{0,100}\b(?:with the user|with the owner|team id|project id|team key|linear (?:workspace|team|project|mapping)|base ref|starting branch|configuration|setup|proposal|prompts?|project name)\b|\b(?:human review required|draft for (?:human )?review|confirm (?:this|these) with (?:the )?user)\b/i;
export function projectProse(value: string) {
  return value
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((line) =>
      line
        .replace(
          /^\s*(?:#{1,6}\s*)?(?:DRAFT(?:\s*[—–:-]\s*(?:human review required|for review))?|human review required)\s*[.:—–-]?\s*/i,
          "",
        )
        .trim(),
    )
    .filter(
      (line) =>
        line &&
        !/\b(?:this proposal|human review should|does not authorize activation|before (?:any )?work is activated)\b/i.test(
          line,
        ) &&
        !setupDirective.test(line) &&
        !/^(?:todo|next steps?|questions? for (?:the )?(?:user|owner))\s*:/i.test(
          line,
        ),
    )
    .join("\n")
    .trim();
}
export function projectName(value: string, fallback: string) {
  const name = value
    .replace(/^\s*#{1,6}\s*/, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(
      /\s*\((?:draft|inferred|unconfirmed|for review|confirm[^)]*)\)\s*/gi,
      " ",
    )
    .replace(
      /\s*[—–:-]\s*(?:draft|for review|confirm\b|human review)[\s\S]*$/i,
      "",
    )
    .replace(/^(?:draft|proposed)\s*[:—–-]\s*/i, "")
    .trim();
  return !name ||
    name.length > 100 ||
    /[\n\r]|\b(?:draft|confirm|unknown|untitled|human review|todo)\b/i.test(
      name,
    )
    ? fallback
    : name;
}
export function unresolvedQuestions(questions: string[]) {
  return questions.filter(
    (question) =>
      !setupDirective.test(question) &&
      !/\b(?:business (?:goals?|outcomes?|intent)|project (?:name|id)|repository (?:name|path)|base ref|branch|team id|project id|team key|workspace|port|state directory|review|draft|prompt)\b/i.test(
        question,
      ),
  );
}
