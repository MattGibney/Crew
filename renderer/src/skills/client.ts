import type { Skill } from "../../../src/agents/contracts.mjs";
import type {
  SkillDocument,
  SkillDocumentInput,
} from "../../../src/skills/types.mjs";

/** Owner-authenticated transport adapter. No caller/actor is accepted from UI. */
export interface ProjectSkillsClient {
  list(): Promise<Skill[]>;
  read(skillId: string): Promise<SkillDocument>;
  create(input: SkillDocumentInput): Promise<SkillDocument>;
  update(
    input: SkillDocumentInput & { skillId: string; expectedRevision: number },
  ): Promise<SkillDocument>;
  /** Use the application's existing event stream, not a second SSE connection. */
  subscribe?(listener: () => void): () => void;
}

export function skillErrorMessage(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error ? error.code : null;
  if (code === "conflict")
    return "The saved skill changed or that name is already in use. Your draft is retained. Review the current saved version before trying again.";
  if (code === "invalid")
    return "Check the SKILL.md name, description and instructions, resource paths, and file size limits. Your draft is retained.";
  if (code === "missing")
    return "The selected skill is unavailable in this project. Refresh the list; your draft is retained.";
  if (code === "busy")
    return "Another save is in progress or its lock needs owner recovery. Your draft is retained; retry when it is resolved.";
  if (code === "unsafe_store")
    return "Crew cannot safely read the project skill store. Its files need owner recovery; your draft is retained.";
  if (code === "denied")
    return "You do not have access to this project's skills. Your draft is retained.";
  return "The skill request did not complete. Refresh to check its saved state before retrying; your draft is retained.";
}
