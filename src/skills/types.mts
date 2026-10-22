import type { Skill } from "../agents/contracts.mjs";

export interface SkillResource {
  /** Relative, POSIX path beneath scripts/, references/, assets/, or agents/. */
  path: string;
  content: string;
  executable?: boolean;
}
export interface SkillDocumentInput {
  markdown: string;
  /** A supplied array replaces the resource set. Omit on update to retain it. */
  resources?: SkillResource[];
}
export interface SkillDocument {
  skill: Skill;
  markdown: string;
  resources: SkillResource[];
}
