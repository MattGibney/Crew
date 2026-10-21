import { Ajv } from "ajv";
import { record } from "../../shared/errors.mjs";
import type { NativeItem, MessageRole } from "../conversation/contracts.mjs";
import type { ApprovalParams } from "../../workers/approvals.mjs";
export type NativeId = string | number;
export interface NativeTurn {
  id: string;
  status: string;
  items?: NativeItem[];
  error?: unknown;
}
export interface NativeThread {
  id: string;
  status?: { type: string };
}
export type TimelineEntry =
  | { type: "item"; position: number; item: NativeItem; turnId: string }
  | { type: "realtime"; position: number; item: NativeItem }
  | { type: "turnStarted"; position: number; turnId: string }
  | { type: "turnCompleted"; position: number; turnId: string; status: string };
export interface RpcResults {
  initialize: Record<string, unknown>;
  "account/read": { account: { type: string; planType?: string } | null };
  "config/read": { config?: { developer_instructions?: string | null } };
  "thread/start": { thread: NativeThread };
  "thread/resume": { thread: NativeThread };
  "thread/fork": { thread: NativeThread };
  "thread/read": { thread: NativeThread };
  "thread/turns/list": { data: NativeTurn[] };
  "thread/timeline/list": { data: TimelineEntry[]; nextCursor?: string | null };
  "thread/name/set": Record<string, unknown>;
  "mcpServerStatus/list": {
    data: {
      name: string;
      runtimeStatus?: string;
      authStatus?: string;
      tools?: Record<string, unknown>;
    }[];
  };
  "thread/realtime/listVoices": { voices: { v3: string[]; defaultV1: string } };
  "thread/realtime/start": Record<string, unknown>;
  "thread/realtime/stop": Record<string, unknown>;
  "turn/start": { turn?: Pick<NativeTurn, "id"> & Partial<NativeTurn> };
  "turn/steer": { turnId: string };
  "turn/interrupt": Record<string, unknown>;
}
export type RpcMethod = keyof RpcResults;
export type Rpc = <M extends RpcMethod>(
  method: M,
  params?: Record<string, unknown>,
) => Promise<RpcResults[M]>;
export interface WireEnvelope {
  id?: NativeId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number | string; message?: string };
}
const ajv = new Ajv({ allErrors: true, strict: false });
const str = { type: "string" },
  num = { type: "number" };
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: true,
});
const arr = (items: unknown) => ({ type: "array", items });
const itemSchema = obj(
  {
    id: str,
    type: str,
    role: { enum: ["user", "assistant"] },
    text: str,
    itemId: str,
    content: arr(obj({ type: str, text: str }, ["type"])),
    command: str,
    status: str,
    exitCode: { type: ["number", "null"] },
    aggregatedOutput: str,
    server: str,
    tool: str,
  },
  ["id", "type"],
);
const threadSchema = obj({ id: str, status: obj({ type: str }, ["type"]) }, [
  "id",
]);
const turnSchema = obj({ id: str, status: str, items: arr(itemSchema) }, [
  "id",
  "status",
]);
const timelineSchema = {
  oneOf: [
    obj(
      { type: { const: "item" }, position: num, item: itemSchema, turnId: str },
      ["type", "position", "item", "turnId"],
    ),
    obj({ type: { const: "realtime" }, position: num, item: itemSchema }, [
      "type",
      "position",
      "item",
    ]),
    obj({ type: { const: "turnStarted" }, position: num, turnId: str }, [
      "type",
      "position",
      "turnId",
    ]),
    obj(
      {
        type: { const: "turnCompleted" },
        position: num,
        turnId: str,
        status: str,
      },
      ["type", "position", "turnId", "status"],
    ),
  ],
};
const resultSchemas: Record<RpcMethod, object> = {
  initialize: obj({}),
  "account/read": obj(
    {
      account: {
        anyOf: [obj({ type: str, planType: str }, ["type"]), { type: "null" }],
      },
    },
    ["account"],
  ),
  "config/read": obj({
    config: obj({ developer_instructions: { type: ["string", "null"] } }),
  }),
  "thread/start": obj({ thread: threadSchema }, ["thread"]),
  "thread/resume": obj({ thread: threadSchema }, ["thread"]),
  "thread/fork": obj({ thread: threadSchema }, ["thread"]),
  "thread/read": obj({ thread: threadSchema }, ["thread"]),
  "thread/turns/list": obj({ data: arr(turnSchema) }, ["data"]),
  "thread/timeline/list": obj(
    { data: arr(timelineSchema), nextCursor: { type: ["string", "null"] } },
    ["data"],
  ),
  "thread/name/set": obj({}),
  "mcpServerStatus/list": obj(
    {
      data: arr(
        obj(
          { name: str, runtimeStatus: str, authStatus: str, tools: obj({}) },
          ["name"],
        ),
      ),
    },
    ["data"],
  ),
  "thread/realtime/listVoices": obj(
    { voices: obj({ v3: arr(str), defaultV1: str }, ["v3", "defaultV1"]) },
    ["voices"],
  ),
  "thread/realtime/start": obj({}),
  "thread/realtime/stop": obj({}),
  "turn/start": obj({
    turn: obj({ id: str, status: str, items: arr(itemSchema) }, ["id"]),
  }),
  "turn/steer": obj({ turnId: str }, ["turnId"]),
  "turn/interrupt": obj({}),
};
export function decodeRpc<M extends RpcMethod>(
  method: M,
  input: unknown,
): RpcResults[M] {
  const validate = ajv.compile<RpcResults[M]>(resultSchemas[method]);
  if (!validate(input))
    throw new Error(
      `Invalid native ${method} response: ${ajv.errorsText(validate.errors)}`,
    );
  return input;
}
const envelopeShape = ajv.compile<WireEnvelope>(
  obj({
    id: { type: ["string", "number"] },
    method: str,
    params: obj({}),
    error: obj({ code: { type: ["string", "number"] }, message: str }),
  }),
);
export function decodeEnvelope(input: unknown): WireEnvelope {
  if (!envelopeShape(input))
    throw new Error("Invalid native protocol envelope.");
  return input;
}
export function rpcErrorCode(error: unknown): string | number | undefined {
  if (!record(error)) return undefined;
  return typeof error.code === "string" || typeof error.code === "number"
    ? error.code
    : undefined;
}
const approvalShape = ajv.compile<ApprovalParams>(
  obj(
    {
      threadId: str,
      turnId: { type: ["string", "null"] },
      itemId: str,
      questions: arr(
        obj(
          {
            id: str,
            options: arr(obj({ label: str }, ["label"])),
            isOther: { type: "boolean" },
          },
          ["id"],
        ),
      ),
      mode: str,
      _meta: obj({}),
      requestedSchema: obj({}),
      proposedNetworkPolicyAmendments: arr({}),
      availableDecisions: arr({}),
    },
    ["threadId"],
  ),
);
export function decodeApprovalParams(input: unknown): ApprovalParams {
  if (!approvalShape(input))
    throw new Error("Invalid native approval parameters.");
  return input;
}
interface NotificationParams {
  "thread/started": { thread: NativeThread };
  "thread/realtime/sdp": { threadId: string; sdp: string };
  "thread/realtime/started": { threadId: string };
  "thread/realtime/error": { threadId: string; message: string };
  "thread/realtime/closed": { threadId: string; reason?: string };
  "thread/realtime/transcript/delta": {
    threadId: string;
    role: MessageRole;
    delta: string;
  };
  "thread/realtime/transcript/done": {
    threadId: string;
    role: MessageRole;
    text: string;
  };
  "thread/realtime/item/started": { threadId: string; item: NativeItem };
  "thread/realtime/item/completed": { threadId: string; item: NativeItem };
  "thread/realtime/item/transcript/delta": {
    threadId: string;
    itemId: string;
    delta: string;
  };
  "item/agentMessage/delta": {
    threadId: string;
    itemId: string;
    delta: string;
  };
  "turn/started": {
    threadId: string;
    turn: Pick<NativeTurn, "id"> & Partial<NativeTurn>;
  };
  "turn/completed": { threadId: string; turn: NativeTurn };
  "item/started": { threadId: string; turnId: string; item: NativeItem };
  "item/completed": { threadId: string; turnId: string; item: NativeItem };
  "serverRequest/resolved": { threadId: string; requestId: NativeId };
  error: { threadId: string; error?: { message?: string } };
}
export type NativeNotification = {
  [M in keyof NotificationParams]: { method: M; params: NotificationParams[M] };
}[keyof NotificationParams];
const notificationSchemas: Record<keyof NotificationParams, object> = {
  "thread/started": obj({ thread: threadSchema }, ["thread"]),
  "thread/realtime/sdp": obj({ threadId: str, sdp: str }, ["threadId", "sdp"]),
  "thread/realtime/started": obj({ threadId: str }, ["threadId"]),
  "thread/realtime/error": obj({ threadId: str, message: str }, [
    "threadId",
    "message",
  ]),
  "thread/realtime/closed": obj({ threadId: str, reason: str }, ["threadId"]),
  "thread/realtime/transcript/delta": obj(
    { threadId: str, role: { enum: ["user", "assistant"] }, delta: str },
    ["threadId", "role", "delta"],
  ),
  "thread/realtime/transcript/done": obj(
    { threadId: str, role: { enum: ["user", "assistant"] }, text: str },
    ["threadId", "role", "text"],
  ),
  "thread/realtime/item/started": obj({ threadId: str, item: itemSchema }, [
    "threadId",
    "item",
  ]),
  "thread/realtime/item/completed": obj({ threadId: str, item: itemSchema }, [
    "threadId",
    "item",
  ]),
  "thread/realtime/item/transcript/delta": obj(
    { threadId: str, itemId: str, delta: str },
    ["threadId", "itemId", "delta"],
  ),
  "item/agentMessage/delta": obj({ threadId: str, itemId: str, delta: str }, [
    "threadId",
    "itemId",
    "delta",
  ]),
  "turn/started": obj(
    {
      threadId: str,
      turn: obj({ id: str, status: str, items: arr(itemSchema) }, ["id"]),
    },
    ["threadId", "turn"],
  ),
  "turn/completed": obj({ threadId: str, turn: turnSchema }, [
    "threadId",
    "turn",
  ]),
  "item/started": obj({ threadId: str, turnId: str, item: itemSchema }, [
    "threadId",
    "turnId",
    "item",
  ]),
  "item/completed": obj({ threadId: str, turnId: str, item: itemSchema }, [
    "threadId",
    "turnId",
    "item",
  ]),
  "serverRequest/resolved": obj(
    { threadId: str, requestId: { type: ["number", "string"] } },
    ["threadId", "requestId"],
  ),
  error: obj({ threadId: str, error: obj({ message: str }) }, ["threadId"]),
};
const notificationShape = ajv.compile<NativeNotification>({
  oneOf: Object.entries(notificationSchemas).map(([method, params]) =>
    obj({ method: { const: method }, params }, ["method", "params"]),
  ),
});
export function decodeNotification(
  input: WireEnvelope,
): NativeNotification | null {
  if (!Object.hasOwn(notificationSchemas, input.method || "")) return null;
  if (!notificationShape(input))
    throw new Error(
      `Invalid native notification: ${ajv.errorsText(notificationShape.errors)}`,
    );
  return input;
}
