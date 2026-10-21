export const abort = (signal?: AbortSignal) => {
  if (signal?.aborted)
    throw new DOMException("Project discovery cancelled.", "AbortError");
};
export function redact(value: string) {
  return value
    .replace(
      /(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g,
      "[REDACTED]",
    )
    .replace(
      /^.*(?:api[_-]?key|secret|password|access[_-]?token|authorization|client[_-]?token)\s*[=:].*$/gim,
      "[REDACTED sensitive assignment]",
    )
    .replace(
      /https?:\/\/[^\s/@]+:[^\s/@]+@[^\s]+/g,
      "[REDACTED credential URL]",
    )
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      "[REDACTED private key]",
    );
}
