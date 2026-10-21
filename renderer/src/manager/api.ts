import type { ApiPath, ApiResult } from "../contracts/manager.js";
import { decodeApi } from "../contracts/decode.js";
export class ApiError extends Error {
  constructor(
    message: string,
    readonly account?: { auth?: string; plan?: string },
  ) {
    super(message);
  }
}
// Same-origin backend contract. No credentials or model calls in the renderer.
export async function api<P extends ApiPath>(
  path: P,
  body: unknown = {},
  { method = "POST" }: { method?: "POST" | "GET" | "PUT" } = {},
): Promise<ApiResult<P>> {
  const response = await fetch(`/api/${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    if (
      result &&
      typeof result === "object" &&
      "error" in result &&
      typeof result.error === "string"
    )
      message = result.error;
    const account =
      result &&
      typeof result === "object" &&
      "account" in result &&
      result.account &&
      typeof result.account === "object"
        ? result.account
        : undefined;
    throw new ApiError(
      message,
      account
        ? {
            auth:
              "auth" in account && typeof account.auth === "string"
                ? account.auth
                : undefined,
            plan:
              "plan" in account && typeof account.plan === "string"
                ? account.plan
                : undefined,
          }
        : undefined,
    );
  }
  return decodeApi(path, result);
}
export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
export const errorName = (error: unknown): string =>
  error instanceof Error ? error.name : "";
export function endVoiceBeacon() {
  try {
    navigator.sendBeacon?.(
      "/api/disconnect",
      new Blob(["{}"], { type: "application/json" }),
    );
  } catch {
    /* Closing the event stream also stops backend voice. */
  }
}
