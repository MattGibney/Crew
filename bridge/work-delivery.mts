import type { Rpc } from './protocol.mjs';

export interface ReviewAdmission {
  background?: boolean;
  canReview?: () => boolean;
  beforeReview?: () => Promise<boolean>;
}
export type DeliveryResult = { accepted: false } | { turnId?: string; turn?: { id: string; status?: string } };
interface DeliveryState {
  activeTurnId: string | null;
  voiceActive: boolean;
  connecting: boolean;
  approvals: number;
  threadId?: string;
  instructions: string | null;
}
/** Serial transport delivery and cancellation, independent of timeline observation. */
export function createWorkDelivery({ state, ensureThread, rpc, publishPending, markStarted, completed }: {
  state: () => DeliveryState;
  ensureThread: () => Promise<string | undefined>;
  rpc: Rpc;
  publishPending: (pending: boolean) => void;
  markStarted: (id: string) => void;
  completed: (id: string) => boolean;
}) {
  let delivery: Promise<unknown> = Promise.resolve(), queued = 0, generation = 0;
  const requests = new Map<string, Promise<DeliveryResult>>();
  const cancel = () => { generation++; };
  async function start(text: string, requestId: string, { background = false, canReview = () => true, beforeReview = async () => true }: ReviewAdmission = {}): Promise<DeliveryResult> {
    const retained = requests.get(requestId);
    if (retained) return retained;
    const idle = () => { const current = state(); return !current.activeTurnId && !current.voiceActive && !current.connecting && !current.approvals && canReview(); };
    if (background && (queued || !idle())) return { accepted: false };
    const expectedGeneration = generation;
    const requireCurrent = () => { if (generation !== expectedGeneration) throw new Error('Manager work was stopped before this message was delivered. Your unsent message is kept; send it again when ready.'); };
    queued++; publishPending(true);
    const result = delivery.then(async (): Promise<DeliveryResult> => {
      try {
        requireCurrent();
        await ensureThread();
        requireCurrent();
        if (background && !await beforeReview()) return { accepted: false };
        if (background && !idle()) return { accepted: false };
        requireCurrent();
        const current = state();
        if (current.activeTurnId) {
          const expectedTurnId = current.activeTurnId;
          const directed = await rpc('turn/steer', { threadId: current.threadId, expectedTurnId, clientUserMessageId: requestId, input: [{ type: 'text', text }] });
          if (directed.turnId !== expectedTurnId) throw new Error('Native steering acknowledged another turn; direction delivery is unverified.');
          return directed;
        }
        const started = await rpc('turn/start', { threadId: current.threadId, clientUserMessageId: requestId, additionalContext: { crewManagerInstructions: { kind: 'application', value: current.instructions } }, input: [{ type: 'text', text }] });
        const turn = started.turn;
        if (turn?.status === 'inProgress' && !completed(turn.id) && !state().activeTurnId) markStarted(turn.id);
        if (expectedGeneration !== generation && turn && state().activeTurnId === turn.id && !completed(turn.id)) await rpc('turn/interrupt', { threadId: state().threadId, turnId: turn.id });
        return started;
      } finally { queued--; publishPending(queued > 0); }
    });
    delivery = result.catch(() => {});
    requests.set(requestId, result);
    void result.catch(() => { if (requests.get(requestId) === result) requests.delete(requestId); });
    if (requests.size > 100) requests.delete(requests.keys().next().value!);
    return result;
  }
  return { start, cancel };
}
