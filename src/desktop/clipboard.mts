// Write-only, bounded text. Never expose native clipboard reads to renderer content.
export function clipboardText(value: unknown): string {
  if (typeof value !== "string" || value.length > 1000000)
    throw new TypeError(
      "Clipboard text must be a string of at most 1,000,000 characters.",
    );
  return value;
}
