import type { JsonObject, JsonValue } from "./contracts.mjs";
import { object } from "./codex-peer.mjs";

const commandMethod = "item/commandExecution/requestApproval";
const fileMethod = "item/fileChange/requestApproval";
const questionMethod = "item/tool/requestUserInput";
const withheld = "[Withheld: sensitive, unsupported or oversized review data]";

/** Display boundary, not a generic secret scanner. Unknown structures never cross it. */
export function projectCodexApproval(
  method: string,
  params: JsonObject,
): JsonObject {
  if (![commandMethod, fileMethod, questionMethod].includes(method)) {
    return {
      method: [
        "item/permissions/requestApproval",
        "mcpServer/elicitation/request",
      ].includes(method)
        ? method
        : "unsupported_native_request",
      supported: false,
      scopeComplete: false,
      message:
        "This native interaction is unavailable in Crew. Its private parameters were withheld; no response was sent automatically.",
      choices: [],
    };
  }
  let complete = true;
  const display: JsonObject = {};
  const text = (
    value: JsonValue | undefined,
    limit: number,
    required = false,
  ): string | null => {
    if (value === undefined || value === null) {
      if (required) complete = false;
      return null;
    }
    if (
      typeof value !== "string" ||
      value.length > limit ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) ||
      /(?:https?:\/\/|-----BEGIN [^-]*PRIVATE KEY|\b(?:bearer|authorization|password|passwd|secret|cookie|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret)\b|\b[A-Z][A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|KEY)\s*=|\b(?:sk-|gh[opsu]_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{8,})/i.test(
        value,
      )
    ) {
      complete = false;
      return withheld;
    }
    if (required && !value.trim()) complete = false;
    return value;
  };
  if (method === commandMethod) {
    display.command = text(params.command, 8192, true);
    display.cwd = text(params.cwd, 2048, true);
    display.reason = text(params.reason, 2048);
    display.kind =
      params.kind === "command" || params.kind === undefined
        ? "command"
        : "unsupported";
    // These carry additional scope that this minimal review cannot faithfully render.
    if (
      display.kind !== "command" ||
      params.additionalPermissions != null ||
      params.networkApprovalContext != null
    )
      complete = false;
  } else if (method === fileMethod) {
    display.reason = text(params.reason, 2048);
    display.grantRoot = text(params.grantRoot, 2048);
    // This request contains no reviewed patch. Tool projections deliberately omit raw diffs.
    complete = false;
  } else {
    display.isBlocking = params.isBlocking === true;
    const questions: JsonObject[] = [];
    if (!Array.isArray(params.questions) || params.questions.length > 8)
      complete = false;
    else
      for (const value of params.questions) {
        if (!object(value) || value.isSecret === true) {
          complete = false;
          continue;
        }
        const question: JsonObject = {
          id: text(value.id, 160, true),
          header: text(value.header, 200),
          question: text(value.question, 2048, true),
          isOther: value.isOther === true,
        };
        if (value.options === null || value.options === undefined)
          question.options = null;
        else if (Array.isArray(value.options) && value.options.length <= 12) {
          const choices: JsonObject[] = [];
          for (const option of value.options) {
            if (!object(option)) {
              complete = false;
              continue;
            }
            choices.push({
              label: text(option.label, 200, true),
              description: text(option.description, 1024),
            });
          }
          question.options = choices;
        } else {
          complete = false;
          question.options = null;
        }
        questions.push(question);
      }
    display.questions = questions;
  }
  return {
    method,
    supported: true,
    params: display,
    scopeComplete: complete,
    ...(complete
      ? {}
      : {
          message:
            "The full action or question cannot be safely reviewed here. Approval and answers are unavailable; native denial or cancellation remain available when supported.",
        }),
    choices: simpleChoices(method, params, complete),
  };
}

function simpleChoices(
  method: string,
  params: JsonObject,
  complete: boolean,
): JsonObject[] {
  if (![commandMethod, fileMethod].includes(method)) return [];
  const declared = Array.isArray(params.availableDecisions)
    ? params.availableDecisions
    : ["accept", "acceptForSession", "decline", "cancel"];
  const labels: Record<string, string> = {
    accept: "Approve once",
    acceptForSession: "Approve for native session",
    decline: "Deny",
    cancel: "Cancel request",
  };
  return declared
    .filter(
      (decision): decision is string =>
        typeof decision === "string" &&
        Object.hasOwn(labels, decision) &&
        (complete || decision === "decline" || decision === "cancel"),
    )
    .map((decision) => ({ label: labels[decision], response: { decision } }));
}

export function codexApprovalChoices(
  method: string,
  params: JsonObject,
): JsonObject[] {
  const projected = projectCodexApproval(method, params);
  return Array.isArray(projected.choices)
    ? projected.choices.filter((choice): choice is JsonObject => object(choice))
    : [];
}
