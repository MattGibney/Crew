import type { PreparationRequest } from "./contracts.mjs";
/** Identity and protocol accompany the user's explicit restart/shutdown request. */
export function preparationMessage(request: PreparationRequest): string {
  return [
    `Crew preparation request: ${request.purpose === "update" ? "the user chose Prepare and update" : "the user chose Quit Crew"}.`,
    request.participant.message,
    "Choose a sensible stopping point using ordinary native tools and existing project instructions. Preserve useful factual context for continuation; a commit or clean working tree is not required. Do not include secrets or private reasoning.",
    "Read local_orchestration.get_preparation_request and report through local_orchestration.report_preparation with these exact identities:",
    JSON.stringify({
      preparationId: request.preparationId,
      participantId: request.participantId,
      requestId: request.requestId,
    }),
    "Use a stable responseId for retries, state preparing, ready, needs-input or blocked, a useful note and optional factual continuation. You may revise the response with a new responseId while preparation remains open. A workflow label or ordinary result is not a preparation acknowledgement.",
    "Report ready after preserving context and safely settling native work; record any independent environment you intentionally retain. After reporting ready, finish your final response and end this turn normally. Crew keeps receiving events and waits for native execution to settle; it will not automatically answer approvals or interrupt this preparation turn.",
  ].join("\n\n");
}
