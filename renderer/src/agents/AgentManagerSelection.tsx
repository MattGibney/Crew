import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import type { AgentsSnapshot } from "./client";
type Command = <T>(name: string, args: unknown) => Promise<T>;
export function AgentManagerSelection({
  snapshot,
  command,
  refresh,
  onNotify,
}: {
  snapshot: AgentsSnapshot;
  command: Command;
  refresh(): Promise<void>;
  onNotify(message: string): void;
}) {
  const savedId =
    snapshot.projectSettings?.contactAgentId ??
    snapshot.projectSettings?.primaryAgentId ??
    snapshot.primaryAgentId ??
    null;
  const revision = snapshot.projectSettings?.revision;
  const [draft, setDraft] = useState<{
    id: string;
    revision: number | undefined;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const selectedId = draft?.id ?? savedId ?? "";
  const stale = draft !== null && draft.revision !== revision;
  const agents = snapshot.agents.filter((agent) => !agent.archivedAt);
  const save = async () => {
    if (busy || !draft || !revision || stale) return;
    const submitted = draft;
    setBusy(true);
    setError("");
    let acknowledged = false;
    try {
      await command("setContactAgent", {
        agentId: submitted.id,
        expectedRevision: submitted.revision,
      });
      acknowledged = true;
      setDraft((current) => (current === submitted ? null : current));
      await refresh();
      onNotify("Contact saved. Existing sessions are unchanged.");
    } catch (cause) {
      setError(
        acknowledged
          ? "Contact saved. The view could not be refreshed; refresh agents to see the current saved choice."
          : cause instanceof Error
            ? cause.message
            : "The contact could not be selected. Refresh to check the saved choice before trying again.",
      );
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-4 border-b py-6">
      <div>
        <h2 className="font-semibold tracking-tight">Current contact</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Choose whose conversation, voice, browser and notes to open.
          Disconnect any current voice call before switching. Selecting starts
          no work.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <Label htmlFor="manager-setting">Agent</Label>
          <NativeSelect
            id="manager-setting"
            value={selectedId}
            disabled={busy || !agents.length}
            onChange={(event) =>
              setDraft(
                event.target.value === savedId
                  ? null
                  : { id: event.target.value, revision },
              )
            }
          >
            <option value="">Choose an agent</option>
            {agents.map((agent) => (
              <option
                key={agent.id}
                value={agent.id}
                disabled={provisioningProblem(snapshot, agent.id)}
              >
                {agent.profile.name}
                {provisioningProblem(snapshot, agent.id)
                  ? " (setup needs attention)"
                  : ""}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button
          disabled={busy || !draft || !selectedId || stale || !revision}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save choice"}
        </Button>
      </div>
      {!agents.length && (
        <p className="text-sm text-muted-foreground">
          Create an agent below, then choose it as your contact.
        </p>
      )}
      {stale && (
        <p role="alert" className="text-sm text-destructive">
          The contact choice changed elsewhere.{" "}
          <button
            type="button"
            className="underline"
            onClick={() => setDraft(null)}
          >
            Reload the saved choice
          </button>{" "}
          before saving.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

function provisioningProblem(snapshot: AgentsSnapshot, agentId: string) {
  return (
    (
      snapshot as AgentsSnapshot & {
        provisioning?: { agentId: string; state: string }[];
      }
    ).provisioning?.some(
      (row) => row.agentId === agentId && row.state !== "ready",
    ) ?? false
  );
}
