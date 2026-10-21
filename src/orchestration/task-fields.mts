export const ID = /^[a-zA-Z0-9_-]{8,80}$/;
export function text(value: unknown, name: string, max = 12000) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    value.includes("\0")
  )
    throw new Error(`Invalid ${name}`);
  // A narrow safety net, not general secret detection. Never include matches in errors.
  if (
    /\bsk-[a-zA-Z0-9_-]{20,}\b|\bBearer\s+[a-zA-Z0-9._~+\/-]{12,}={0,2}|-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/i.test(
      value,
    )
  )
    throw new Error(`Secret-like material is not allowed in ${name}`);
  return value;
}
export function identifier(value: unknown, name = "task ID") {
  if (typeof value !== "string" || !ID.test(value))
    throw new Error(`Invalid ${name}`);
  return value;
}
