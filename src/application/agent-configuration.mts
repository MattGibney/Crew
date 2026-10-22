import type { RuntimeBinding } from "../agents/contracts.mjs";
import type { UnifiedApplication } from "../agents/service-composition.mjs";
import type { AgentConfigurationOptions } from "./agent-configuration-contracts.mjs";

type Application = Pick<
  UnifiedApplication,
  "foundation" | "ownerApi" | "runtime" | "setupDefaults"
>;

/** No work is dispatched by this owner-only presentation adapter. */
export function createAgentConfiguration(application: Application) {
  let catalogue: AgentConfigurationOptions["voices"] = {
    state: "unavailable",
    values: [],
    defaultVoice: null,
    observedAt: null,
  };
  return {
    selectedVoice(binding: RuntimeBinding): string | null {
      const state = application.foundation.store.snapshot();
      if (state.projectId !== binding.projectId) return null;
      return (
        state.agents.find(
          (agent) => agent.id === binding.agentId && !agent.archivedAt,
        )?.profile.voice ?? null
      );
    },
    async options(): Promise<AgentConfigurationOptions> {
      // A catalogue read is supported on an already started native session.
      // It never starts a session just to populate a settings dropdown.
      const agent = application.foundation.store
        .snapshot()
        .agents.find(
          (row) =>
            !row.archivedAt &&
            row.runtime.session.observedState === "started" &&
            row.runtime.session.sessionId &&
            row.runtime.threadId,
        );
      let available = false;
      if (agent) {
        const result = await application.runtime
          .listRealtimeVoices({
            projectId: agent.projectId,
            agentId: agent.id,
            sessionId: agent.runtime.session.sessionId!,
            threadId: agent.runtime.threadId!,
          })
          .catch(() => null);
        if (result?.state === "acknowledged") {
          catalogue = {
            state: "available",
            values: result.value.voices,
            defaultVoice: result.value.defaultVoice,
            observedAt: new Date().toISOString(),
          };
          available = true;
        }
      }
      return {
        runtime: {
          provider: "codex",
          modelAccessId: application.setupDefaults.modelAccessId,
          configRef: application.setupDefaults.configRef,
          label: "ChatGPT subscription · Crew isolated Codex profile",
        },
        voices: {
          ...structuredClone(catalogue),
          state: available ? "available" : "unavailable",
        },
      };
    },
    /** Move the compatibility setting exactly once. An explicit per-agent null
     * means native default and must never be overwritten by the old override. */
    async migrateLegacyVoice(
      voice: string | null | undefined,
      retire: () => Promise<unknown>,
    ): Promise<void> {
      if (voice == null) return;
      const state = application.foundation.store.snapshot();
      const agent = state.agents.find(
        (row) =>
          row.id === state.projectSettings.primaryAgentId && !row.archivedAt,
      );
      if (!agent) return;
      if (agent.profile.voice === undefined) {
        await application.ownerApi.command("saveProfile", {
          agentId: agent.id,
          input: {
            expectedRevision: agent.profile.revision,
            profile: { voice },
            skills: agent.skills,
          },
        });
      }
      await retire();
    },
  };
}
