/** Inspect errors without treating thrown values as trusted Node errors. */
export function errorCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
export function errorMessage(error: unknown): string {
  return error !== null &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : String(error);
}
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function parseRecord(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!record(value)) throw new Error("Expected a JSON object.");
  return value;
}
