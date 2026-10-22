import { isIP } from "node:net";

/** Address policy, not a service/domain allowlist. IPv4 loopback is all of 127/8. */
export function isLoopbackAddress(value: string): boolean {
  const address = value.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(address) === 4) return address.split(".")[0] === "127";
  return address === "::1" || address === "0:0:0:0:0:0:0:1";
}

/** Owner-selected hostname is retained verbatim by the URL/network stack.
 * A syntactically accepted hostname is NOT yet permission to dispatch traffic. */
export function parseLocalPreviewURL(value: string, hostOrigin?: string): URL {
  if (value.length > 8192) throw Error("The preview URL is too long.");
  const url = new URL(value);
  const host = hostOrigin ? new URL(hostOrigin) : undefined;
  const name = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "http:" ||
    !name ||
    url.username ||
    url.password ||
    url.origin === hostOrigin ||
    (host && url.port === host.port) ||
    (isIP(name) !== 0 && !isLoopbackAddress(name))
  )
    throw Error(
      "Choose a local HTTP preview on a different port from Crew. Its hostname must resolve only to loopback.",
    );
  return url;
}

/** Use the preview session's Chromium resolver so local OS resolver rules match
 * the browser. Reject unavailable, empty or mixed local/remote address results. */
export async function requireLoopbackResolution(
  hostname: string,
  resolve: (name: string) => Promise<{ endpoints: { address: string }[] }>,
): Promise<void> {
  const name = hostname.replace(/^\[|\]$/g, "");
  if (isIP(name)) {
    if (!isLoopbackAddress(name))
      throw Error("Preview address is not loopback.");
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      resolve(name),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(Error("Local preview hostname lookup timed out.")),
          3000,
        );
      }),
    ]);
    if (
      !result.endpoints.length ||
      !result.endpoints.every((endpoint) => isLoopbackAddress(endpoint.address))
    )
      throw Error(
        "The selected preview hostname must resolve only to loopback addresses.",
      );
  } catch {
    throw Error(
      "The selected preview hostname is unavailable or does not resolve only to loopback. Check its local development DNS configuration.",
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** WebSocket is transport for the same explicit HTTP origin, never navigation
 * permission or an additional hostname/port/origin grant. */
export function isLocalPreviewRequest(
  value: string,
  previewOrigin: string,
  hostOrigin: string | undefined,
  resourceType: string,
): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "ws:" && resourceType === "webSocket")
      url.protocol = "http:";
    return parseLocalPreviewURL(url.href, hostOrigin).origin === previewOrigin;
  } catch {
    return false;
  }
}
