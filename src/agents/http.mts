import { createServer, type ServerResponse } from "node:http";
import { open, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { createRendererAssets } from "../http/renderer-assets.mjs";
import { readRequestBody } from "../http/request-body.mjs";
import type { FoundationOwnerApi } from "./owner-api.mjs";

/** Fresh foundation host. Existing installed application startup is deliberately
 * untouched; #86 explicitly composes this with #89/#90 before cutover. */
export async function startFoundationHttp(options: {
  api: FoundationOwnerApi;
  rendererDirectory: string;
  port?: number;
}) {
  const root = await realpath(options.rendererDirectory);
  const path = join(root, "agents.html");
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 256_000)
    throw new Error(
      "Build the unified agent renderer before starting the host.",
    );
  const assets = await createRendererAssets(root);
  const streams = new Set<ServerResponse>();
  let origin = "";
  const server = createServer(async (request, response) => {
    const send = (status: number, value: unknown) => {
      if (response.headersSent) return response.end();
      response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(value));
    };
    response.setHeader(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    if (
      request.headers.host !== new URL(origin).host ||
      (request.headers.origin && request.headers.origin !== origin) ||
      request.headers["sec-fetch-site"] === "cross-site"
    )
      return send(403, { error: "Same-origin access required." });
    try {
      if (request.method === "GET" && request.url === "/api/agents")
        return send(200, await options.api.snapshot());
      if (request.method === "GET" && request.url === "/api/agents/events") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        response.write('data: {"kind":"changed"}\n\n');
        streams.add(response);
        request.on("close", () => streams.delete(response));
        return;
      }
      if (request.method === "POST" && request.url === "/api/agents/command") {
        if (
          request.headers.origin !== origin ||
          request.headers["content-type"] !== "application/json"
        )
          return send(403, { error: "Same-origin JSON requests required." });
        const body = await readRequestBody(request);
        if (body.tooLarge)
          return send(413, { error: "Command exceeds the request limit." });
        if (
          !body.value ||
          typeof body.value !== "object" ||
          Array.isArray(body.value)
        )
          return send(400, { error: "Invalid command." });
        const value = body.value as Record<string, unknown>;
        if (
          typeof value.command !== "string" ||
          Object.keys(value).some((key) => !["command", "args"].includes(key))
        )
          return send(400, { error: "Invalid command envelope." });
        return send(200, {
          result: await options.api.command(value.command, value.args),
        });
      }
      if (
        request.method === "GET" &&
        (request.url === "/" || request.url === "/agents.html")
      ) {
        const file = await open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const current = await file.stat();
          if (
            current.dev !== entry.dev ||
            current.ino !== entry.ino ||
            !current.isFile() ||
            current.size > 256_000
          )
            throw new Error("Renderer changed; restart the source host.");
          response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          });
          response.end(await file.readFile());
          return;
        } finally {
          await file.close();
        }
      }
      if (request.method === "GET" && request.url?.startsWith("/assets/")) {
        const asset = await assets.read(request.url);
        if (asset) {
          response.writeHead(200, { "content-type": asset.type });
          response.end(asset.body);
          return;
        }
      }
      return send(404, { error: "Not found." });
    } catch {
      // Provider/runtime diagnostic strings may contain credential material. Domain
      // results carry already-sanitized errors; unexpected exceptions do not.
      return send(400, {
        error:
          "The command could not be completed. Refresh current state and check session or reference details.",
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Loopback host did not start.");
  origin = `http://127.0.0.1:${address.port}`;
  const unsubscribe = options.api.subscribe((event) => {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const stream of streams) {
      if (stream.writableLength > 1_000_000) {
        stream.destroy();
        streams.delete(stream);
      } else stream.write(data);
    }
  });
  return {
    origin,
    async close() {
      unsubscribe();
      for (const stream of streams) stream.end();
      streams.clear();
      await new Promise<void>((resolve, reject) =>
        server.close((failure) => (failure ? reject(failure) : resolve())),
      );
    },
  };
}
