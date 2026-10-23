// GH-56 experiment: a browser-level CDP facade over exactly one unprivileged
// WebContents. Never enable Electron's application-wide remote-debugging port.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { WebContents } from "electron";

const pageDomains = new Set([
  "Page",
  "Runtime",
  "DOM",
  "DOMSnapshot",
  "Accessibility",
  "Input",
  "Network",
  "Emulation",
  "Log",
  "Performance",
  "Profiler",
  "CSS",
  "Overlay",
  "Audits",
  "Fetch",
  "Security",
  "Debugger",
]);

export async function createBrowserCdp(
  contents: WebContents,
  changed: (connected: boolean) => void,
) {
  const targetId = randomUUID(),
    sessionId = randomUUID();
  const route = `/devtools/browser/${randomUUID()}`;
  let client: WebSocket | undefined;
  let attached = false,
    discovered = false;
  const sessions = new Set<string>();
  const info = () => ({
    targetId,
    type: "page",
    title: contents.getTitle(),
    url: contents.getURL(),
    attached,
    canAccessOpener: false,
    browserContextId: "crew-preview",
  });
  const send = (value: unknown) => {
    if (client?.readyState === WebSocket.OPEN)
      client.send(JSON.stringify(value));
  };
  const targetChanged = () => {
    if (discovered)
      send({
        method: "Target.targetInfoChanged",
        params: { targetInfo: info() },
      });
  };
  const message = (
    _event: Electron.Event,
    method: string,
    params: unknown,
    nested?: string,
  ) => {
    // No target/session created outside this view is ever forwarded.
    if (!nested && pageDomains.has(method.split(".")[0] || ""))
      for (const sessionId of sessions) send({ method, params, sessionId });
  };
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    perMessageDeflate: false,
  });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== route || req.headers.origin || client) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) =>
      sockets.emit("connection", ws, req),
    );
  });
  sockets.on("connection", (ws) => {
    client = ws;
    discovered = attached = false;
    sessions.clear();
    let ownsDebugger = false;
    const detached = () => ws.close(1011, "Preview debugger disconnected");
    ws.on("error", () => {});
    ws.on("close", () => {
      if (client !== ws) return;
      client = undefined;
      attached = discovered = false;
      sessions.clear();
      contents.debugger.removeListener("message", message);
      contents.debugger.removeListener("detach", detached);
      if (
        ownsDebugger &&
        !contents.isDestroyed() &&
        contents.debugger.isAttached()
      )
        contents.debugger.detach();
      changed(false);
    });
    try {
      contents.debugger.attach("1.3");
    } catch {
      ws.close(1011, "Preview debugger unavailable");
      return;
    }
    ownsDebugger = true;
    changed(true);
    contents.debugger.on("message", message);
    contents.debugger.on("detach", detached);
    ws.on("message", async (bytes) => {
      let request: {
        id: number;
        method: string;
        params?: Record<string, unknown>;
        sessionId?: string;
      };
      try {
        const value: unknown = JSON.parse(bytes.toString());
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw Error("Invalid message");
        request = value as typeof request;
        if (
          request.params !== undefined &&
          (!request.params ||
            typeof request.params !== "object" ||
            Array.isArray(request.params))
        )
          throw Error("Invalid params");
      } catch {
        ws.close(1008);
        return;
      }
      const { id, method, params = {}, sessionId: requestedSession } = request;
      const reply = (result: unknown) => {
        if (client === ws)
          send({
            id,
            result,
            ...(requestedSession ? { sessionId: requestedSession } : {}),
          });
      };
      try {
        if (process.env.CREW_BROWSER_CDP_TRACE === "1")
          console.log("preview-cdp", method, requestedSession || "browser");
        if (!Number.isSafeInteger(id) || typeof method !== "string")
          throw Error("Invalid CDP message");
        if (requestedSession && !sessions.has(requestedSession))
          throw Error("Unknown preview session");
        if (method === "Browser.getVersion" && !requestedSession)
          return reply(await contents.debugger.sendCommand(method));
        if (method === "Target.getBrowserContexts" && !requestedSession)
          return reply({ browserContextIds: ["crew-preview"] });
        if (method === "Target.getTargets" && !requestedSession)
          return reply({ targetInfos: [info()] });
        if (method === "Target.setDiscoverTargets" && !requestedSession) {
          discovered = params.discover === true;
          if (discovered)
            send({
              method: "Target.targetCreated",
              params: { targetInfo: info() },
            });
          reply({});
          return;
        }
        if (method === "Target.setAutoAttach") {
          if (!requestedSession && params.autoAttach === true && !attached) {
            attached = true;
            sessions.add(sessionId);
            send({
              method: "Target.attachedToTarget",
              params: {
                sessionId,
                targetInfo: info(),
                waitingForDebugger: false,
              },
            });
          }
          reply({});
          return;
        }
        if (
          method === "Target.attachToTarget" &&
          !requestedSession &&
          params.targetId === targetId
        ) {
          attached = true;
          const extra = randomUUID();
          sessions.add(extra);
          send({
            method: "Target.attachedToTarget",
            params: {
              sessionId: extra,
              targetInfo: info(),
              waitingForDebugger: false,
            },
          });
          return reply({ sessionId: extra });
        }
        if (
          method === "Target.getTargetInfo" &&
          (!params.targetId || params.targetId === targetId)
        )
          return reply({ targetInfo: info() });
        if (
          method === "Target.activateTarget" &&
          params.targetId === targetId
        ) {
          contents.focus();
          return reply({});
        }
        if (
          method === "Target.detachFromTarget" &&
          typeof params.sessionId === "string" &&
          sessions.has(params.sessionId)
        ) {
          sessions.delete(params.sessionId);
          return reply({});
        }
        if (!requestedSession || !pageDomains.has(method.split(".")[0] || ""))
          throw Error("Command outside the preview target is unavailable");
        reply(await contents.debugger.sendCommand(method, params));
      } catch (error) {
        if (process.env.CREW_BROWSER_CDP_TRACE === "1")
          console.log("preview-cdp-error", method, String(error));
        if (client === ws)
          send({
            id,
            error: {
              code: -32000,
              message: error instanceof Error ? error.message : String(error),
            },
            ...(requestedSession ? { sessionId: requestedSession } : {}),
          });
      }
    });
  });
  contents.on("did-navigate", targetChanged);
  contents.on("did-navigate-in-page", targetChanged);
  contents.on("page-title-updated", targetChanged);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Preview endpoint unavailable");
  return {
    endpoint: `ws://127.0.0.1:${address.port}${route}`,
    async close() {
      client?.terminate();
      contents.removeListener("did-navigate", targetChanged);
      contents.removeListener("did-navigate-in-page", targetChanged);
      contents.removeListener("page-title-updated", targetChanged);
      await new Promise<void>((resolve) =>
        sockets.close(() => server.close(() => resolve())),
      );
    },
  };
}
