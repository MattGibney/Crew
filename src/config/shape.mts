import { trackingSchema } from "../shared/tracking.mjs";
import { Ajv } from "ajv";
import type { RawConfig, LoadedProject } from "./contracts.mjs";
// This schema proves structural types only. Semantic bounds, unknown-key policy,
// path ownership and provenance are enforced by the configuration validator.
const text = { type: "string" };
const nullableText = { type: ["string", "null"] };
const source = {
  type: "object",
  required: ["path", "sha256"],
  properties: { path: text, sha256: text },
};
const action = {
  type: ["object", "null"],
  required: ["command", "source", "timeoutMs"],
  properties: { command: text, source, timeoutMs: { type: "number" } },
};
const hook = {
  type: "object",
  required: ["command", "args", "timeoutMs"],
  properties: {
    command: text,
    args: { type: "array", items: text },
    timeoutMs: { type: "number" },
  },
};
const environment = {
  type: "object",
  properties: {
    executionPlan: {
      type: "object",
      required: ["schemaVersion", "sources"],
      properties: {
        schemaVersion: { type: "number" },
        sources: { type: "array", items: source },
        ...Object.fromEntries(
          ["setup", "start", "resume", "ready", "stop", "teardown"].map(
            (phase) => [phase, action],
          ),
        ),
        env: { type: "object", properties: { PATH: text } },
        permissionsSource: source,
        networkAccess: { type: "boolean" },
      },
    },
    ...Object.fromEntries(
      ["bootstrap", "start", "ready", "resume", "cleanup"].map((phase) => [
        phase,
        hook,
      ]),
    ),
  },
};
const schema = {
  type: "object",
  required: ["schemaVersion", "runtime", "project"],
  properties: {
    schemaVersion: { type: "number" },
    runtime: {
      type: "object",
      required: ["codexBinary", "dataDir"],
      properties: {
        port: {},
        codexBinary: nullableText,
        dataDir: text,
      },
    },
    project: {
      type: "object",
      required: [
        "id",
        "name",
        "mode",
        "repositories",
        "context",
        "linear",
        "prompts",
        "worker",
      ],
      properties: {
        id: text,
        name: text,
        mode: { enum: ["fixture", "repository"] },
        context: text,
        repositories: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "name", "path", "baseRef", "components"],
            properties: {
              id: text,
              name: text,
              path: nullableText,
              baseRef: nullableText,
              components: { type: "array", items: text },
            },
          },
        },
        tracking: trackingSchema,
        linear: {
          type: "object",
          required: ["teamId", "projectId", "teamKey"],
          properties: {
            teamId: nullableText,
            projectId: nullableText,
            teamKey: nullableText,
          },
        },
        prompts: {
          type: "object",
          required: ["manager", "worker"],
          properties: { manager: text, worker: text },
        },
        worker: {
          type: "object",
          required: ["sandbox", "timeoutMs"],
          properties: {
            sandbox: { enum: ["read-only", "workspace-write"] },
            timeoutMs: { type: "number" },
            maxConcurrent: { type: "number" },
            environment,
          },
        },
      },
    },
  },
};
const validate = new Ajv({ strict: false, allErrors: true }).compile<RawConfig>(
  schema,
);
export function parseConfig(text: string): RawConfig {
  const value: unknown = JSON.parse(text);
  if (!validate(value)) {
    const issue = validate.errors?.[0];
    const field =
      issue?.instancePath.replace(/^\//, "").replaceAll("/", ".") ||
      issue?.params.missingProperty ||
      "root";
    throw new Error(
      `Configuration: ${field} ${issue?.message || "has an invalid shape"}.`,
    );
  }
  return value;
}

type Project = import("../workers/contracts.mjs").Project;
/** MCP context may describe commands without claiming execution-ready configuration. */
export interface RuntimeProjectScope {
  id: string;
  mode: Project["mode"];
  name?: string;
  context?: string;
  repositories?: {
    id: string;
    path?: string | null;
    baseRef?: string | null;
    name?: string;
    components?: string[];
  }[];
  worker?: {
    sandbox?: Project["worker"]["sandbox"];
    timeoutMs?: number;
    maxConcurrent?: number;
    environment?: Record<string, unknown>;
  };
  tracking?: import("../shared/tracking.mjs").TrackingPreferences;
  linear?: {
    teamKey?: string | null;
    teamId?: string | null;
    projectId?: string | null;
  };
  prompts?: { manager: string; worker: string };
  readiness?: { ready: boolean; issues?: string[]; errors?: string[] };
}
const runtimeProjectSchema = {
  type: "object",
  required: ["id", "mode"],
  properties: {
    id: text,
    name: text,
    mode: { enum: ["fixture", "repository"] },
    context: text,
    repositories: {
      type: "array",
      items: {
        type: "object",
        required: ["id"],
        properties: {
          id: text,
          path: nullableText,
          baseRef: nullableText,
          name: text,
          components: { type: "array", items: text },
        },
      },
    },
    worker: {
      type: "object",
      properties: {
        sandbox: { enum: ["read-only", "workspace-write"] },
        timeoutMs: { type: "number" },
        maxConcurrent: { type: "number" },
        environment: { type: "object" },
      },
    },
    tracking: trackingSchema,
    linear: { ...schema.properties.project.properties.linear, required: [] },
    prompts: schema.properties.project.properties.prompts,
    readiness: {
      type: "object",
      required: ["ready"],
      properties: {
        ready: { type: "boolean" },
        issues: { type: "array", items: text },
        errors: { type: "array", items: text },
      },
    },
  },
};
const projectValidator = new Ajv({
  strict: false,
}).compile<RuntimeProjectScope>(runtimeProjectSchema);
const executionProjectValidator = new Ajv({ strict: false }).compile<Project>({
  ...runtimeProjectSchema,
  required: ["id", "mode", "repositories", "worker"],
  properties: {
    ...runtimeProjectSchema.properties,
    repositories: {
      ...runtimeProjectSchema.properties.repositories,
      items: {
        ...runtimeProjectSchema.properties.repositories.items,
        required: ["id", "path", "baseRef"],
      },
    },
    worker: {
      ...schema.properties.project.properties.worker,
      required: ["sandbox"],
    },
  },
});
export function parseRuntimeProject(value: unknown): RuntimeProjectScope {
  if (!projectValidator(value))
    throw new Error("Invalid runtime project configuration.");
  return value;
}

export function requireExecutionProject(value: unknown): Project {
  if (!executionProjectValidator(value))
    throw new Error("Execution project configuration is incomplete.");
  return value;
}

const environmentValidator = new Ajv({ strict: false }).compile<
  import("./contracts.mjs").RawEnvironment
>(environment);
export function parseEnvironmentShape(value: unknown) {
  if (!environmentValidator(value))
    throw new Error("Configuration: invalid worker environment.");
  return value;
}
