import type { IncomingMessage } from "node:http";
/** Decode UTF-8 across chunk boundaries and preserve per-editor request bounds. */
export async function readRequestBody(
  request: IncomingMessage,
): Promise<{ tooLarge: true } | { tooLarge: false; value: unknown }> {
  request.setEncoding("utf8");
  const limit =
    request.url === "/api/settings/worker-environment"
      ? 16000000
      : request.url === "/api/settings/manager-profile"
        ? 750000
        : request.url === "/api/settings/prompts"
          ? 400000
          : 70000;
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > limit) return { tooLarge: true };
  }
  const value: unknown = JSON.parse(body || "{}");
  return { tooLarge: false, value };
}
