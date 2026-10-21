import type { IncomingMessage, ServerResponse } from "node:http";
/** One renderer owns the project SSE stream; disconnect retains native work. */
export async function openProjectEvents({
  request,
  response,
  clients,
  work,
  initial,
  disconnected,
}: {
  request: IncomingMessage;
  response: ServerResponse;
  clients: Set<ServerResponse>;
  work: unknown;
  initial: (() => Promise<unknown> | unknown)[];
  disconnected: () => void;
}) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    Connection: "keep-alive",
  });
  response.write(`data: ${JSON.stringify(work)}\n\n`);
  clients.add(response);
  for (const read of initial)
    response.write(`data: ${JSON.stringify(await read())}\n\n`);
  response.on("error", () => {
    clients.delete(response);
    disconnected();
  });
  const timer = setInterval(() => response.write(": heartbeat\n\n"), 15000);
  request.on("close", () => {
    clearInterval(timer);
    clients.delete(response);
    disconnected();
  });
}
