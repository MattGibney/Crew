import { createHash } from "node:crypto";
import type { PromptSnapshot } from "./contracts.mjs";
export const promptVersion = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export function validatePrompt(text: unknown): string {
  if (
    typeof text !== "string" ||
    !text.trim() ||
    text.length > 64000 ||
    text.includes("\0")
  )
    throw new Error(
      "Prompt must contain text, with at most 64,000 characters and no null bytes.",
    );
  if (
    /\bsk-[a-zA-Z0-9_-]{20,}\b|\bBearer\s+[a-zA-Z0-9._~+\/-]{12,}={0,2}|-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/i.test(
      text,
    )
  )
    throw new Error("Secret-like material is not allowed in prompts.");
  return text;
}
export const promptSnapshot = (value: unknown): PromptSnapshot => {
  const text = validatePrompt(value);
  return { text, version: promptVersion(text) };
};
