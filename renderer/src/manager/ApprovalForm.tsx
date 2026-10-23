import { Checkbox } from "@/components/ui/checkbox";
import type {
  Approval,
  WorkItem,
  RequestId,
  Decision,
} from "../contracts/manager.js";
import { errorText } from "./api.js";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { connectorVerificationURL } from "./state.js";

export function ApprovalForm({
  request,
  workItems,
  onAnswer,
}: {
  request: Approval;
  workItems: WorkItem[];
  onAnswer: (id: RequestId, response: unknown) => Promise<void>;
}) {
  const fieldPrefix = useId();
  const [answers, setAnswers] = useState<Record<string, string>>({}),
    [others, setOthers] = useState<Record<string, string>>({}),
    [sending, setSending] = useState(false),
    [error, setError] = useState("");
  const params = request.params || {};
  const [content, setContent] = useState("{}"),
    [permissions, setPermissions] = useState(() =>
      JSON.stringify(params.permissions || {}, null, 2),
    ),
    [scope, setScope] = useState("turn"),
    [strictAutoReview, setStrictAutoReview] = useState(false);
  const submit = async (response: unknown) => {
    if (sending) return;
    setSending(true);
    setError("");
    try {
      await onAnswer(request.id, response);
    } catch (failure) {
      setError(
        errorText(failure) || "Could not submit this response. Try again.",
      );
    } finally {
      setSending(false);
    }
  };
  const choice = (label: string, response: unknown) => (
    <Button
      key={label}
      type="button"
      variant="outline"
      disabled={sending}
      onClick={() => void submit(response)}
    >
      {label}
    </Button>
  );
  const jsonSubmit = (value: string, build: (value: unknown) => unknown) => {
    try {
      void submit(build(JSON.parse(value)));
    } catch {
      setError("Enter valid JSON before submitting.");
    }
  };
  const userInput = request.method === "item/tool/requestUserInput";
  const elicitation = request.method === "mcpServer/elicitation/request";
  const emptyApproval =
    params.mode === "form" &&
    params._meta?.codex_approval_kind === "mcp_tool_call" &&
    Object.keys(params.requestedSchema?.properties || {}).length === 0;
  const verificationURL =
    params.mode === "url" ? connectorVerificationURL(params.url) : null;
  const changes = workItems.find((item) => item.id === params.itemId)?.changes;
  const preview = params.command
    ? `${params.command}\nWorking directory: ${params.cwd || ""}${params.additionalPermissions ? `\nAdditional permissions: ${JSON.stringify(params.additionalPermissions, null, 2)}` : ""}${params.networkApprovalContext ? `\nNetwork access: ${JSON.stringify(params.networkApprovalContext, null, 2)}` : ""}`
    : JSON.stringify(
        changes ||
          params.permissions ||
          params.networkApprovalContext ||
          params,
        null,
        2,
      );
  const defaultDecisions: Decision[] = [
    "accept",
    "acceptForSession",
    "decline",
    "cancel",
  ];
  if (params.proposedExecpolicyAmendment)
    defaultDecisions.push({
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: params.proposedExecpolicyAmendment,
      },
    });
  for (const amendment of params.proposedNetworkPolicyAmendments || [])
    defaultDecisions.push({
      applyNetworkPolicyAmendment: { network_policy_amendment: amendment },
    });
  const decisions = params.availableDecisions || defaultDecisions;
  return (
    <form
      className="approval space-y-3 rounded-lg border border-border bg-muted/30 p-4"
      data-id={request.id}
      onSubmit={(event) => {
        event.preventDefault();
        if (userInput)
          void submit({
            answers: Object.fromEntries(
              (params.questions || []).map((question) => [
                question.id,
                others[question.id] || answers[question.id] || "",
              ]),
            ),
          });
      }}
    >
      <strong>Codex needs your input</strong>
      <p className="text-sm text-muted-foreground">
        {params.reason ||
          params.message ||
          "Review this request before proceeding."}
      </p>
      {userInput ? (
        <>
          {(params.questions || []).map((question) => {
            const id = `${fieldPrefix}-${question.id}`;
            return (
              <div key={question.id} className="space-y-2">
                <Label htmlFor={id}>{question.question}</Label>
                {question.options?.length ? (
                  <NativeSelect
                    id={id}
                    className="w-full"
                    required={!question.isOther}
                    value={answers[question.id] || ""}
                    onChange={(event) =>
                      setAnswers((previous) => ({
                        ...previous,
                        [question.id]: event.target.value,
                      }))
                    }
                  >
                    <option value="">Choose an answer</option>
                    {question.options.map((option) => (
                      <option key={option.label} value={option.label}>
                        {option.label}
                        {option.description ? ` — ${option.description}` : ""}
                      </option>
                    ))}
                  </NativeSelect>
                ) : (
                  <Input
                    id={id}
                    type={question.isSecret ? "password" : "text"}
                    required={!question.isOther}
                    value={answers[question.id] || ""}
                    onChange={(event) =>
                      setAnswers((previous) => ({
                        ...previous,
                        [question.id]: event.target.value,
                      }))
                    }
                  />
                )}
                {question.isOther && (
                  <>
                    <Label
                      htmlFor={`${id}-other`}
                      className="text-muted-foreground"
                    >
                      Or enter another answer
                    </Label>
                    <Input
                      id={`${id}-other`}
                      type={question.isSecret ? "password" : "text"}
                      value={others[question.id] || ""}
                      onChange={(event) =>
                        setOthers((previous) => ({
                          ...previous,
                          [question.id]: event.target.value,
                        }))
                      }
                    />
                  </>
                )}
              </div>
            );
          })}
          <Button type="submit" disabled={sending}>
            Send answer
          </Button>
        </>
      ) : elicitation ? (
        <>
          {emptyApproval ? (
            <>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">
                {JSON.stringify(params._meta?.tool_params, null, 2)}
              </pre>
              <div className="flex flex-wrap gap-2">
                {choice("Allow once", { action: "accept" })}
                {choice("Decline", { action: "decline" })}
              </div>
            </>
          ) : verificationURL ? (
            <>
              <a
                className="block underline underline-offset-4"
                href={verificationURL}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open connector verification
              </a>
              {choice("I completed verification", { action: "accept" })}
            </>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                {params.mode === "openai/userVerification"
                  ? "Complete the requested device verification and provide its proof below."
                  : "Complete the connector’s requested form as JSON. Your response is checked against the supplied schema."}
              </p>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">
                {JSON.stringify(
                  params.requestedSchema || {
                    title: params.title,
                    description: params.description,
                    challenge: params.challenge,
                  },
                  null,
                  2,
                )}
              </pre>
              <Label htmlFor={`${fieldPrefix}-content`}>
                Connector response JSON
              </Label>
              <Textarea
                id={`${fieldPrefix}-content`}
                value={content}
                onChange={(event) => setContent(event.target.value)}
                className="font-mono text-xs"
                maxLength={16000}
              />
              <Button
                type="button"
                variant="outline"
                disabled={sending}
                onClick={() =>
                  jsonSubmit(content, (value) => ({
                    action: "accept",
                    content: value,
                  }))
                }
              >
                Submit connector response
              </Button>
            </div>
          )}
          <div>
            {choice("Decline connector request", { action: "decline" })}
          </div>
          <div>{choice("Cancel connector request", { action: "cancel" })}</div>
        </>
      ) : request.method === "item/permissions/requestApproval" ? (
        <>
          <p className="text-sm text-muted-foreground">
            Review the requested permissions. You can remove entries before
            allowing them.
          </p>
          <Label htmlFor={`${fieldPrefix}-permissions`}>
            Permissions to grant (JSON)
          </Label>
          <Textarea
            id={`${fieldPrefix}-permissions`}
            value={permissions}
            onChange={(event) => setPermissions(event.target.value)}
            className="font-mono text-xs"
            maxLength={16000}
          />
          <Label htmlFor={`${fieldPrefix}-scope`}>Permission duration</Label>
          <NativeSelect
            id={`${fieldPrefix}-scope`}
            value={scope}
            onChange={(event) => setScope(event.target.value)}
          >
            <option value="turn">This turn</option>
            <option value="session">This session</option>
          </NativeSelect>
          <Label className="flex items-center gap-2">
            <Checkbox
              checked={strictAutoReview}
              onCheckedChange={(checked) => setStrictAutoReview(checked)}
            />
            Review every subsequent command in this turn
          </Label>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={sending}
              onClick={() =>
                jsonSubmit(permissions, (value) => ({
                  decision: "accept",
                  permissions: value,
                  scope,
                  strictAutoReview,
                }))
              }
            >
              Allow selected permissions
            </Button>
            {choice("Decline", { decision: "decline" })}
          </div>
        </>
      ) : (
        <>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">
            {preview}
          </pre>
          <div className="flex flex-wrap gap-2">
            {decisions.map((decision, index) =>
              typeof decision === "string" ? (
                choice(
                  (
                    {
                      accept: "Allow once",
                      acceptForSession: "Allow for this session",
                      decline: "Decline",
                      cancel: "Cancel turn",
                    } as Record<string, string>
                  )[decision] || decision,
                  { decision },
                )
              ) : (
                <div
                  key={index}
                  className="w-full space-y-2 rounded-md border p-2"
                >
                  <pre className="overflow-auto whitespace-pre-wrap break-words text-xs">
                    {JSON.stringify(decision, null, 2)}
                  </pre>
                  {choice(
                    decision.acceptWithExecpolicyAmendment
                      ? "Allow and save command rule"
                      : "Apply network policy rule",
                    { decision },
                  )}
                </div>
              ),
            )}
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
