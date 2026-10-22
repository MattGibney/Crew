import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Message } from "../manager/Message";
import type { Agent } from "../../../src/agents/contracts.mjs";
import type { VoiceTranscriptArtifact } from "../../../src/agents/voice-artifacts.mjs";
import type { AgentsClient } from "./client";

/** Owner-readable call artifacts. Never converted into native chat turns. */
export function SavedVoiceArtifacts({
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
          throw new Error(
            "Saved voice transcripts are unavailable in this host.",
          );
        const result = await client.readVoiceArtifacts(
          agent.id,
          older ? nextCursor.current! : undefined,
        );
        if (request !== generation.current) return;
        if (result.state === "failed") throw new Error(result.error.message);
        if (older && result.value.nextCursor === nextCursor.current)
          throw new Error("Saved voice history returned a repeated page.");
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
              : "Saved voice transcripts are unavailable.",
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
    [agent.id, client],
  );
  useEffect(
    () => () => {
      generation.current++;
      busy.current = false;
      queued.current = false;
    },
    [load],
  );
  useEffect(() => {
    if (visible) void load();
    else queued.current = false;
  }, [load, revision, visible]);
  const saved = artifacts.filter((call) => call.state !== "active");
  const active = artifacts.some((call) => call.state === "active");
  return (
    <section aria-label="Saved voice calls" className="space-y-5 border-t pt-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Saved voice calls</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Transcripts saved by Crew from native voice items, separately from
            the agent's chat history.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={loading}
          onClick={() => void load()}
        >
          Refresh voice history
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
          {artifacts.length > 0
            ? " Showing the last loaded voice calls; they may be stale."
            : ""}
        </p>
      )}
      {warning && (
        <p role="alert" className="text-sm text-destructive">
          {warning}
        </p>
      )}
      {loading && !artifacts.length && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading saved voice calls…
        </p>
      )}
      {!loading && !error && !saved.length && (
        <p className="text-sm text-muted-foreground">
          {active
            ? "The live call is being saved. Its transcript appears here when the call ends."
            : "No saved voice calls yet. Transcripts from before voice saving was available cannot currently be recovered."}
        </p>
      )}
      {cursor && (
        <Button
          variant="outline"
          size="sm"
          disabled={loading}
          onClick={() => void load(true)}
        >
          Load earlier voice calls
        </Button>
      )}
      {saved.map((call) => (
        <section
          key={call.id}
          aria-label="Saved voice transcript"
          className="space-y-5 rounded-lg border p-4"
        >
          <div className="text-xs text-muted-foreground">
            <p>
              Voice call · {new Date(call.createdAt).toLocaleString()}
              {call.state === "interrupted"
                ? " · Interrupted; the final words may be missing"
                : ""}
            </p>
            {call.items.some((item) => !item.done) && (
              <p className="mt-1">Some transcript segments are incomplete.</p>
            )}
          </div>
          {call.items
            .filter((item) => item.text.length > 0)
            .map((item) => (
              <Message
                key={item.itemId}
                message={{
                  id: `${call.id}:${item.itemId}`,
                  role: item.role,
                  text: item.text,
                  source: "voice",
                  status: item.done ? "complete" : "partial",
                }}
                label={
                  item.role === "user"
                    ? "You · saved voice"
                    : `${agent.profile.name} · saved voice`
                }
                ariaLabel={
                  item.role === "user"
                    ? "Your saved voice transcript"
                    : "Assistant saved voice transcript"
                }
                copyable
              />
            ))}
          <details className="text-xs text-muted-foreground">
            <summary>Transcript source</summary>
            <p className="mt-2 break-all">
              Call artifact {call.id}. Native chat {call.threadId}. This
              artifact does not establish a coding-turn association or change
              model context.
            </p>
          </details>
        </section>
      ))}
    </section>
  );
}
