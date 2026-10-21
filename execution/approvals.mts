import { Ajv } from "ajv";
export interface ApprovalIdentity {
  taskId: string;
  runId: string;
  threadId: string;
  turnId: string | null;
  requestId: string | number;
}
export interface ApprovalQuestion {
  id: string;
  options?: { label: string }[];
  isOther?: boolean;
}
export interface ApprovalParams extends Record<string, unknown> {
  threadId: string;
  turnId?: string | null;
  questions?: ApprovalQuestion[];
  mode?: string;
  _meta?: Record<string, unknown>;
  requestedSchema?: Record<string, unknown> & {
    properties?: Record<string, unknown>;
    required?: unknown;
  };
  permissions?: unknown;
  proposedExecpolicyAmendment?: unknown;
  proposedNetworkPolicyAmendments?: unknown[];
  availableDecisions?: unknown[];
}
export interface ApprovalRecord extends ApprovalIdentity {
  approvalId: string;
  method: string;
  params: ApprovalParams;
  status: string;
  createdAt: string;
  response?: ApprovalResponse;
  decidedAt?: string;
  deliveredAt?: string;
  resolvedAt?: string;
  resolvedWithoutDecision?: boolean;
  staleAt?: string;
  deliveryUnknownAt?: string;
  deliveryFailure?: { code: string; message: string };
  reason?: string;
}
export interface ApprovalResponse extends Record<string, unknown> {
  answers?: Record<string, string | { answers: string[] }>;
  action?: string;
  decision?: unknown;
  permissions?: unknown;
  scope?: string;
  strictAutoReview?: boolean;
  content?: unknown;
  _meta?: unknown;
}
const recordShape = new Ajv({ strict: false }).compile<ApprovalRecord>({
  type: "object",
  required: [
    "approvalId",
    "taskId",
    "runId",
    "threadId",
    "turnId",
    "requestId",
    "method",
    "params",
    "status",
    "createdAt",
  ],
  properties: {
    approvalId: { type: "string" },
    taskId: { type: "string" },
    runId: { type: "string" },
    threadId: { type: "string" },
    turnId: { type: ["string", "null"] },
    requestId: { type: ["string", "number"] },
    method: { type: "string" },
    params: {
      type: "object",
      required: ["threadId"],
      properties: {
        threadId: { type: "string" },
        turnId: { type: ["string", "null"] },
        questions: {
          type: "array",
          items: {
            type: "object",
            required: ["id"],
            properties: {
              id: { type: "string" },
              options: {
                type: "array",
                items: {
                  type: "object",
                  required: ["label"],
                  properties: { label: { type: "string" } },
                },
              },
              isOther: { type: "boolean" },
            },
          },
        },
        mode: { type: "string" },
        _meta: { type: "object" },
        requestedSchema: { type: "object" },
        proposedNetworkPolicyAmendments: { type: "array" },
        availableDecisions: { type: "array" },
      },
    },
    status: { type: "string" },
    createdAt: { type: "string" },
    response: { type: "object" },
  },
});
export function parseApprovalRecord(input: unknown): ApprovalRecord {
  if (!recordShape(input))
    throw new Error("Malformed worker request; refusing to replace it");
  return input;
}
