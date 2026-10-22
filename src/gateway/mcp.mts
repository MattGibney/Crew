import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { BrokerResult, CallerContext } from "../agents/contracts.mjs";
import type { DurableOperationBroker } from "./broker.mjs";
import { jsonObject, normalizeArguments } from "./json.mjs";

const controls = new Map([
  [
    "crew_resume_operation",
    "Resume the exact retained operation after approval or proven non-execution. Never repeats an uncertain or accepted operation.",
  ],
  [
    "crew_reconcile_operation",
    "Read-only verification of a retained operation; never dispatches the operation again.",
  ],
  [
    "crew_cancel_operation",
    "Cancel pending execution; an accepted operation may remain uncertain until verified.",
  ],
]);
const controlSchema = {
  type: "object" as const,
  properties: {
    invocationId: { type: "string", minLength: 1, maxLength: 160 },
  },
  required: ["invocationId"],
  additionalProperties: false,
};

function response(result: BrokerResult, invocationId: string): CallToolResult {
  const metadata = {
    "crew/invocationId": invocationId,
    "crew/state": result.state,
    ...("receiptId" in result ? { "crew/receiptId": result.receiptId } : {}),
    ...(result.state === "approval_required"
      ? { "crew/accessRequestId": result.accessRequestId }
      : {}),
  };
  if (result.state === "succeeded") {
    const data = result.content.length === 1 ? result.content[0] : null;
    if (
      data?.type === "data" &&
      data.value &&
      typeof data.value === "object" &&
      !Array.isArray(data.value) &&
      "crewMcpResult" in data.value
    ) {
      const upstream = CallToolResultSchema.safeParse(data.value.crewMcpResult);
      if (upstream.success)
        return {
          ...upstream.data,
          _meta: { ...upstream.data._meta, ...metadata },
        };
    }
    return {
      _meta: metadata,
      content: result.content.map((item) => ({
        type: "text" as const,
        text: item.type === "text" ? item.text : JSON.stringify(item),
      })),
    };
  }
  return {
    _meta: metadata,
    isError: true,
    content: [
      {
        type: "text",
        text:
          result.state === "approval_required"
            ? `Approval required for invocation ${invocationId}. After owner review, use crew_resume_operation with this invocationId.`
            : result.reason,
      },
    ],
  };
}

/** #88/#89 attach an authenticated, session-bound transport. No caller or credential
 * parameter is accepted from MCP JSON. Revalidate the binding on every request.
 * This creates no listener, model turn, session or personal Codex configuration. */
export function createGatewayMcpServer(options: {
  broker: DurableOperationBroker;
  authenticatedCaller(): Promise<CallerContext | null>;
  /** Durable host/native request identity, stable across delivery retry/reconnect.
   * Never reuse it for a different operation in the same authenticated session. */
  invocationIdForRequest(requestId: string | number): Promise<string>;
}): Server {
  const server = new Server(
    { name: "crew-service-gateway", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const caller = await options.authenticatedCaller();
    if (!caller) throw new Error("Authenticated Crew session required.");
    const capabilities = await options.broker.listCapabilities(caller);
    const tools: Tool[] = capabilities.map((item) => ({
      name: item.id,
      description: item.description,
      inputSchema: { ...item.inputSchema, type: "object" },
      ...(item.outputSchema
        ? { outputSchema: { ...item.outputSchema, type: "object" as const } }
        : {}),
      _meta: {
        "crew/connectionId": item.connectionId,
        "crew/upstreamName": item.upstreamName,
      },
    }));
    for (const [name, description] of controls)
      tools.push({ name, description, inputSchema: controlSchema });
    return { tools };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const caller = await options.authenticatedCaller();
    if (!caller) throw new Error("Authenticated Crew session required.");
    let invocationId = await options.invocationIdForRequest(extra.requestId);
    try {
      if (controls.has(request.params.name)) {
        const args = normalizeArguments(
          controlSchema,
          request.params.arguments ?? {},
        ).arguments;
        invocationId = String(args.invocationId);
        const result =
          request.params.name === "crew_resume_operation"
            ? await options.broker.resumePending(caller, invocationId, {
                signal: extra.signal,
              })
            : request.params.name === "crew_cancel_operation"
              ? await options.broker.cancel(caller, invocationId)
              : await options.broker.reconcile(caller, invocationId);
        return response(result, invocationId);
      }
      // Transport clients may retain this metadata across uncertain result delivery.
      const supplied = request.params._meta?.["crew/invocationId"];
      if (supplied !== undefined) {
        if (typeof supplied !== "string" || !supplied || supplied.length > 160)
          throw new Error("Invalid invocation ID.");
        invocationId = supplied;
      }
      const result = await options.broker.invokeTool(
        caller,
        invocationId,
        request.params.name,
        jsonObject(request.params.arguments ?? {}),
        {
          signal: extra.signal,
          onProgress: () => {
            const progressToken = request.params._meta?.progressToken;
            if (progressToken !== undefined)
              void extra
                .sendNotification({
                  method: "notifications/progress",
                  params: {
                    progressToken,
                    progress: 0,
                    message: "Upstream operation in progress",
                  },
                })
                .catch(() => {});
          },
        },
      );
      return response(result, invocationId);
    } catch {
      // A lost local response is NOT proof of non-execution. Never expose thrown provider data.
      return {
        isError: true,
        _meta: {
          "crew/invocationId": invocationId,
          "crew/state": "unavailable",
        },
        content: [
          {
            type: "text",
            text: "Gateway request could not be completed. Retain this invocation ID and reconcile it before attempting the operation again.",
          },
        ],
      };
    }
  });
  return server;
}
