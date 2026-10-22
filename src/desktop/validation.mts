/** Narrow native IPC and private persisted values before trusting their fields. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function record(
  value: unknown,
  label = "Desktop value",
): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}
export function string(value: unknown, label: string): string {
  if (typeof value !== "string")
    throw new TypeError(`${label} must be a string.`);
  return value;
}
export function errorCode(value: unknown): string | undefined {
  if (
    value &&
    typeof value === "object" &&
    "code" in value &&
    typeof value.code === "string"
  )
    return value.code;
  return undefined;
}
export function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
export function isString(value: unknown): value is string {
  return typeof value === "string";
}
export function parseJSON(value: string): unknown {
  return JSON.parse(value);
}
