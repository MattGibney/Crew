import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute } from "node:path";
import type {
  MessageSender,
  AgentContent,
  AgentRuntimeAdapter,
  CallerContext,
  DeliveryAttempt,
  DeliveryResult,
  JsonObject,
  JsonValue,
  RuntimeBinding,
  RuntimeDeliveryInput,
  RuntimeError,
  RuntimeEvent,
  RuntimeHistoryItem,
  RuntimeResult,
  RuntimeStartAcknowledgement,
  RuntimeStartInput,
  RuntimeStartResult,
} from "./contracts.mjs";
import {
  CodexPeer,
  CodexRpcError,
  json,
  object,
  record,
  string,
  type CodexEnvelope,
  type CodexLaunch,
} from "./codex-peer.mjs";
import {
  CodexEventStream,
  projectCodexItem,
  type CodexSenderLookup,
} from "./codex-history.mjs";
import {
  codexApprovalChoices,
  projectCodexApproval,
} from "./codex-approvals.mjs";
export {
  codexApprovalChoices,
  projectCodexApproval,
} from "./codex-approvals.mjs";
import {
  CodexRealtimeController,
  type CodexRealtimeAudio,
  type CodexRealtimeConnect,
  type CodexRealtimeEvent,
  type CodexRealtimePort,
} from "./codex-realtime.mjs";
export type {
  CodexRealtimeAudio,
  CodexRealtimeConnect,
  CodexRealtimeConnection,
  CodexRealtimeEvent,
  CodexRealtimePort,
  CodexRealtimeState,
} from "./codex-realtime.mjs";

export type CodexLaunchResolution =
  | {
      state: "ready";
      launch: CodexLaunch;
      skills: { id: string; revision: number; nativePath: string }[];
      /** Trusted provider-owned named policy. Optional only for staged source
       * compatibility; execution fails closed unless this binding is supplied. */
      nativePermissions?: CodexNativePermissions;
    }
  | { state: "blocked"; error: RuntimeError };
export interface CodexNativePermissions {
  profileId: string;
  approvalPolicy: "never";
}
/** Trusted #89 composition only, never supplied through an agent-facing request. */
export type CodexLaunchResolver = (
  input: RuntimeStartInput,
) => Promise<CodexLaunchResolution>;
export type CodexHistoryLaunchResolution =
  | { state: "ready"; launch: CodexLaunch }
  | { state: "blocked"; error: RuntimeError };
export interface CodexRuntimeOptions {
  resolveLaunch: CodexLaunchResolver;
  /** Durably record this owned launch before any initialize/thread request.
   * Failure prevents native dispatch; host recovery must fail closed without evidence. */
  onProcessStarted?: (caller: CallerContext, pid: number) => Promise<void>;
  /** Trusted retained-thread lookup, including stopped/controller-recovered agents.
   * Must resolve isolated storage without reopening an expired tool session. */
  resolveHistoryLaunch?: (
    binding: RuntimeBinding,
  ) => Promise<CodexHistoryLaunchResolution>;
  lookupSender?: CodexSenderLookup;
  /** Resolve an authorized artifact reference; no implicit arbitrary local-file access. */
  resolveAttachment?: (
    binding: RuntimeBinding,
    block: Extract<AgentContent, { type: "image" | "file" }>,
  ) => Promise<JsonObject>;
  acknowledgementTimeoutMs?: number;
}
type Approval = {
  id: string | number;
  method: string;
  turnId: string;
  params: JsonObject;
  responding: boolean;
  resolved: boolean;
};
type Send = {
  fingerprint: string;
  sender: MessageSender;
  result: DeliveryResult | null;
};
type Session = {
  input: RuntimeStartInput;
  binding: RuntimeBinding | null;
  peer: CodexPeer;
  acknowledgement: RuntimeStartAcknowledgement | null;
  activeTurnId: string | null;
  terminalTurns: Set<string>;
  settings: Record<string, unknown> | null;
  settingsSequence: number;
  nativePermissions: CodexNativePermissions;
  nativeCwd: string;
  policyVerified: boolean;
  policyError: RuntimeError | null;
  approvals: Map<string, Approval>;
  deliveries: Map<string, Send>;
  observers: Set<CodexEventStream<RuntimeEvent>>;
  waiters: Set<() => void>;
  stopping: boolean;
  sending: boolean;
  historyObserved: boolean;
  observed: boolean;
  earlyEvents: RuntimeEvent[];
  realtime: CodexRealtimeController | null;
};
const now = () => new Date().toISOString();
const failure = (
  code: RuntimeError["code"],
  message: string,
): RuntimeError => ({ code, message });
const key = (
  binding: Pick<RuntimeBinding, "projectId" | "agentId" | "sessionId">,
) => JSON.stringify([binding.projectId, binding.agentId, binding.sessionId]);
const same = (a: RuntimeBinding, b: RuntimeBinding) =>
  key(a) === key(b) && a.threadId === b.threadId;
const exactRoot = (roots: unknown, cwd: string) =>
  Array.isArray(roots) && roots.length === 1 && roots[0] === cwd;
const nativeSettingsMatch = (session: Session, value: unknown) =>
  object(value) &&
  value.cwd === session.nativeCwd &&
  value.approvalPolicy === session.nativePermissions.approvalPolicy &&
  object(value.activePermissionProfile) &&
  value.activePermissionProfile.id === session.nativePermissions.profileId;
const nativeEnvironmentMatches = (session: Session, thread: unknown) => {
  if (!object(thread) || thread.cwd !== session.nativeCwd) return false;
  const environments = thread.environments;
  if (!Array.isArray(environments) || environments.length !== 1) return false;
  const environment = environments[0];
  return (
    object(environment) &&
    environment.environmentId === "local" &&
    environment.cwd === session.nativeCwd &&
    exactRoot(environment.runtimeWorkspaceRoots, session.nativeCwd)
  );
};
const escalationRequest = (method: string) =>
  [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
  ].includes(method);
const negativeDecision = (response: unknown) =>
  object(response) &&
  (response.decision === "decline" || response.decision === "cancel");
function restrictedApproval(method: string, params: JsonObject): JsonObject {
  const projected = projectCodexApproval(method, params);
  if (!escalationRequest(method)) return projected;
  return {
    ...projected,
    message:
      "This native session cannot approve additional command or file access. Denial and cancellation remain available.",
    choices: Array.isArray(projected.choices)
      ? projected.choices.filter(
          (choice) => object(choice) && negativeDecision(choice.response),
        )
      : [],
  };
}
export const codexClientMessageId = (
  binding: RuntimeBinding,
  attemptId: string,
) =>
  `crew-${createHash("sha256")
    .update(JSON.stringify([key(binding), binding.threadId, attemptId]))
    .digest("hex")}`;

function nativeError(error: unknown): RuntimeError {
  if (error instanceof CodexRpcError) {
    if (error.code === -32601)
      return failure(
        "unsupported",
        "This Codex build does not support the required native method.",
      );
    if (error.code === -32602)
      return failure(
        "configuration_rejected",
        "Codex rejected the supplied protocol fields.",
      );
    if (
      error.code === -32600 &&
      /^no rollout found for thread id [\w-]+$/.test(error.message)
    )
      return failure(
        "missing_thread",
        "The retained native thread is unavailable. No replacement was created.",
      );
    return failure(
      error.code === null ? "disconnected" : "runtime_error",
      error.code === null
        ? "Native acknowledgement is unavailable; retain the operation and reconcile before retrying."
        : "Codex rejected the request; native state must be reconciled before retrying.",
    );
  }
  return failure(
    "runtime_error",
    "The native runtime operation could not be verified.",
  );
}

export function createCodexAgentRuntime(
  options: CodexRuntimeOptions,
): CodexAgentRuntime {
  return new CodexAgentRuntime(options);
}

/** Native Codex port for #88; authorization and isolation belong to the injected #89 resolver. */
export class CodexAgentRuntime
  implements AgentRuntimeAdapter, CodexRealtimePort
{
  readonly capabilities = {
    activeTurnSteering: true,
    instructionApplication: "on_resume" as const,
  };
  private sessions = new Map<string, Session>();
  private starts = new Map<string, Promise<RuntimeStartResult>>();
  private stopped = new Map<
    string,
    { binding: RuntimeBinding; stoppedAt: string }
  >();
  private openingAgents = new Set<string>();
  private realtimeListeners = new Set<(event: CodexRealtimeEvent) => void>();
  constructor(private options: CodexRuntimeOptions) {}

  async start(input: RuntimeStartInput): Promise<RuntimeStartResult> {
    const identity = key(input.caller);
    const agentKey = JSON.stringify([
      input.caller.projectId,
      input.caller.agentId,
    ]);
    if (this.stopped.has(identity))
      return {
        state: "failed",
        error: failure(
          "cancelled",
          "This logical session already stopped; an explicit Start must allocate a new session identity.",
        ),
        retainedThreadId: this.stopped.get(identity)!.binding.threadId,
      };
    const pending = this.starts.get(identity);
    if (pending) return pending;
    if (this.openingAgents.has(agentKey))
      return {
        state: "failed",
        error: failure(
          "identity_mismatch",
          "This agent already has a pending native start.",
        ),
        retainedThreadId:
          input.thread.mode === "resume" ? input.thread.threadId : null,
      };
    const existing = this.sessions.get(identity);
    if (
      existing?.acknowledgement &&
      existing.peer.connected &&
      !existing.stopping &&
      existing.policyVerified &&
      !existing.policyError
    )
      return { state: "acknowledged", value: existing.acknowledgement };
    if (existing)
      return {
        state: "uncertain",
        error:
          existing.policyError ??
          failure(
            "disconnected",
            "A prior native start remains unresolved. Reconcile or stop that exact session before another start.",
          ),
        retainedThreadId: existing.binding?.threadId ?? null,
      };
    if (
      [...this.sessions.values()].some(
        (s) =>
          s.input.caller.agentId === input.caller.agentId &&
          s.input.caller.projectId === input.caller.projectId,
      )
    )
      return {
        state: "failed",
        error: failure(
          "identity_mismatch",
          "This agent already has an unresolved native session.",
        ),
        retainedThreadId:
          input.thread.mode === "resume" ? input.thread.threadId : null,
      };
    this.openingAgents.add(agentKey);
    const promise = this.open(input);
    this.starts.set(identity, promise);
    try {
      return await promise;
    } finally {
      this.starts.delete(identity);
      this.openingAgents.delete(agentKey);
    }
  }

  private async open(input: RuntimeStartInput): Promise<RuntimeStartResult> {
    let session: Session | null = null;
    let openingSent = false;
    let safeToClose = true;
    let retainedThreadId =
      input.thread.mode === "resume" ? input.thread.threadId : null;
    try {
      if (key(input.caller) !== key(input.access.caller))
        return {
          state: "failed",
          error: failure(
            "identity_mismatch",
            "Isolation binding does not identify this exact project, agent and session.",
          ),
          retainedThreadId,
        };
      if (
        input.modelAccess.runtime !== "codex" ||
        input.modelAccess.authentication.method !== "chatgpt-subscription"
      )
        return {
          state: "failed",
          error: failure(
            "configuration_rejected",
            "Only native ChatGPT subscription model access is supported.",
          ),
          retainedThreadId,
        };
      const resolved = await this.options.resolveLaunch(structuredClone(input));
      if (resolved.state === "blocked")
        return { state: "failed", error: resolved.error, retainedThreadId };
      const { launch, skills, nativePermissions } = resolved;
      if (
        !nativePermissions ||
        typeof nativePermissions.profileId !== "string" ||
        !nativePermissions.profileId.trim() ||
        nativePermissions.profileId.length > 256 ||
        /[\u0000-\u001f\u007f]/.test(nativePermissions.profileId) ||
        nativePermissions.approvalPolicy !== "never"
      )
        return {
          state: "failed",
          error: failure(
            "isolation_blocked",
            "The trusted resolver must bind a named native permission profile with approval escalation disabled before launch.",
          ),
          retainedThreadId,
        };
      if (
        !isAbsolute(launch.executable) ||
        !isAbsolute(launch.cwd) ||
        !launch.args.includes("app-server") ||
        ["OPENAI_API_KEY", "CODEX_API_KEY"].some((name) =>
          Boolean(launch.env[name]),
        )
      )
        return {
          state: "failed",
          error: failure(
            "isolation_blocked",
            "The trusted resolver must supply an absolute app-server launch with subscription authentication and an explicit isolated environment.",
          ),
          retainedThreadId,
        };
      if (
        skills.length !== input.configuration.skills.length ||
        input.configuration.skills.some(
          (skill) =>
            !skills.some(
              (bound) =>
                bound.id === skill.id &&
                bound.revision === skill.revision &&
                isAbsolute(bound.nativePath) &&
                basename(bound.nativePath) === "SKILL.md",
            ),
        )
      )
        return {
          state: "failed",
          error: failure(
            "isolation_blocked",
            "Selected skill revisions have no exact isolated native path binding.",
          ),
          retainedThreadId,
        };
      const current: Session = {
        input: structuredClone(input),
        binding: retainedThreadId
          ? { ...input.caller, threadId: retainedThreadId }
          : null,
        peer: new CodexPeer(
          launch,
          (envelope) => this.receive(current, envelope),
          () => this.disconnected(current),
          this.options.acknowledgementTimeoutMs,
        ),
        acknowledgement: null,
        activeTurnId: null,
        terminalTurns: new Set(),
        settings: null,
        settingsSequence: 0,
        nativePermissions: structuredClone(nativePermissions),
        nativeCwd: launch.cwd,
        policyVerified: false,
        policyError: null,
        approvals: new Map(),
        deliveries: new Map(),
        observers: new Set(),
        waiters: new Set(),
        stopping: false,
        sending: false,
        historyObserved: false,
        observed: false,
        earlyEvents: [],
        realtime: null,
      };
      session = current;
      this.sessions.set(key(input.caller), current);
      const pid = current.peer.child.pid;
      if (!Number.isSafeInteger(pid) || pid === undefined || pid <= 1)
        throw new CodexRpcError(
          "Native launch has no verified owned process ID.",
          -32602,
          false,
        );
      await this.options.onProcessStarted?.(structuredClone(input.caller), pid);
      await current.peer.rpc("initialize", {
        clientInfo: {
          name: "crew_unified_agents",
          title: "Crew",
          version: "0.18.0",
        },
        capabilities: { experimentalApi: true },
      });
      current.peer.send({ method: "initialized", params: {} });
      const account = record(
        await current.peer.rpc("account/read", { refreshToken: false }),
      );
      if (!object(account.account) || account.account.type !== "chatgpt")
        throw new CodexRpcError(
          "Subscription sign-in is required.",
          -32602,
          false,
        );
      // Native discovery must use only the resolver's selected isolated roots.
      // Sending [] also clears any prior process-local extra-root selection.
      await current.peer.rpc("skills/extraRoots/set", {
        extraRoots: [
          ...new Set(skills.map((skill) => dirname(skill.nativePath))),
        ],
      });
      if (skills.length) {
        const discovery = record(
          await current.peer.rpc("skills/list", {
            cwds: [launch.cwd],
            forceReload: true,
          }),
        );
        const entries = Array.isArray(discovery.data)
          ? discovery.data.filter(object)
          : [];
        const found = entries
          .filter((entry) => entry.cwd === launch.cwd)
          .flatMap((entry) =>
            Array.isArray(entry.skills) ? entry.skills.filter(object) : [],
          );
        if (
          skills.some(
            (skill) =>
              !found.some(
                (native) =>
                  native.path === skill.nativePath && native.enabled === true,
              ),
          )
        )
          throw new CodexRpcError(
            "Selected isolated native skills were not discovered.",
            -32602,
            false,
          );
      }
      openingSent = true;
      safeToClose = false;
      const opened = record(
        await current.peer.rpc(
          input.thread.mode === "create" ? "thread/start" : "thread/resume",
          input.thread.mode === "create"
            ? {
                cwd: launch.cwd,
                ephemeral: false,
                experimentalRawEvents: false,
                runtimeWorkspaceRoots: [launch.cwd],
                permissions: nativePermissions.profileId,
                approvalPolicy: nativePermissions.approvalPolicy,
              }
            : {
                threadId: input.thread.threadId,
                cwd: launch.cwd,
                excludeTurns: true,
                runtimeWorkspaceRoots: [launch.cwd],
                permissions: nativePermissions.profileId,
                approvalPolicy: nativePermissions.approvalPolicy,
              },
        ),
      );
      const thread = record(opened.thread);
      const threadId = string(thread.id);
      if (
        (retainedThreadId && retainedThreadId !== threadId) ||
        (current.binding && current.binding.threadId !== threadId)
      )
        throw new CodexRpcError("Native thread identity mismatch.", -32602);
      retainedThreadId = threadId;
      current.binding = { ...input.caller, threadId };
      if (!object(thread.status) || thread.status.type !== "idle") {
        const turns = record(
          await current.peer.rpc("thread/turns/list", {
            threadId,
            limit: 1,
            sortDirection: "desc",
            itemsView: "notLoaded",
          }),
        );
        const active = Array.isArray(turns.data)
          ? turns.data.find(
              (turn) => object(turn) && turn.status === "inProgress",
            )
          : undefined;
        if (object(active) && typeof active.id === "string")
          current.activeTurnId = active.id;
        throw new CodexRpcError(
          "Cannot apply profile while native execution is active or unknown.",
          -32602,
        );
      }
      safeToClose = true;
      // Profile provenance is verified alongside the exact local workspace.
      // Effective grants belong to the trusted provider's pinned profile;
      // environment metadata alone is never an isolation attestation.
      if (
        !nativeSettingsMatch(current, opened) ||
        !exactRoot(opened.runtimeWorkspaceRoots, launch.cwd) ||
        !nativeEnvironmentMatches(current, thread) ||
        (current.settings !== null &&
          !nativeSettingsMatch(current, current.settings))
      )
        throw new CodexRpcError(
          "The native thread did not confirm the bound permission profile and local workspace.",
          -32602,
        );
      current.policyVerified = true;
      if (input.thread.mode === "create") {
        // Native naming materializes an unused persistent thread in the inspected
        // runtime. It creates no model input; the same ID survives an idle Stop.
        const name =
          input.configuration.profile.name.trim() || input.caller.agentId;
        await current.peer.rpc("thread/name/set", { threadId, name });
        const named = record(
          record(
            await current.peer.rpc("thread/read", {
              threadId,
              includeTurns: false,
            }),
          ).thread,
        );
        if (
          named.id !== threadId ||
          named.name !== name ||
          !nativeEnvironmentMatches(current, named)
        )
          throw new CodexRpcError(
            "Native thread name was not acknowledged.",
            -32602,
          );
      }
      // New threads use Codex's default mode; retained threads must expose their exact effective mode.
      // A no-op settings/update emits no event in 0.163.0-alpha.11, so it is not a read API.
      if (input.thread.mode === "resume" && !object(opened.collaborationMode))
        throw new CodexRpcError(
          "This Codex build does not expose the retained collaboration mode.",
          -32601,
        );
      const mode = record(
        opened.collaborationMode ??
          (input.thread.mode === "create"
            ? {
                mode: "default",
                settings: {
                  model: opened.model,
                  reasoning_effort: opened.reasoningEffort,
                },
              }
            : null),
      );
      const modeSettings = record(mode.settings);
      if (
        typeof mode.mode !== "string" ||
        typeof modeSettings.model !== "string" ||
        !(
          modeSettings.reasoning_effort === null ||
          typeof modeSettings.reasoning_effort === "string"
        )
      )
        throw new CodexRpcError(
          "Native settings cannot preserve the selected mode/model.",
          -32602,
        );
      const profile = input.configuration.profile;
      const instructions = [
        profile.systemPrompt,
        profile.name ? `Agent name: ${profile.name}` : "",
        profile.personality
          ? `Agent personality preferences:\n${profile.personality}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      if (modeSettings.developer_instructions !== instructions) {
        const sequence = current.settingsSequence;
        await current.peer.rpc("thread/settings/update", {
          threadId,
          permissions: nativePermissions.profileId,
          approvalPolicy: nativePermissions.approvalPolicy,
          collaborationMode: {
            mode: mode.mode,
            settings: {
              model: modeSettings.model,
              reasoning_effort: modeSettings.reasoning_effort,
              developer_instructions: instructions,
            },
          },
        });
        await this.wait(current, () => {
          if (current.policyError) return true;
          if (
            current.settingsSequence <= sequence ||
            !object(current.settings?.collaborationMode)
          )
            return false;
          const applied = current.settings.collaborationMode;
          return (
            object(applied.settings) &&
            nativeSettingsMatch(current, current.settings) &&
            applied.mode === mode.mode &&
            applied.settings.model === modeSettings.model &&
            applied.settings.reasoning_effort ===
              modeSettings.reasoning_effort &&
            applied.settings.developer_instructions === instructions
          );
        });
      }
      if (current.policyError || !current.policyVerified)
        throw new CodexRpcError(
          "Native permissions changed before startup acknowledgement.",
          -32602,
        );
      if (current.activeTurnId || current.stopping)
        throw new CodexRpcError(
          "Native work or unavailable observation prevented idle startup.",
        );
      const observedAt = now();
      current.acknowledgement = {
        binding: current.binding,
        observedAt,
        appliedConfiguration: {
          profileRevision: profile.revision,
          permissionGroups: structuredClone(
            input.configuration.permissionGroups,
          ),
          serviceConnections: structuredClone(
            input.configuration.serviceConnections,
          ),
          skills: input.configuration.skills.map(({ id, revision }) => ({
            id,
            revision,
          })),
          runtimeConfigRevision: input.configuration.runtimeConfig.revision,
          appliedAt: observedAt,
        },
      };
      current.realtime = new CodexRealtimeController({
        binding: current.binding,
        peer: current.peer,
        profile: structuredClone(profile),
        usable: () =>
          Boolean(current.acknowledgement) &&
          current.policyVerified &&
          !current.policyError &&
          !current.stopping &&
          current.peer.connected,
        timeoutMs: this.options.acknowledgementTimeoutMs ?? 10_000,
        emit: (event) => {
          for (const listener of this.realtimeListeners) {
            try {
              listener(event);
            } catch {
              /* Display observers never break native transport. */
            }
          }
        },
      });
      return { state: "acknowledged", value: current.acknowledgement };
    } catch (error) {
      retainedThreadId = session?.binding?.threadId ?? retainedThreadId;
      if (nativeError(error).code === "missing_thread") safeToClose = true;
      if (
        session?.binding &&
        openingSent &&
        safeToClose &&
        nativeError(error).code !== "missing_thread"
      ) {
        try {
          const fresh = record(
            await session.peer.rpc("thread/read", {
              threadId: session.binding.threadId,
              includeTurns: false,
            }),
          );
          const thread = record(fresh.thread);
          safeToClose =
            thread.id === session.binding.threadId &&
            object(thread.status) &&
            thread.status.type === "idle";
        } catch {
          safeToClose = false;
        }
      }
      // Do not abandon a process with a pending native request or possibly active execution.
      if (
        session &&
        safeToClose &&
        !session.activeTurnId &&
        session.approvals.size === 0 &&
        (!openingSent || retainedThreadId)
      ) {
        session.stopping = true;
        if (await session.peer.close()) {
          if (session.binding)
            this.stopped.set(key(input.caller), {
              binding: session.binding,
              stoppedAt: now(),
            });
          this.sessions.delete(key(input.caller));
        }
      }
      return {
        state:
          error instanceof CodexRpcError && error.code !== null
            ? "failed"
            : "uncertain",
        error: session?.policyError ?? nativeError(error),
        retainedThreadId,
      };
    }
  }

  private get(binding: RuntimeBinding): Session {
    const session = this.sessions.get(key(binding));
    if (!session?.binding || !same(session.binding, binding))
      throw new CodexRpcError(
        "Native session identity is unavailable.",
        null,
        false,
      );
    return session;
  }
  private policyFailure(session: Session): RuntimeError | null {
    return (
      session.policyError ??
      (session.policyVerified
        ? null
        : failure("isolation_blocked", "Native permissions are unverified."))
    );
  }
  private rejectPolicy(session: Session): RuntimeError {
    if (!session.policyError) {
      session.policyVerified = false;
      session.policyError = failure(
        "configuration_rejected",
        "Native permission settings or workspace changed. Further input is blocked; retain this exact session and reconcile or stop it.",
      );
      if (session.binding)
        this.emit(session, {
          binding: session.binding,
          observedAt: now(),
          kind: "configuration",
          state: "rejected",
          error: session.policyError,
        });
      const voice = session.realtime?.status();
      if (voice?.voiceSessionId && voice.state !== "closed")
        void session.realtime!.disconnect(voice.voiceSessionId).catch(() => {});
      this.changed(session);
    }
    return session.policyError;
  }
  private async verifyEnvironment(
    session: Session,
  ): Promise<RuntimeError | null> {
    const blocked = this.policyFailure(session);
    if (blocked) return blocked;
    const state = record(
      await session.peer.rpc("thread/read", {
        threadId: session.binding!.threadId,
        includeTurns: false,
      }),
    );
    if (
      !object(state.thread) ||
      state.thread.id !== session.binding!.threadId ||
      !nativeEnvironmentMatches(session, state.thread)
    )
      return this.rejectPolicy(session);
    return this.policyFailure(session);
  }
  private emit(session: Session, event: RuntimeEvent) {
    if (!session.observed) {
      if (session.earlyEvents.length < 1024) session.earlyEvents.push(event);
      else session.stopping = true; // Startup events could not be retained; never admit execution.
    }
    for (const stream of session.observers) stream.push(event);
  }
  private changed(session: Session) {
    for (const waiter of session.waiters) waiter();
  }
  private async wait(session: Session, predicate: () => boolean) {
    if (predicate()) return;
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        if (predicate()) {
          clearTimeout(timer);
          session.waiters.delete(finish);
          resolve();
        } else if (!session.peer.connected) {
          clearTimeout(timer);
          session.waiters.delete(finish);
          reject(new CodexRpcError("Native connection was lost."));
        }
      };
      const timer = setTimeout(() => {
        session.waiters.delete(finish);
        reject(new CodexRpcError("Native state acknowledgement timed out."));
      }, this.options.acknowledgementTimeoutMs ?? 10_000);
      session.waiters.add(finish);
      finish();
    });
  }
  private disconnected(session: Session) {
    session.realtime?.disconnected();
    if (session.binding)
      this.emit(session, {
        binding: session.binding,
        observedAt: now(),
        kind: "connection",
        state: "disconnected",
        error: session.stopping
          ? null
          : failure(
              "disconnected",
              "Native process disconnected; outstanding sends require reconciliation.",
            ),
      });
    this.changed(session);
  }

  private receive(session: Session, envelope: CodexEnvelope) {
    const { method, params } = envelope;
    if (
      method === "thread/started" &&
      object(params.thread) &&
      typeof params.thread.id === "string" &&
      !session.binding
    )
      session.binding = { ...session.input.caller, threadId: params.thread.id };
    const binding = session.binding;
    if (envelope.id !== undefined && method === "currentTime/read") {
      session.peer.send({
        id: envelope.id,
        result: { currentTimeAt: Math.floor(Date.now() / 1000) },
      });
      return;
    }
    if (!binding || params.threadId !== binding.threadId) return;
    if (envelope.id === undefined && method.startsWith("thread/realtime/")) {
      session.realtime?.receive(envelope);
      this.changed(session);
      return;
    }
    if (envelope.id !== undefined) {
      const approvalId = JSON.stringify([
        binding.sessionId,
        typeof envelope.id,
        envelope.id,
      ]);
      if (typeof params.turnId !== "string" || !json(params)) {
        // No turn identity is invented for startup elicitation or unsupported native requests.
        session.approvals.set(approvalId, {
          id: envelope.id,
          method,
          turnId: "",
          params: {},
          responding: false,
          resolved: false,
        });
        this.emit(session, {
          binding,
          observedAt: now(),
          kind: "connection",
          state: "disconnected",
          error: failure(
            "unsupported",
            "A native request has no supported turn identity. It remains unanswered and blocks stopping.",
          ),
        });
        return;
      }
      const approval = {
        id: envelope.id,
        method,
        turnId: params.turnId,
        params,
        responding: false,
        resolved: false,
      };
      session.approvals.set(approvalId, approval);
      this.emit(session, {
        binding,
        observedAt: now(),
        kind: "native_approval",
        approvalId,
        turnId: params.turnId,
        request: restrictedApproval(method, params),
      });
    } else if (method === "serverRequest/resolved") {
      for (const [approvalId, approval] of session.approvals)
        if (approval.id === params.requestId && !approval.resolved) {
          approval.resolved = true;
          this.emit(session, {
            binding,
            observedAt: now(),
            kind: "history",
            item: {
              runtimeRef: `native-approval:${approvalId}`,
              turnId: approval.turnId || null,
              kind: "approval",
              sender: { type: "system" },
              content: [],
              metadata: { approvalId, state: "resolved" },
            },
          });
        }
    } else if (method === "thread/settings/updated") {
      session.settings = object(params.threadSettings)
        ? params.threadSettings
        : null;
      session.settingsSequence++;
      if (
        session.policyVerified &&
        !nativeSettingsMatch(session, params.threadSettings)
      )
        this.rejectPolicy(session);
    } else if (
      (method === "turn/started" || method === "turn/completed") &&
      object(params.turn) &&
      typeof params.turn.id === "string"
    ) {
      const turnId = params.turn.id;
      if (method === "turn/started") {
        if (!session.terminalTurns.has(turnId)) session.activeTurnId = turnId;
      } else {
        session.terminalTurns.add(turnId);
        if (session.activeTurnId === turnId) session.activeTurnId = null;
      }
      this.emit(session, {
        binding,
        observedAt: now(),
        kind: "turn",
        turnId,
        state:
          method === "turn/started"
            ? "started"
            : params.turn.status === "completed"
              ? "completed"
              : params.turn.status === "interrupted"
                ? "cancelled"
                : "failed",
      });
    } else if (
      (method === "item/started" || method === "item/completed") &&
      typeof params.turnId === "string"
    ) {
      session.historyObserved = true;
      const item = projectCodexItem(
        binding,
        params.item,
        params.turnId,
        (b, clientId) =>
          session.deliveries.get(clientId)?.sender ??
          this.options.lookupSender?.(b, clientId) ??
          null,
      );
      if (item)
        this.emit(session, {
          binding,
          observedAt: now(),
          kind: "history",
          item,
        });
    } else if (
      method === "item/agentMessage/delta" &&
      typeof params.itemId === "string" &&
      typeof params.turnId === "string" &&
      typeof params.delta === "string"
    ) {
      this.emit(session, {
        binding,
        observedAt: now(),
        kind: "history",
        item: {
          runtimeRef: params.itemId,
          turnId: params.turnId,
          kind: "message",
          sender: { type: "assistant", agentId: binding.agentId },
          content: [{ type: "text", text: params.delta }],
          metadata: { nativeType: "agentMessage", update: "delta" },
        },
      });
    }
    this.changed(session);
  }

  async stop(
    binding: RuntimeBinding,
  ): Promise<RuntimeResult<{ stoppedAt: string }>> {
    try {
      const stopped = this.stopped.get(key(binding));
      if (stopped && same(stopped.binding, binding))
        return {
          state: "acknowledged",
          value: { stoppedAt: stopped.stoppedAt },
        };
      const session = this.get(binding);
      session.stopping = true;
      const voice = session.realtime?.status();
      if (voice?.voiceSessionId && voice.state !== "closed") {
        const disconnected = await session.realtime!.disconnect(
          voice.voiceSessionId,
        );
        if (disconnected.state === "failed") return disconnected;
      }
      if (session.sending)
        return {
          state: "failed",
          error: failure(
            "runtime_error",
            "A native send is still settling. Stop remains held.",
          ),
        };
      if (session.activeTurnId) {
        const cancelled = await this.cancelTurn(binding, session.activeTurnId);
        if (cancelled.state === "failed") return cancelled;
      }
      if (
        [...session.approvals.values()].some((approval) => !approval.resolved)
      )
        return {
          state: "failed",
          error: failure(
            "native_approval_required",
            "A native request is still pending. No response was sent automatically.",
          ),
        };
      if (session.peer.connected) {
        const state = record(
          await session.peer.rpc("thread/read", {
            threadId: binding.threadId,
            includeTurns: false,
          }),
        );
        const thread = record(state.thread);
        if (
          thread.id !== binding.threadId ||
          !object(thread.status) ||
          thread.status.type !== "idle"
        )
          return {
            state: "failed",
            error: failure(
              "runtime_error",
              "Native idle state is not confirmed; stop remains held.",
            ),
          };
      } else
        return {
          state: "failed",
          error: failure(
            "disconnected",
            "Lost native ownership cannot be reported as a confirmed stop.",
          ),
        };
      if (!(await session.peer.close()))
        return {
          state: "failed",
          error: failure(
            "runtime_error",
            "The owned native process has not confirmed exit. No process was force-stopped.",
          ),
        };
      for (const stream of session.observers) stream.end();
      this.stopped.set(key(binding), { binding, stoppedAt: now() });
      this.sessions.delete(key(binding));
      return { state: "acknowledged", value: { stoppedAt: now() } };
    } catch (error) {
      return { state: "failed", error: nativeError(error) };
    }
  }

  async deliver(input: RuntimeDeliveryInput): Promise<DeliveryResult> {
    let session: Session | null = null;
    let sent = false;
    let ownsSending = false;
    try {
      session = this.get(input.binding);
      if (
        !session.acknowledgement ||
        session.stopping ||
        session.sending ||
        input.message.recipientAgentId !== input.binding.agentId
      )
        return {
          state: "not_sent",
          error: failure(
            "identity_mismatch",
            "The recipient session is not available for this delivery.",
          ),
        };
      const clientId = codexClientMessageId(input.binding, input.attemptId);
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(input))
        .digest("hex");
      const existing = session.deliveries.get(clientId);
      if (existing)
        return existing.fingerprint === fingerprint
          ? (existing.result ?? {
              state: "uncertain",
              error: failure(
                "runtime_error",
                "This exact native attempt is already pending; it was not repeated.",
              ),
            })
          : {
              state: "not_sent",
              error: failure(
                "identity_mismatch",
                "The attempt ID was reused with different delivery content.",
              ),
            };
      const policyError = this.policyFailure(session);
      if (policyError) return { state: "not_sent", error: policyError };
      session.sending = true;
      ownsSending = true;
      const nativeInput: JsonValue[] = [];
      for (const block of input.message.content) {
        if (block.type === "text")
          nativeInput.push({
            type: "text",
            text: block.text,
            text_elements: [],
          });
        else if (block.type === "data")
          nativeInput.push({
            type: "text",
            text: JSON.stringify(block.value),
            text_elements: [],
          });
        else {
          if (!this.options.resolveAttachment)
            return {
              state: "not_sent",
              error: failure(
                "unsupported",
                "This attachment needs an authorized native artifact resolver.",
              ),
            };
          const attachment = await this.options.resolveAttachment(
            input.binding,
            block,
          );
          if (!(
            (attachment.type === "image" &&
              typeof attachment.fileId === "string") ||
            (attachment.type === "localImage" &&
              typeof attachment.path === "string" &&
              isAbsolute(attachment.path)) ||
            (attachment.type === "mention" &&
              typeof attachment.name === "string" &&
              typeof attachment.path === "string" &&
              isAbsolute(attachment.path))
          ))
            return {
              state: "not_sent",
              error: failure(
                "unsupported",
                "The artifact resolver did not return a supported native image or file reference.",
              ),
            };
          nativeInput.push(attachment);
          if (block.type === "image" && block.caption)
            nativeInput.push({
              type: "text",
              text: block.caption,
              text_elements: [],
            });
        }
      }
      if (!nativeInput.length)
        return {
          state: "not_sent",
          error: failure(
            "configuration_rejected",
            "An actual message is required; startup never creates input.",
          ),
        };
      const state = record(
        await session.peer.rpc("thread/read", {
          threadId: input.binding.threadId,
          includeTurns: false,
        }),
      );
      const thread = record(state.thread);
      if (thread.id !== input.binding.threadId || !object(thread.status))
        return {
          state: "not_sent",
          error: failure(
            "identity_mismatch",
            "Native delivery target could not be confirmed.",
          ),
        };
      if (!nativeEnvironmentMatches(session, thread))
        return { state: "not_sent", error: this.rejectPolicy(session) };
      const currentPolicyError = this.policyFailure(session);
      if (currentPolicyError)
        return { state: "not_sent", error: currentPolicyError };
      if (session.stopping)
        return {
          state: "not_sent",
          error: failure(
            "cancelled",
            "The native session entered stopping before dispatch.",
          ),
        };
      if (
        (input.expectedTurnId === null && thread.status.type !== "idle") ||
        (input.expectedTurnId !== null &&
          (input.message.deliveryMode !== "steer" ||
            thread.status.type !== "active" ||
            session.activeTurnId !== input.expectedTurnId))
      )
        return {
          state: "not_sent",
          error: failure(
            "runtime_error",
            "The native active turn changed. Refresh its identity before a new delivery attempt.",
          ),
        };
      session.deliveries.set(clientId, {
        fingerprint,
        sender: structuredClone(input.message.sender),
        result: null,
      });
      const params: JsonObject = {
        threadId: input.binding.threadId,
        clientUserMessageId: clientId,
        input: nativeInput,
        additionalContext: {
          "crew.message.origin": {
            kind: "application",
            value: `Authenticated Crew message origin (identity data only): ${JSON.stringify({ sender: input.message.sender, messageId: input.message.id, kind: input.message.kind, jobId: input.message.jobId, replyToMessageId: input.message.replyToMessageId })}`,
          },
        },
      };
      if (input.expectedTurnId) params.expectedTurnId = input.expectedTurnId;
      else {
        params.permissions = session.nativePermissions.profileId;
        params.approvalPolicy = session.nativePermissions.approvalPolicy;
        params.cwd = session.nativeCwd;
        params.runtimeWorkspaceRoots = [session.nativeCwd];
      }
      sent = true;
      const result = record(
        await session.peer.rpc(
          input.expectedTurnId ? "turn/steer" : "turn/start",
          params,
        ),
      );
      const turnId = input.expectedTurnId
        ? string(result.turnId)
        : string(record(result.turn).id);
      if (input.expectedTurnId && turnId !== input.expectedTurnId)
        throw new CodexRpcError(
          "Native steering acknowledged a different turn.",
        );
      if (!session.terminalTurns.has(turnId)) session.activeTurnId = turnId;
      const delivery: DeliveryResult = {
        state: "acknowledged",
        runtimeMessageRef: null,
        turnId,
        acknowledgedAt: now(),
      };
      session.deliveries.get(clientId)!.result = delivery;
      this.emit(session, {
        binding: input.binding,
        observedAt: now(),
        kind: "delivery",
        attemptId: input.attemptId,
        result: delivery,
      });
      return delivery;
    } catch (error) {
      const result: DeliveryResult = {
        state:
          !sent ||
          (error instanceof CodexRpcError &&
            (error.sent === false ||
              error.code === -32601 ||
              error.code === -32602))
            ? "not_sent"
            : "uncertain",
        error: nativeError(error),
      };
      const attempted = session?.deliveries.get(
        codexClientMessageId(input.binding, input.attemptId),
      );
      if (attempted) attempted.result = result;
      return result;
    } finally {
      if (session && ownsSending) session.sending = false;
    }
  }

  private async historyPage(
    binding: RuntimeBinding,
    peer: CodexPeer,
    cursor: string | undefined,
    liveSession?: Session,
  ): Promise<
    RuntimeResult<{ items: RuntimeHistoryItem[]; nextCursor: string | null }>
  > {
    let page: Record<string, unknown>;
    try {
      page = record(
        await peer.rpc("thread/turns/list", {
          threadId: binding.threadId,
          limit: 50,
          itemsView: "full",
          sortDirection: "desc",
          ...(cursor ? { cursor } : {}),
        }),
      );
    } catch (error) {
      if (
        liveSession &&
        !cursor &&
        !liveSession.historyObserved &&
        error instanceof CodexRpcError &&
        error.code === -32600 &&
        error.message ===
          `thread ${binding.threadId} is not materialized yet; thread/turns/list is unavailable before first user message`
      )
        return {
          state: "acknowledged",
          value: { items: [], nextCursor: null },
        };
      throw error;
    }
    if (
      !Array.isArray(page.data) ||
      !(page.nextCursor === null || typeof page.nextCursor === "string") ||
      (page.nextCursor && page.nextCursor === cursor)
    )
      throw new CodexRpcError("Malformed native history page.");
    const items: RuntimeHistoryItem[] = [];
    for (const raw of [...page.data].reverse()) {
      const turn = record(raw);
      const turnId = string(turn.id);
      if (!Array.isArray(turn.items) || turn.itemsView !== "full")
        throw new CodexRpcError("Native history did not include full items.");
      for (const native of turn.items) {
        const item = projectCodexItem(
          binding,
          native,
          turnId,
          (b, clientId) =>
            liveSession?.deliveries.get(clientId)?.sender ??
            this.options.lookupSender?.(b, clientId) ??
            null,
        );
        if (item) items.push(item);
      }
    }
    return {
      state: "acknowledged",
      value: { items, nextCursor: page.nextCursor },
    };
  }

  async readHistory(binding: RuntimeBinding, cursor?: string) {
    let reader: CodexPeer | null = null;
    let result: RuntimeResult<{
      items: RuntimeHistoryItem[];
      nextCursor: string | null;
    }>;
    try {
      const session = this.sessions.get(key(binding));
      if (session?.binding && !same(session.binding, binding))
        return {
          state: "failed" as const,
          error: failure(
            "identity_mismatch",
            "Native history binding does not match the retained session.",
          ),
        };
      if (session?.binding && session.peer.connected)
        return await this.historyPage(binding, session.peer, cursor, session);
      if (!this.options.resolveHistoryLaunch)
        return {
          state: "failed" as const,
          error: failure(
            "unsupported",
            "Stopped native history requires a trusted isolated history reader.",
          ),
        };
      const resolved = await this.options.resolveHistoryLaunch(
        structuredClone(binding),
      );
      if (resolved.state === "blocked")
        return { state: "failed" as const, error: resolved.error };
      const { launch } = resolved;
      if (
        !isAbsolute(launch.executable) ||
        !isAbsolute(launch.cwd) ||
        !launch.args.includes("app-server") ||
        ["OPENAI_API_KEY", "CODEX_API_KEY"].some((name) =>
          Boolean(launch.env[name]),
        )
      )
        return {
          state: "failed" as const,
          error: failure(
            "isolation_blocked",
            "History reader requires an explicit isolated native launch without API credentials.",
          ),
        };
      let unsupportedRequest = false;
      const peer = new CodexPeer(
        launch,
        (envelope) => {
          if (envelope.id === undefined) return;
          if (envelope.method === "currentTime/read")
            peer.send({
              id: envelope.id,
              result: { currentTimeAt: Math.floor(Date.now() / 1000) },
            });
          else unsupportedRequest = true; // No approvals or authentication are supplied by a history read.
        },
        () => {},
        this.options.acknowledgementTimeoutMs,
      );
      reader = peer;
      await peer.rpc("initialize", {
        clientInfo: {
          name: "crew_native_history",
          title: "Crew",
          version: "0.18.0",
        },
        capabilities: { experimentalApi: true },
      });
      peer.send({ method: "initialized", params: {} });
      const read = record(
        await peer.rpc("thread/read", {
          threadId: binding.threadId,
          includeTurns: false,
        }),
      );
      if (record(read.thread).id !== binding.threadId)
        throw new CodexRpcError(
          "Native history returned a different thread.",
          -32602,
        );
      result = await this.historyPage(binding, peer, cursor);
      if (unsupportedRequest)
        result = {
          state: "failed",
          error: failure(
            "unsupported",
            "The native history reader unexpectedly requested a privileged interaction; none was supplied.",
          ),
        };
    } catch (error) {
      result = { state: "failed", error: nativeError(error) };
    }
    if (reader && !(await reader.close()))
      return {
        state: "failed" as const,
        error: failure(
          "disconnected",
          "The read-only native process has not confirmed exit. No agent was started or process force-stopped.",
        ),
      };
    return result;
  }

  async reconcileDelivery(
    binding: RuntimeBinding,
    attempt: DeliveryAttempt,
  ): Promise<DeliveryResult> {
    if (attempt.threadId !== binding.threadId)
      return {
        state: "uncertain",
        error: failure(
          "identity_mismatch",
          "The delivery attempt belongs to another native thread.",
        ),
      };
    // A new logical session may read the old attempt on the SAME native thread after explicit Start.
    const clientId = codexClientMessageId(
      { ...binding, sessionId: attempt.sessionId },
      attempt.id,
    );
    try {
      const session = this.sessions.get(key(binding));
      const known =
        session?.binding && same(session.binding, binding)
          ? session.deliveries.get(clientId)?.result
          : undefined;
      if (known?.state === "acknowledged" || known?.state === "not_sent")
        return known;
      let cursor: string | undefined;
      for (let pages = 0; pages < 20; pages++) {
        const result = await this.readHistory(binding, cursor);
        if (result.state === "failed")
          return { state: "uncertain", error: result.error };
        const found = result.value.items.find(
          (item) =>
            item.metadata.clientId === clientId ||
            (attempt.runtimeMessageRef !== null &&
              item.runtimeRef === attempt.runtimeMessageRef),
        );
        if (found?.turnId)
          return {
            state: "acknowledged",
            runtimeMessageRef: found.runtimeRef,
            turnId: found.turnId,
            acknowledgedAt: now(),
          };
        if (!result.value.nextCursor) break;
        cursor = result.value.nextCursor;
      }
      return {
        state: "uncertain",
        error: failure(
          "runtime_error",
          "No exact native receipt was found in the bounded history. Absence does not prove non-delivery; the input was not repeated.",
        ),
      };
    } catch (error) {
      return { state: "uncertain", error: nativeError(error) };
    }
  }

  subscribeRealtime(listener: (event: CodexRealtimeEvent) => void): () => void {
    this.realtimeListeners.add(listener);
    return () => this.realtimeListeners.delete(listener);
  }

  realtimeStatus(binding: RuntimeBinding) {
    return (
      this.get(binding).realtime?.status() ?? {
        state: "closed" as const,
        voiceSessionId: null,
      }
    );
  }

  async listRealtimeVoices(binding: RuntimeBinding) {
    try {
      const realtime = this.get(binding).realtime;
      if (!realtime)
        return {
          state: "failed" as const,
          error: failure(
            "disconnected",
            "The native agent session has not acknowledged startup.",
          ),
        };
      return await realtime.listVoices();
    } catch (error) {
      return { state: "failed" as const, error: nativeError(error) };
    }
  }

  async connectRealtime(binding: RuntimeBinding, input: CodexRealtimeConnect) {
    try {
      const session = this.get(binding);
      const policyError = await this.verifyEnvironment(session);
      if (policyError) return { state: "failed" as const, error: policyError };
      const realtime = session.realtime;
      if (!realtime)
        return {
          state: "failed" as const,
          error: failure(
            "disconnected",
            "The native agent session has not acknowledged startup.",
          ),
        };
      return await realtime.connect(input);
    } catch (error) {
      return { state: "failed" as const, error: nativeError(error) };
    }
  }

  async appendRealtimeAudio(
    binding: RuntimeBinding,
    voiceSessionId: string,
    audio: CodexRealtimeAudio,
  ) {
    try {
      const session = this.get(binding);
      const policyError = this.policyFailure(session);
      if (policyError) return { state: "failed" as const, error: policyError };
      const realtime = session.realtime;
      if (!realtime)
        return {
          state: "failed" as const,
          error: failure(
            "disconnected",
            "The native agent session has not acknowledged startup.",
          ),
        };
      return await realtime.appendAudio(voiceSessionId, audio);
    } catch (error) {
      return { state: "failed" as const, error: nativeError(error) };
    }
  }

  async disconnectRealtime(binding: RuntimeBinding, voiceSessionId: string) {
    try {
      const realtime = this.get(binding).realtime;
      if (!realtime)
        return {
          state: "failed" as const,
          error: failure(
            "disconnected",
            "The native agent session has not acknowledged startup.",
          ),
        };
      return await realtime.disconnect(voiceSessionId);
    } catch (error) {
      return { state: "failed" as const, error: nativeError(error) };
    }
  }

  async cancelTurn(
    binding: RuntimeBinding,
    turnId: string,
  ): Promise<RuntimeResult<null>> {
    try {
      const session = this.get(binding);
      if (session.terminalTurns.has(turnId))
        return { state: "acknowledged", value: null };
      if (session.activeTurnId !== turnId)
        return {
          state: "failed",
          error: failure(
            "identity_mismatch",
            "The native active turn does not match the requested cancellation.",
          ),
        };
      await session.peer.rpc("turn/interrupt", {
        threadId: binding.threadId,
        turnId,
      });
      await this.wait(session, () => session.terminalTurns.has(turnId));
      return { state: "acknowledged", value: null };
    } catch (error) {
      return { state: "failed", error: nativeError(error) };
    }
  }

  async respondToNativeApproval(
    binding: RuntimeBinding,
    approvalId: string,
    response: JsonValue,
  ): Promise<RuntimeResult<null>> {
    try {
      const session = this.get(binding);
      const approval = session.approvals.get(approvalId);
      if (!approval || !approval.turnId || approval.resolved)
        return {
          state: "failed",
          error: failure(
            "identity_mismatch",
            "This native request is no longer pending in the exact session.",
          ),
        };
      if (approval.responding)
        return {
          state: "failed",
          error: failure(
            "runtime_error",
            "Native response delivery is unresolved; it was not replayed.",
          ),
        };
      if (escalationRequest(approval.method) && !negativeDecision(response))
        return {
          state: "failed",
          error: failure(
            "isolation_blocked",
            "The bound native policy does not allow approval of additional command or file access. Denial and cancellation remain available.",
          ),
        };
      if (!validApprovalResponse(approval, response))
        return {
          state: "failed",
          error: failure(
            "unsupported",
            "This native response shape is unsupported. The request remains unanswered.",
          ),
        };
      approval.responding = true;
      session.peer.send({ id: approval.id, result: response });
      await this.wait(session, () => approval.resolved);
      return { state: "acknowledged", value: null };
    } catch (error) {
      return { state: "failed", error: nativeError(error) };
    }
  }

  observe(binding: RuntimeBinding): AsyncIterable<RuntimeEvent> {
    const session = this.get(binding);
    const stream = new CodexEventStream<RuntimeEvent>(() =>
      session.observers.delete(stream),
    );
    session.observers.add(stream);
    for (const event of session.earlyEvents.splice(0)) stream.push(event);
    session.observed = true;
    stream.push({
      binding,
      observedAt: now(),
      kind: "connection",
      state: session.peer.connected ? "connected" : "disconnected",
      error: session.peer.connected
        ? null
        : failure("disconnected", "Native process is disconnected."),
    });
    if (session.policyError)
      stream.push({
        binding,
        observedAt: now(),
        kind: "configuration",
        state: "rejected",
        error: session.policyError,
      });
    if (session.activeTurnId)
      stream.push({
        binding,
        observedAt: now(),
        kind: "turn",
        turnId: session.activeTurnId,
        state: "started",
      });
    for (const [approvalId, approval] of session.approvals)
      if (!approval.resolved && approval.turnId)
        stream.push({
          binding,
          observedAt: now(),
          kind: "native_approval",
          approvalId,
          turnId: approval.turnId,
          request: restrictedApproval(approval.method, approval.params),
        });
    return stream;
  }
}

function validApprovalResponse(
  approval: Approval,
  response: JsonValue,
): boolean {
  if (!object(response)) return false;
  if (
    [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
    ].includes(approval.method)
  ) {
    // Policy amendments are deliberately unsupported until a scoped native review UI exists.
    return (
      Object.keys(response).length === 1 &&
      codexApprovalChoices(approval.method, approval.params).some(
        (choice) =>
          object(choice.response) &&
          choice.response.decision === response.decision,
      )
    );
  }
  if (approval.method === "item/tool/requestUserInput") {
    return (
      projectCodexApproval(approval.method, approval.params).scopeComplete ===
        true &&
      Object.keys(response).length === 1 &&
      object(response.answers) &&
      Object.values(response.answers).every(
        (value) =>
          object(value) &&
          Object.keys(value).length === 1 &&
          Array.isArray(value.answers) &&
          value.answers.every((answer) => typeof answer === "string"),
      )
    );
  }
  // Permissions and MCP/OAuth elicitation require their actual native schema/UI; never fabricate a denial/approval.
  return false;
}
