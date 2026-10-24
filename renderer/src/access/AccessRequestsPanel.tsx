import { ChevronDown as DisclosureChevronDown } from "lucide-react";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { useId, useState } from "react";
import type {
  AccessRequest,
  Agent,
  GrantDuration,
  GrantScope,
  ServiceCapability,
  ServiceConnectionView,
} from "../../../src/agents/contracts.mjs";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { AccessDecision, OwnerPanelProps } from "./types";
import {
  AccessSection,
  ErrorMessage,
  OwnerRequired,
  ScopeSummary,
  ServiceIdentity,
  useAccessAction,
} from "./shared";

export interface AccessRequestsPanelProps extends OwnerPanelProps {
  requests: readonly AccessRequest[];
  agents: readonly Agent[];
  connections: readonly ServiceConnectionView[];
  capabilities: readonly ServiceCapability[];
  onDecide: (
    requestId: AccessRequest["id"],
    decision: AccessDecision,
  ) => Promise<void>;
}

export function AccessRequestsPanel(props: AccessRequestsPanelProps) {
  if (!props.isOwner) return <OwnerRequired />;
  const pending = props.requests.filter(
    (request) => request.state === "pending",
  );
  return (
    <AccessSection
      title="Access requests"
      description="Review the caller, service identity and exact operation. Choose the permission scope and how long it lasts independently."
    >
      {!pending.length && (
        <p className="border-y py-5 text-sm text-muted-foreground">
          No pending access requests.
        </p>
      )}
      <div className="divide-y">
        {pending.map((request) => (
          <RequestReview key={request.id} {...props} request={request} />
        ))}
      </div>
    </AccessSection>
  );
}

function RequestReview({
  request,
  ...props
}: AccessRequestsPanelProps & { request: AccessRequest }) {
  const id = useId();
  const [durationType, setDurationType] =
    useState<GrantDuration["type"]>("once");
  const [scopeChoice, setScopeChoice] = useState<"exact" | "requested">(
    "exact",
  );
  const [reason, setReason] = useState("");
  const action = useAccessAction(props.onNotify);
  const agent = props.agents.find((item) => item.id === request.caller.agentId);
  const connection = props.connections.find(
    (item) => item.id === request.operation.connectionId,
  );
  const exactScope: GrantScope = {
    type: "exact_operation",
    connectionId: request.operation.connectionId,
    operation: request.operation.operation,
    argumentsFingerprint: request.operation.argumentsFingerprint,
  };
  const requestedCapabilities =
    request.requestedScope.type === "capability"
      ? request.requestedScope.capabilities
      : [];
  const requestedAvailable =
    request.requestedScope.type === "capability" &&
    request.requestedScope.connectionId === request.operation.connectionId &&
    requestedCapabilities.length > 0 &&
    requestedCapabilities.includes(request.operation.operation) &&
    requestedCapabilities.every((capability) =>
      props.capabilities.some(
        (item) =>
          item.id === capability &&
          item.connectionId === request.operation.connectionId,
      ),
    );
  const finalScope =
    scopeChoice === "requested" && durationType !== "once" && requestedAvailable
      ? request.requestedScope
      : exactScope;
  const session = agent?.runtime.session;
  const problem = !agent
    ? "The caller's current session is unavailable. Refresh before approving."
    : agent.projectId !== request.caller.projectId ||
        connection?.projectId !== request.caller.projectId
      ? "The caller and service must belong to this project."
      : !connection
        ? "This service connection is unavailable."
        : session?.sessionId !== request.caller.sessionId ||
            session.observedState !== "started" ||
            session.desiredState !== "started"
          ? "This request is no longer attached to a verified started session. Refresh before approving."
          : !agent.access.serviceConnectionIds.includes(connection.id)
            ? "Assign this connection to the agent before approving. Approval does not add a connection assignment."
            : !props.capabilities.some(
                  (item) =>
                    item.id === request.operation.operation &&
                    item.connectionId === connection.id,
                )
              ? "This operation is unavailable in the current discovered catalogue. Refresh before approving."
              : "";
  const duration: GrantDuration =
    durationType === "once"
      ? { type: "once", logicalInvocationId: request.operation.invocationId }
      : durationType === "session"
        ? { type: "session", sessionId: request.caller.sessionId }
        : { type: "persistent" };
  return (
    <article className="space-y-5 py-6" aria-labelledby={`${id}-heading`}>
      <div className="space-y-2">
        <h3 id={`${id}-heading`} className="text-sm font-semibold">
          {agent?.profile.name ?? request.caller.agentId} requests access
        </h3>
        <div className="text-sm">
          <ServiceIdentity connection={connection} />
        </div>
        <p className="text-xs text-muted-foreground">
          Requested {new Date(request.createdAt).toLocaleString()}
          {request.jobId ? ` · Job ${request.jobId}` : ""}
        </p>
      </div>
      <dl className="space-y-3 text-sm">
        <div>
          <dt className="font-medium">Operation</dt>
          <dd className="mt-1 break-all font-mono">
            {request.operation.operation}
          </dd>
        </div>
        <div>
          <dt className="font-medium">Why access is needed</dt>
          <dd className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">
            {request.justification || "No justification supplied."}
          </dd>
        </div>
        <div>
          <dt className="font-medium">Exact arguments</dt>
          <dd>
            <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-muted p-3 text-xs leading-5">
              {JSON.stringify(request.operation.arguments, null, 2)}
            </pre>
          </dd>
        </div>
      </dl>
      <Collapsible className="space-y-3">
        <CollapsibleTrigger
          type="button"
          className="group flex w-full items-center gap-2 text-left cursor-pointer text-sm font-medium"
        >
          <DisclosureChevronDown
            className="size-4 shrink-0 transition-transform group-aria-expanded:rotate-180"
            aria-hidden="true"
          />
          Requested future scope
        </CollapsibleTrigger>
        <CollapsibleContent keepMounted>
          <div className="mt-3 border-t pt-4">
            <p className="mb-2 break-all text-xs text-muted-foreground">
              Connection:{" "}
              {props.connections.find(
                (item) => item.id === request.requestedScope.connectionId,
              )?.name ?? request.requestedScope.connectionId}
            </p>
            <ScopeSummary scope={request.requestedScope} />
          </div>
        </CollapsibleContent>
      </Collapsible>
      <Collapsible className="text-xs text-muted-foreground">
        <CollapsibleTrigger
          type="button"
          className="group flex w-full items-center gap-2 text-left cursor-pointer"
        >
          <DisclosureChevronDown
            className="size-4 shrink-0 transition-transform group-aria-expanded:rotate-180"
            aria-hidden="true"
          />
          Request identity
        </CollapsibleTrigger>
        <CollapsibleContent keepMounted>
          <dl className="mt-2 space-y-1 break-all">
            <div>
              <dt className="inline font-medium">Agent: </dt>
              <dd className="inline">{request.caller.agentId}</dd>
            </div>
            <div>
              <dt className="inline font-medium">Session: </dt>
              <dd className="inline">{request.caller.sessionId}</dd>
            </div>
            <div>
              <dt className="inline font-medium">Invocation: </dt>
              <dd className="inline">{request.operation.invocationId}</dd>
            </div>
            <div>
              <dt className="inline font-medium">Request: </dt>
              <dd className="inline">{request.id}</dd>
            </div>
          </dl>
        </CollapsibleContent>
      </Collapsible>
      <form
        className="space-y-4"
        onSubmit={async (event) => {
          event.preventDefault();
          if (problem) return;
          await action.run(
            () =>
              props.onDecide(request.id, {
                state: "approved",
                duration,
                scope: finalScope,
              }),
            "Access request approved.",
            "Could not approve this request. Refresh its session, connection and permissions before trying again.",
          );
        }}
      >
        <fieldset disabled={action.busy} className="space-y-4 border-t pt-4">
          <legend className="mb-2 text-sm font-semibold">Your approval</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={`${id}-duration`}>Duration</Label>
              <Select
                value={durationType}
                onValueChange={(selectedValue) => {
                  const value = selectedValue ?? "";
                  const next =
                    value === "session" || value === "persistent"
                      ? value
                      : "once";
                  setDurationType(next);
                  if (next === "once") setScopeChoice("exact");
                }}
                items={[
                  { value: "once", label: "Once, for this invocation" },
                  { value: "session", label: "Until this session stops" },
                  { value: "persistent", label: "Until revoked" },
                ]}
              >
                <SelectTrigger id={`${id}-duration`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="once">
                    Once, for this invocation
                  </SelectItem>
                  <SelectItem value="session">
                    Until this session stops
                  </SelectItem>
                  <SelectItem value="persistent">Until revoked</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${id}-scope`}>Final scope</Label>
              <Select
                value={finalScope.type === "capability" ? "requested" : "exact"}
                onValueChange={(selectedValue) =>
                  setScopeChoice(
                    (selectedValue ?? "") === "requested"
                      ? "requested"
                      : "exact",
                  )
                }
                items={[
                  {
                    value: "exact",
                    label: "This exact operation and arguments",
                  },
                  ...(requestedAvailable
                    ? [
                        {
                          value: "requested",
                          label: "Requested capabilities and restrictions",
                        },
                      ]
                    : []),
                ]}
              >
                <SelectTrigger id={`${id}-scope`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="exact">
                    This exact operation and arguments
                  </SelectItem>
                  {requestedAvailable && (
                    <SelectItem
                      value="requested"
                      disabled={durationType === "once"}
                    >
                      Requested capabilities and restrictions
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="border-t pt-4">
            <ScopeSummary scope={finalScope} exactArgumentsShown />
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              {durationType === "once"
                ? "This request may run once. A retry is allowed only when the earlier attempt is confirmed not to have run."
                : durationType === "session"
                  ? "The grant expires when this session stops or restarts. Reconnecting cannot restore an expired grant."
                  : "The grant survives session restarts until it is revoked. Every later call still needs an assigned connection and a live session."}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${id}-reason`}>Reason for rejection</Label>
            <Textarea
              id={`${id}-reason`}
              maxLength={2000}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Required only when rejecting this request"
            />
          </div>
        </fieldset>
        {problem && <p className="text-sm text-muted-foreground">{problem}</p>}
        <ErrorMessage>{action.error}</ErrorMessage>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={action.busy || !reason.trim()}
            onClick={() =>
              void action.run(
                () =>
                  props.onDecide(request.id, {
                    state: "rejected",
                    reason: reason.trim(),
                  }),
                "Access request rejected.",
                "Could not reject this request. Refresh its current state and try again.",
              )
            }
          >
            Reject
          </Button>
          <Button type="submit" disabled={action.busy || !!problem}>
            {action.busy ? "Saving decision…" : "Approve selected scope"}
          </Button>
        </div>
      </form>
    </article>
  );
}
