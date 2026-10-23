import { useCallback, useEffect, useRef, useState } from "react";
import type { Agent } from "../../../src/agents/contracts.mjs";
import type { VoiceTranscriptArtifact } from "../../../src/agents/voice-artifacts.mjs";
import type { AgentsClient } from "./client";

/** Owner-readable call artifacts. Never converted into native chat turns. */
export function useVoiceArtifacts({
  agent,
  client,
  revision,
  visible,
}: {
  agent: Agent;
  client: AgentsClient;
  revision: number;
  visible: boolean;
}) {
  const [artifacts, setArtifacts] = useState<VoiceTranscriptArtifact[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState<string | null>(null);
  const generation = useRef(0),
    busy = useRef(false),
    queued = useRef(false);
  const earlier = useRef(false),
    nextCursor = useRef<string | null>(null);
  const load = useCallback(
    async function read(older = false): Promise<void> {
      if (busy.current) {
        if (!older) queued.current = true;
        return;
      }
      if (older && !nextCursor.current) return;
      busy.current = true;
      const request = generation.current;
      setLoading(true);
      setError("");
      try {
        if (!client.readVoiceArtifacts)
          throw new Error("Voice transcripts are unavailable in this host.");
        const result = await client.readVoiceArtifacts(
          agent.id,
          older ? nextCursor.current! : undefined,
        );
        if (request !== generation.current) return;
        if (result.state === "failed") throw new Error(result.error.message);
        if (older && result.value.nextCursor === nextCursor.current)
          throw new Error("Voice history returned a repeated page.");
        if (older) earlier.current = true;
        if (older || !earlier.current) {
          nextCursor.current = result.value.nextCursor;
          setCursor(result.value.nextCursor);
        }
        setArtifacts((current) =>
          [
            ...new Map(
              [...current, ...result.value.artifacts].map((call) => [
                call.id,
                call,
              ]),
            ).values(),
          ].sort(
            (a, b) =>
              a.createdAt.localeCompare(b.createdAt) ||
              a.id.localeCompare(b.id),
          ),
        );
        setWarning(result.value.warning);
      } catch (cause) {
        if (request === generation.current)
          setError(
            cause instanceof Error
              ? cause.message
              : "Voice transcripts are unavailable.",
          );
      } finally {
        if (request === generation.current) {
          busy.current = false;
          setLoading(false);
          if (queued.current) {
            queued.current = false;
            void read();
          }
        }
      }
    },
    [agent.id, agent.runtime.threadId, client],
  );
  useEffect(() => {
    setArtifacts([]);
    setCursor(null);
    setError("");
    setWarning(null);
    setLoading(false);
    earlier.current = false;
    nextCursor.current = null;
    return () => {
      generation.current++;
      busy.current = false;
      queued.current = false;
    };
  }, [load]);
  useEffect(() => {
    if (visible) void load();
    else queued.current = false;
  }, [load, revision, visible]);
  return {
    artifacts,
    cursor,
    loading,
    error,
    warning,
    refresh: load,
    loadEarlier: () => load(true),
  };
}
