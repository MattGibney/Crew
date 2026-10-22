import type { PreparationActor } from "../preparation/contracts.mjs";
import {
  getPreparationRequest,
  claimPreparationDelivery,
  recordPreparationDelivery,
} from "../preparation/store.mjs";
import { preparationMessage } from "../preparation/message.mjs";
/** Durable at-most-once steering into the current worker turn; never creates a turn. */
export function createRunnerPreparation({
  stateDir,
  actor,
  snapshot,
  steer,
  onPreparing,
  prepareText = async (text) => text,
}: {
  stateDir: string;
  actor: PreparationActor;
  snapshot: () => {
    threadId: string | null;
    turnId: string | null;
    acknowledged: boolean;
    ending: boolean;
  };
  steer: (input: {
    threadId: string;
    expectedTurnId: string;
    requestId: string;
    text: string;
  }) => Promise<{ turnId?: string }>;
  onPreparing: () => void;
  prepareText?: (text: string) => Promise<string>;
}) {
  let observing = false;
  return async function observePreparation() {
    if (observing) return;
    observing = true;
    try {
      const request = await getPreparationRequest(stateDir, actor);
      if (!request || !request.participant.required) return;
      onPreparing();
      if (request.participant.delivery.state !== "pending") return;
      const identity = {
        preparationId: request.preparationId,
        participantId: request.participantId,
        requestId: request.requestId,
      };
      if (!(await claimPreparationDelivery(stateDir, identity))) return;
      const current = snapshot();
      if (
        !current.threadId ||
        !current.turnId ||
        !current.acknowledged ||
        current.ending ||
        (request.participant.threadId &&
          request.participant.threadId !== current.threadId)
      ) {
        await recordPreparationDelivery(stateDir, identity, {
          state: "failed",
          error:
            "Worker has no matching active acknowledged native turn for preparation; no replacement conversation was started.",
        });
        return;
      }
      let text: string;
      try {
        text = await prepareText(preparationMessage(request));
      } catch {
        await recordPreparationDelivery(stateDir, identity, {
          state: "failed",
          error:
            "Cannot read the current saved worker profile. No preparation was sent. Restore access to the saved Settings document or restore a valid copy, then explicitly retry preparation.",
        });
        return;
      }
      try {
        const result = await steer({
          threadId: current.threadId,
          expectedTurnId: current.turnId,
          requestId: request.requestId,
          text,
        });
        if (result.turnId !== current.turnId) {
          await recordPreparationDelivery(stateDir, identity, {
            state: "uncertain",
            error:
              "Native preparation acknowledgement did not match the captured worker turn; delivery will not be replayed.",
          });
          return;
        }
        await recordPreparationDelivery(stateDir, identity, {
          state: "acknowledged",
          nativeTurnId: current.turnId,
        });
      } catch {
        await recordPreparationDelivery(stateDir, identity, {
          state: "uncertain",
          error:
            "Native preparation delivery could not be confirmed; the attempted request will not be replayed.",
        });
      }
    } finally {
      observing = false;
    }
  };
}
