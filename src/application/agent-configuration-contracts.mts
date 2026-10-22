/** Owner-only editor projection. Existing profile/access/runtime authorities
 * remain canonical; catalogue reads never start sessions or calls. */
export interface AgentConfigurationOptions {
  runtime: {
    provider: "codex";
    modelAccessId: string;
    configRef: string;
    label: string;
  };
  voices: {
    state: "available" | "unavailable";
    values: { id: string; name: string }[];
    defaultVoice: string | null;
    observedAt: string | null;
  };
}

export interface AgentConfigurationRequests {
  "agents.options": Record<string, never>;
}
