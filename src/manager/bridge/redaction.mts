import { errorMessage } from "../../shared/errors.mjs";
/** Bounded diagnostic rendering never exposes bearer or API-key-shaped values. */
export const safeError = (error: unknown) =>
  errorMessage(error)
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/sk-[\w-]+/g, "[redacted]")
    .slice(0, 1500);
