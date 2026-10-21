export function fail(message: string): never {
  throw new Error(`Configuration: ${message}`);
}
export const object = (value: object, keys: string[], label: string) => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object.`);
  for (const key of Object.keys(value))
    if (!keys.includes(key)) fail(`Unknown ${label} setting "${key}".`);
};
export const text = (
  value: string | null,
  label: string,
  { nullable = false, max = 32000 }: { nullable?: boolean; max?: number } = {},
): string | null => {
  if (nullable && value === null) return value;
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    value.includes("\0")
  )
    fail(`${label} must be a non-empty string${nullable ? " or null" : ""}.`);
  return value;
};
