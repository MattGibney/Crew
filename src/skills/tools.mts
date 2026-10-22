import type { CallerContext, JsonObject } from "../agents/contracts.mjs";
import type { ProjectSkillStore } from "./store.mjs";
import {
  ProjectSkillError,
  fields,
  identifier,
  expectedRevision,
  skillLimits,
  type SkillDocumentInput,
} from "./validation.mjs";

export interface ProjectSkillToolOptions {
  store: ProjectSkillStore;
  /** Supplied by authenticated native transport, never a tool argument. */
  caller: CallerContext;
  /** The composition owns current membership, session identity, and execution
   * admission/reservation. This callback must hold admission through operation. */
  runAuthorized<T>(
    caller: CallerContext,
    action: "skills.read" | "skills.write",
    operation: () => Promise<T>,
  ): Promise<T>;
}

const object = (
  properties: JsonObject,
  required = Object.keys(properties),
): JsonObject => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const skillId = { type: "string", minLength: 1, maxLength: 256 };
const markdown = { type: "string", maxLength: skillLimits.markdownBytes };
const resources = {
  type: "array",
  maxItems: skillLimits.resourceCount,
  items: object(
    {
      path: { type: "string", maxLength: 240 },
      content: { type: "string", maxLength: skillLimits.resourceBytes },
      executable: { type: "boolean" },
    },
    ["path", "content"],
  ),
};
const catalogue = [
  {
    name: "skills_list",
    description:
      "List this project's saved native skills. Skills contain instructions and never grant access.",
    inputSchema: object({}),
  },
  {
    name: "skill_read",
    description:
      "Read the current SKILL.md, resource text and revision from the canonical project store.",
    inputSchema: object({ skillId }),
  },
  {
    name: "skill_create",
    description:
      "Create a project-only native skill in Crew storage. Does not install into personal or repository skills, assign it, restart agents or grant permissions.",
    inputSchema: object({ markdown, resources }, ["markdown"]),
  },
  {
    name: "skill_update",
    description:
      "Save SKILL.md with its current expectedRevision. Omitted resources are retained; a supplied array replaces them. Active sessions retain their pinned revision until explicit Restart.",
    inputSchema: object(
      {
        skillId,
        expectedRevision: { type: "integer", minimum: 1 },
        markdown,
        resources,
      },
      ["skillId", "expectedRevision", "markdown"],
    ),
  },
];

export function createProjectSkillAgentTools(options: ProjectSkillToolOptions) {
  const caller = structuredClone(options.caller);
  if (caller.projectId !== options.store.projectId)
    throw new ProjectSkillError(
      "denied",
      "Skill tools belong to another project.",
    );
  return {
    list: () => structuredClone(catalogue),
    async call(name: string, input: JsonObject): Promise<unknown> {
      if (!catalogue.some((tool) => tool.name === name))
        throw new ProjectSkillError("invalid", "Unknown project skill tool.");
      return options.runAuthorized(
        caller,
        name === "skills_list" || name === "skill_read"
          ? "skills.read"
          : "skills.write",
        async () => {
          switch (name) {
            case "skills_list":
              fields(input, []);
              return options.store.list();
            case "skill_read": {
              const args = fields(input, ["skillId"]);
              identifier(args.skillId);
              return options.store.read(args.skillId);
            }
            case "skill_create": {
              const args = fields(
                input,
                ["markdown", "resources"],
                ["markdown"],
              );
              return options.store.create(
                args as unknown as SkillDocumentInput,
              );
            }
            case "skill_update": {
              const args = fields(
                input,
                ["skillId", "expectedRevision", "markdown", "resources"],
                ["skillId", "expectedRevision", "markdown"],
              );
              identifier(args.skillId);
              expectedRevision(args.expectedRevision);
              return options.store.update(
                args as unknown as SkillDocumentInput & {
                  skillId: string;
                  expectedRevision: number;
                },
              );
            }
          }
        },
      );
    },
  };
}
