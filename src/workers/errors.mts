/** Read Node error metadata without trusting arbitrary thrown values. */
export function errorCode(error: unknown): string | number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error))
    return undefined;
  return typeof error.code === "string" || typeof error.code === "number"
    ? error.code
    : undefined;
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
