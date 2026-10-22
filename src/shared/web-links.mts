/** Untrusted message links are data. Only explicit, bounded web URLs may leave Crew. */
export function webLink(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > 8192 ||
    /[\u0000-\u0020\u007f]/.test(value)
  )
    return null;
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) &&
      url.hostname &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
