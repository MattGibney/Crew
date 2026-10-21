import { Ajv } from "ajv";
import type { TaskRecord } from "./contracts.mjs";
const ajv = new Ajv({ strict: false, allErrors: false });
const string = { type: "string" };
const nullableString = { type: ["string", "null"] };
const objectWith = (
  required: string[],
  properties: Record<string, unknown>,
) => ({ type: "object", required, properties });
const history = objectWith(["id", "actor", "kind", "message"], {
  id: string,
  actor: { enum: ["manager", "worker", "controller"] },
  kind: string,
  message: string,
  at: nullableString,
  runId: nullableString,
});
const request = objectWith(["id", "action", "status", "at"], {
  id: string,
  action: string,
  status: string,
  at: string,
  expectedRunId: nullableString,
});
const report = objectWith(["reportId", "runId", "kind", "message"], {
  reportId: string,
  runId: string,
  kind: string,
  message: string,
  evidence: { type: "array", items: string },
  at: string,
});
const validate = ajv.compile<TaskRecord>(
  objectWith(
    [
      "id",
      "ticket",
      "brief",
      "status",
      "revision",
      "createdAt",
      "updatedAt",
      "reports",
      "attention",
    ],
    {
      id: string,
      ticket: string,
      brief: string,
      status: string,
      revision: { type: "integer", minimum: 1 },
      createdAt: string,
      updatedAt: string,
      projectId: nullableString,
      repositoryId: nullableString,
      reports: { type: "array", items: report },
      attention: {
        type: "array",
        items: objectWith(["id"], {
          id: string,
          kind: string,
          message: string,
          at: string,
          ackedAt: string,
        }),
      },
      lifecycleRequests: { type: "array", items: request },
      history: { type: "array", items: history },
      workerPromptSnapshot: objectWith(["text", "version"], {
        text: string,
        version: string,
      }),
      answer: {
        anyOf: [
          { type: "null" },
          objectWith(["text"], {
            questionId: string,
            text: string,
            at: string,
          }),
        ],
      },
      question: {
        anyOf: [
          { type: "null" },
          objectWith(["id", "runId"], {
            id: string,
            message: string,
            runId: string,
          }),
        ],
      },
    },
  ),
);
/** Validate persisted shape before semantic checks or mutation. Unknown keys survive upgrades. */
export function parseTaskRecord(input: unknown, id: string): TaskRecord {
  if (!validate(input))
    throw new Error(`Malformed state for ${id}; refusing to replace it`);
  return {
    ...input,
    projectId: input.projectId ?? null,
    repositoryId: input.repositoryId ?? null,
    lifecycleRequests: input.lifecycleRequests || [],
    history: input.history || [],
    answer: input.answer || null,
  };
}
