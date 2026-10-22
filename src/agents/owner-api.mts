import type {
  Agent,
  AgentContent,
  ExecutionReservation,
  JsonValue,
  ServiceConnectionView,
  Skill,
} from "./contracts.mjs";
import { AgentFoundation, type SendInput } from "./foundation.mjs";
import type { CreateJobInput, FoundationPrincipal } from "./records.mjs";

export interface OwnerApiOptions {
  foundation: AgentFoundation;
  projectName: string;
  defaultModelAccessId: string;
  defaultRuntimeConfigRef: string;
  catalog(): Promise<{
    skills: Skill[];
    serviceConnections: ServiceConnectionView[];
  }>;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected command fields.");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    !value ||
    /[\u0000-\u001f]/.test(value)
  )
    throw new Error("Invalid command identity.");
  return value;
}

/** Bind only after trusted transport authentication. There is no actor/sender field
 * in owner requests; these methods are not directly exposed to native agents. */
export function createOwnerApi(
  options: OwnerApiOptions,
  authenticatedUserId: string,
) {
  const foundation = options.foundation;
  if (foundation.store.snapshot().ownerUserId !== authenticatedUserId)
    throw new Error("Owner authentication does not match this project.");
  const principal: FoundationPrincipal = {
    type: "owner",
    userId: authenticatedUserId,
  };
  return {
    async snapshot() {
      const state = foundation.store.snapshot();
      const catalog = await options.catalog();
      return {
        projectId: state.projectId,
        projectName: options.projectName,
        ownerId: state.ownerUserId,
        agents: await foundation.agentViews(),
        projectSettings: state.projectSettings,
        provisioning: state.provisioning,
        creationPresets: await foundation.creationPresets(),
        jobs: state.jobs,
        skills: catalog.skills,
        serviceConnections: catalog.serviceConnections,
        pendingMessages: state.messages.filter(
          (row) => row.visibility === "public",
        ),
        internalDeliveries: state.messages
          .filter((row) => row.visibility === "private")
          .map((row) => ({
            id: row.id,
            recipientAgentId: row.recipientAgentId,
            delivery: row.delivery,
          })),
        receipts: state.receipts.filter((row) => row.visibility === "public"),
        helpRequests: state.helpRequests,
        ownerInbox: state.ownerInbox,
        readiness: state.preparation?.readiness ?? [],
        nativeApprovals: state.nativeApprovals.map((approval) => ({
          ...approval,
          ...(approval.state === "pending" &&
          Array.isArray(approval.request.choices)
            ? { choices: approval.request.choices }
            : {}),
        })),
      };
    },
    subscribe(listener: (event: unknown) => void): () => void {
      const state = foundation.store.subscribe(() =>
        listener({ kind: "changed" }),
      );
      const runtime = foundation.subscribeRuntime((event) => {
        const turnId =
          event.kind === "history"
            ? event.item.turnId
            : "turnId" in event
              ? event.turnId
              : null;
        if (
          turnId &&
          foundation.turnVisibility(
            event.binding.agentId,
            event.binding.threadId,
            turnId,
          ) !== "public"
        ) {
          listener({ kind: "changed" });
          return;
        }
        listener({ kind: "runtime", event });
      });
      return () => {
        state();
        runtime();
      };
    },
    async command(name: string, value: unknown): Promise<unknown> {
      const args = object(value);
      // Records validate their exact runtime input shape and every persisted DTO.
      // The casts below bridge decoded JSON only; they grant no authority.
      switch (name) {
        case "readHistory":
          return foundation.history(
            principal,
            text(args.agentId),
            args.cursor === undefined ? undefined : text(args.cursor),
          );
        case "createAgent":
          return foundation.createFromPreset(
            principal,
            object(args.input) as unknown as Parameters<
              typeof foundation.createFromPreset
            >[1],
          );
        case "setPrimaryAgent":
          return foundation.setPrimary(
            principal,
            args.agentId === null ? null : text(args.agentId),
            args.expectedRevision as number,
          );
        case "retryProvisioning":
          return foundation.retryProvisioning(principal, text(args.agentId));
        case "saveProfile": {
          const input = object(args.input);
          const profile = object(input.profile);
          return foundation.records.updateProfile(
            principal,
            text(args.agentId),
            input.expectedRevision as number,
            { ...profile, skills: input.skills as Agent["skills"] },
          );
        }
        case "lifecycle": {
          const agentId = text(args.agentId);
          if (args.action === "start") return foundation.start(agentId);
          if (args.action === "stop") return foundation.stop(agentId);
          if (args.action === "restart") return foundation.restart(agentId);
          throw new Error("Unknown session action.");
        }
        case "sendMessage":
          return foundation.send(principal, {
            deliveryMode: "steer",
            ...object(args.input),
          } as unknown as SendInput);
        case "reconcileMessage":
          return foundation.reconcileMessage(principal, text(args.messageId));
        case "retryMessage":
          return foundation.retryMessage(principal, text(args.messageId));
        case "respondToHelp": {
          const result = await foundation.records.answerHelp(
            principal,
            text(args.helpId),
            args.content as AgentContent[],
          );
          void foundation.flush().catch(() => {});
          return result;
        }
        case "respondToNativeApproval":
          return foundation.respondToNativeApproval(
            principal,
            text(args.agentId),
            text(args.approvalId),
            args.response as JsonValue,
          );
        case "createJob":
          return foundation.records.createJob(
            principal,
            args.input as CreateJobInput,
          );
        case "assignJob":
          return foundation.records.assignJob(
            principal,
            text(args.jobId),
            args.agentId === null ? null : text(args.agentId),
            args.instruction as string | null,
          );
        case "archiveAgent":
          return foundation.records.archive(principal, text(args.agentId));
        case "recoverSession":
          return foundation.recoverSession(principal, text(args.agentId));
        case "cancelTurn":
          return foundation.cancelTurn(principal, text(args.agentId));
        case "reserveExecution":
          return foundation.reserveExecution(
            foundation.store.snapshot().projectId,
            text(args.reason) as ExecutionReservation["reason"],
          );
        case "releaseExecution":
          return foundation.releaseExecution(text(args.reservationId));
        case "prepare":
          return foundation.prepare(
            foundation.store.snapshot().projectId,
            text(args.reason) as ExecutionReservation["reason"],
          );
        default:
          throw new Error("Unsupported owner command.");
      }
    },
  };
}

export type FoundationOwnerApi = ReturnType<typeof createOwnerApi>;
