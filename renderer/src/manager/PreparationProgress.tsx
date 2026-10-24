import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "../components/ui/collapsible.js";
import type {
  PreparationParticipant,
  UpdatePlan,
} from "../contracts/manager.js";

export function preparationPurpose(plan: UpdatePlan): "update" | "quit" {
  return plan.purpose || plan.preparation?.purpose || "update";
}

/** Only explicit participant evidence describes acknowledgement; workflow/native turn status never does. */
export function participantAcknowledgement(
  participant: PreparationParticipant,
  canceled = false,
): string {
  if (!participant.required) return "No active agent preparation needed";
  if (canceled) {
    if (!participant.response)
      return participant.delivery.state === "pending"
        ? "Canceled before preparation delivery"
        : "Canceled; no readiness reply recorded";
    const previous = {
      preparing: "Preparing",
      ready: "Ready",
      "needs-input": "Needs input",
      blocked: "Blocked",
    }[participant.response.state];
    return `Last agent reply: ${previous}`;
  }
  if (participant.response) {
    return {
      preparing: "Agent preparing",
      ready: "Agent ready",
      "needs-input": "Needs your input",
      blocked: "Agent blocked",
    }[participant.response.state];
  }
  return {
    pending: "Preparation request waiting for delivery",
    attempted: "Waiting for agent acknowledgement",
    acknowledged: "Request received; no readiness reply yet",
    failed: "Preparation request failed",
    uncertain: "Request delivery unconfirmed",
  }[participant.delivery.state];
}

export function participantLabel(
  participant: PreparationParticipant,
  participants: PreparationParticipant[],
): string {
  const role = participant.role === "manager" ? "Manager" : "Worker";
  if (participant.role !== "worker") return role;
  const task = participant.taskLabel || participant.taskId;
  if (!task) return role;
  const duplicate =
    participant.taskLabel &&
    participants.some(
      (other) =>
        other.id !== participant.id &&
        other.role === "worker" &&
        other.projectId === participant.projectId &&
        other.taskLabel === participant.taskLabel,
    );
  return `${role} · ${task}${duplicate && participant.taskId ? ` · ${participant.taskId}` : ""}`;
}

export function preparationPhase(plan: UpdatePlan): string {
  const quit = preparationPurpose(plan) === "quit";
  const phases: Record<string, string> = {
    draining:
      "Waiting for agent preparation and confirmed execution settlement.",
    ready: quit
      ? "Final preparation checks passed. Preparing to quit…"
      : "Final preparation checks passed. Preparing to restart…",
    marking: quit
      ? "Confirming every project before quitting…"
      : "Confirming every project before installation…",
    installing: quit ? "Quitting Crew…" : "Restarting to install the update…",
    resuming: "Restoring work paused for this request…",
    blocked: quit
      ? "Quitting needs your review."
      : "The update needs your review.",
    canceled: quit
      ? "Quit canceled. Paused work is retained."
      : "Update canceled. Paused work is retained.",
    complete: "Preparation coordination finished.",
  };
  return phases[plan.phase] || "Preparation state needs review.";
}

export function PreparationProgress({ plan }: { plan: UpdatePlan }) {
  const participants = plan.preparation?.participants;
  const canceled =
    plan.phase === "canceled" || plan.preparation?.phase === "canceled";
  return (
    <section
      aria-label="Agent preparation progress"
      className="space-y-3 break-words text-xs leading-relaxed text-muted-foreground"
    >
      <p>
        New work is held across all projects. Workers keep their sessions,
        worktrees and changes.
      </p>
      <p>
        {canceled
          ? "This preparation request is canceled. Delivery and replies below are retained evidence; no new preparation request will be sent."
          : "Agents confirm when they are ready. Crew also waits for their final messages and running work to finish."}
      </p>
      {participants && participants.length > 0 ? (
        <ul className="space-y-3" aria-label="Preparation participants">
          {participants.map((participant) => {
            const needsInput =
              participant.response?.state === "needs-input" ||
              participant.response?.state === "blocked";
            return (
              <li
                key={`${participant.projectId || ""}:${participant.id}`}
                className="space-y-2 rounded-lg border p-3"
              >
                <p className="font-medium text-foreground">
                  {participant.projectName && <>{participant.projectName} · </>}
                  {participantLabel(participant, participants)}
                </p>
                <p
                  className={
                    needsInput ? "font-medium text-foreground" : undefined
                  }
                >
                  {participantAcknowledgement(participant, canceled)}
                </p>
                {participant.required && (
                  <p>
                    {participant.settled === true
                      ? "Execution settled."
                      : !canceled && participant.response?.state === "ready"
                        ? "Waiting for final messages and execution to settle."
                        : "Execution settlement has not been confirmed."}
                  </p>
                )}
                {participant.delivery.error && (
                  <p>{participant.delivery.error}</p>
                )}
                {participant.settlementReason && (
                  <p>{participant.settlementReason}</p>
                )}
                {participant.response?.note && (
                  <p className="whitespace-pre-wrap">
                    {participant.response.note}
                  </p>
                )}
                {needsInput && (
                  <p>
                    Review the{" "}
                    {participant.projectName
                      ? `${participant.projectName} project’s`
                      : "project’s"}{" "}
                    existing manager conversation to resolve native approvals.
                    This panel does not answer them.{" "}
                    {canceled
                      ? "For new directions or other decisions, choose Return to work."
                      : "For new directions or other decisions, cancel this request, then choose Return to work."}{" "}
                    Prepared workers stay paused; Resume paused work is a
                    separate explicit action.
                  </p>
                )}
                <Collapsible className="text-[11px]">
                  <CollapsibleTrigger className="text-left cursor-pointer">
                    Request details
                    {participant.taskId ? ` · ${participant.taskId}` : ""}
                  </CollapsibleTrigger>
                  <CollapsibleContent keepMounted>
                    <dl className="mt-2 space-y-1 break-all">
                      <div>
                        <dt className="inline">Request: </dt>
                        <dd className="inline">{participant.requestId}</dd>
                      </div>
                      {participant.runId && (
                        <div>
                          <dt className="inline">Run: </dt>
                          <dd className="inline">{participant.runId}</dd>
                        </div>
                      )}
                      {participant.threadId && (
                        <div>
                          <dt className="inline">Conversation: </dt>
                          <dd className="inline">{participant.threadId}</dd>
                        </div>
                      )}
                      <div>
                        <dt className="inline">Delivery: </dt>
                        <dd className="inline">{participant.delivery.state}</dd>
                      </div>
                      {participant.message && (
                        <div>
                          <dt>Preparation request</dt>
                          <dd className="whitespace-pre-wrap break-words">
                            {participant.message}
                          </dd>
                        </div>
                      )}
                      {participant.response?.continuation && (
                        <div>
                          <dt>Continuation context</dt>
                          <dd className="whitespace-pre-wrap break-words">
                            {participant.response.continuation}
                          </dd>
                        </div>
                      )}
                      {participant.response && (
                        <div>
                          <dt className="inline">Response: </dt>
                          <dd className="inline">
                            {participant.response.responseId} ·{" "}
                            <time dateTime={participant.response.at}>
                              {new Date(
                                participant.response.at,
                              ).toLocaleString()}
                            </time>
                          </dd>
                        </div>
                      )}
                    </dl>
                  </CollapsibleContent>
                </Collapsible>
              </li>
            );
          })}
        </ul>
      ) : (
        <p>No agent preparation acknowledgements have been received.</p>
      )}
      {plan.projects?.map((project) => (
        <p key={project.id}>
          <span className="font-medium text-foreground">{project.name}</span>:{" "}
          {project.phase || "waiting"}
        </p>
      ))}
      {plan.targets?.map((target) => (
        <p key={`${target.projectId || ""}:${target.taskId}`}>
          <span className="font-medium text-foreground">
            {target.projectName ? `${target.projectName} · ` : ""}
            {target.taskId}
          </span>
          : {String(target.progress || "waiting").replaceAll("-", " ")}
        </p>
      ))}
      {plan.reasons?.map((reason) => (
        <p key={reason}>{reason}</p>
      ))}
      {plan.manager?.interrupted && (
        <p>
          The manager was interrupted, not completed. Continue in the
          conversation after returning to work. Voice will remain disconnected.
        </p>
      )}
    </section>
  );
}
