import { createServer } from "node:http";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createRendererAssets } from "../http/renderer-assets.mjs";

/** Static presentation only. All owner state and commands cross the authenticated
 * main-frame IPC bridge; the loopback port exposes no project or credential API. */
export async function startDesktopRenderer(directory: string, port = 0) {
  const root = await realpath(directory);
  const entry = join(root, "agents.html");
  const identity = await lstat(entry);
  if (
    !identity.isFile() ||
    identity.isSymbolicLink() ||
    identity.size > 256_000
  )
    throw new Error("Build the Crew renderer before opening the application.");
  const assets = await createRendererAssets(root);
  let origin = "";
  const server = createServer(async (request, response) => {
    response.setHeader(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("cache-control", "no-store");
    if (
      request.method !== "GET" ||
      request.headers.host !== new URL(origin).host ||
      (request.headers.origin && request.headers.origin !== origin) ||
      request.headers["sec-fetch-site"] === "cross-site"
    ) {
      response.writeHead(403);
      response.end();
      return;
    }
    try {
      if (request.url === "/") {
        const file = await open(
          entry,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const current = await file.stat();
          if (
            !current.isFile() ||
            current.dev !== identity.dev ||
            current.ino !== identity.ino ||
            current.size > 256_000
          )
            throw new Error("Restart Crew after rebuilding its renderer.");
          response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
          });
          response.end(await file.readFile());
        } finally {
          await file.close();
        }
        return;
      }
      const asset = request.url?.startsWith("/assets/")
        ? await assets.read(request.url)
        : null;
      if (asset) {
        response.writeHead(200, { "content-type": asset.type });
        response.end(asset.body);
        return;
      }
      response.writeHead(404);
      response.end();
    } catch {
      if (!response.headersSent)
        response.writeHead(503, {
          "content-type": "text/plain; charset=utf-8",
        });
      response.end(
        "Crew presentation is unavailable. Rebuild and restart the application.",
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Crew loopback renderer did not start.");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    port: address.port,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
