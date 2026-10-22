export type PreparationRole = "manager" | "worker";
export type PreparationPhase = "preparing" | "ready" | "canceled" | "complete";
export type PreparationResponseState =
  "preparing" | "ready" | "needs-input" | "blocked";
export interface PreparationParticipantInput {
  id: string;
  role: PreparationRole;
  taskId: string | null;
  runId: string | null;
  threadId: string | null;
  requestId: string;
  required: boolean;
  message: string;
}
export interface PreparationResponse {
  responseId: string;
  state: PreparationResponseState;
  note: string;
  continuation?: string;
  at: string;
}
export interface PreparationDelivery {
  state: "pending" | "attempted" | "acknowledged" | "failed" | "uncertain";
  at: string;
  nativeTurnId?: string;
  error?: string;
}
export interface PreparationParticipant extends PreparationParticipantInput {
  delivery: PreparationDelivery;
  response: PreparationResponse | null;
  responses: PreparationResponse[];
}
export interface PreparationPlan {
  schema: 1;
  id: string;
  purpose: "update" | "quit";
  projectId: string;
  phase: PreparationPhase;
  participants: PreparationParticipant[];
  createdAt: string;
  updatedAt: string;
}
export interface BeginPreparationInput {
  id: string;
  purpose: "update" | "quit";
  projectId: string;
  participants: PreparationParticipantInput[];
}
export interface PreparationIdentity {
  preparationId: string;
  participantId: string;
  requestId: string;
}
export interface PreparationActor {
  role: PreparationRole;
  projectId?: string;
  taskId?: string;
  runId?: string;
}
export interface ReportPreparationInput extends PreparationIdentity {
  responseId: string;
  state: PreparationResponseState;
  note: string;
  continuation?: string;
}
export interface PreparationRequest extends PreparationIdentity {
  purpose: "update" | "quit";
  projectId: string;
  participant: PreparationParticipant;
}
