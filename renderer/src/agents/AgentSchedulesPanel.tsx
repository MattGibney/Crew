import { useCallback, useEffect, useRef, useState } from "react";
import type { Agent } from "../../../src/agents/contracts.mjs";
import type {
  ManagerSchedule,
  ManagerSchedules as SavedSchedules,
} from "../contracts/manager";
import { ManagerSchedules } from "../manager/settings/ManagerSchedules";
import { NativeSelect } from "@/components/ui/native-select";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

/** Owner transport; the server validates project/agent identity and captured revision. */
export interface AgentSchedulesClient {
  read(agentId: string): Promise<SavedSchedules>;
  save(
    agentId: string,
    input: { expectedRevision: string; schedules: ManagerSchedule[] },
  ): Promise<SavedSchedules>;
}

/** Reuses the existing Settings editor. Each target retains its own draft when
 * selection changes; selecting another agent never redirects a pending save.
 */
export function AgentSchedulesPanel({
  client,
  agents,
  primaryAgentId,
  onNotify,
  visible = true,
}: {
  client: AgentSchedulesClient;
  agents: Agent[];
  primaryAgentId: string | null;
  onNotify: (message: string) => void;
  visible?: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(primaryAgentId);
  const [visited, setVisited] = useState<Set<string>>(
    () => new Set(primaryAgentId ? [primaryAgentId] : []),
  );
  useEffect(() => {
    if (!selectedId && primaryAgentId) {
      setSelectedId(primaryAgentId);
      setVisited((previous) => new Set([...previous, primaryAgentId]));
    }
  }, [selectedId, primaryAgentId]);
  const selected = agents.find((agent) => agent.id === selectedId);
  return (
    <div className="space-y-6">
      <div className="max-w-md space-y-2">
        <Label htmlFor="schedule-agent">Schedules for</Label>
        <NativeSelect
          id="schedule-agent"
          value={selectedId ?? ""}
          onChange={(event) => {
            const id = event.target.value;
            setSelectedId(id || null);
            if (id) setVisited((previous) => new Set([...previous, id]));
          }}
        >
          <option value="">Choose an agent</option>
          {agents
            .filter((agent) => !agent.archivedAt || agent.id === selectedId)
            .map((agent) => (
              <option
                key={agent.id}
                value={agent.id}
                disabled={Boolean(agent.archivedAt)}
              >
                {agent.profile.name}
                {agent.id === primaryAgentId ? " (manager)" : ""}
                {agent.archivedAt ? " (archived)" : ""}
              </option>
            ))}
          {selectedId && !selected && (
            <option value={selectedId} disabled>
              Unavailable agent
            </option>
          )}
        </NativeSelect>
      </div>
      {!selectedId && (
        <p className="text-sm text-muted-foreground">
          Choose whose schedules you want to review.
        </p>
      )}
      {selectedId && (!selected || selected.archivedAt) && (
        <p role="alert" className="text-sm text-destructive">
          This agent is unavailable. Any open edits are retained for this agent.
        </p>
      )}
      {[...visited].map((id) => {
        const agent = agents.find((item) => item.id === id);
        return (
          <div
            key={id}
            hidden={
              !visible ||
              selectedId !== id ||
              !agent ||
              Boolean(agent.archivedAt)
            }
          >
            <AgentScheduleEditor
              client={client}
              agentId={id}
              visible={
                visible &&
                selectedId === id &&
                Boolean(agent && !agent.archivedAt)
              }
              isPrimary={id === primaryAgentId}
              onNotify={onNotify}
            />
          </div>
        );
      })}
    </div>
  );
}

function AgentScheduleEditor({
  client,
  agentId,
  visible,
  isPrimary,
  onNotify,
}: {
  client: AgentSchedulesClient;
  agentId: string;
  visible: boolean;
  isPrimary: boolean;
  onNotify: (message: string) => void;
}) {
  const [saved, setSaved] = useState<SavedSchedules | undefined>();
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const alive = useRef(true);
  const reload = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const next = await client.read(agentId);
      if (alive.current && request === sequence.current) {
        setSaved(displaySchedules(next));
        setError("");
      }
    } catch {
      if (alive.current && request === sequence.current)
        setError("Schedules could not be loaded. Your edits are retained.");
    }
  }, [client, agentId]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      sequence.current++;
    };
  }, []);
  useEffect(() => {
    if (visible) void reload();
  }, [visible, reload]);
  const save = useCallback(
    async (schedules: ManagerSchedule[], expectedRevision: string) => {
      ++sequence.current;
      try {
        const next = await client.save(agentId, {
          expectedRevision,
          schedules,
        });
        if (alive.current) {
          setSaved(displaySchedules(next));
          setError("");
        }
        return { managerSchedules: displaySchedules(next) };
      } catch {
        await reload();
        throw new Error(
          "Schedules could not be saved. Check for changes elsewhere; your edits are retained.",
        );
      }
    },
    [client, agentId, reload],
  );
  return (
    <>
      {error && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 text-sm text-destructive"
        >
          <span>{error}</span>
          <Button variant="outline" size="sm" onClick={() => void reload()}>
            Retry
          </Button>
        </div>
      )}
      <ManagerSchedules
        manager={{
          settings: { managerSchedules: saved },
          loadSettings: reload,
          saveManagerSchedules: save,
        }}
        visible={visible}
        subject={isPrimary ? "manager" : "agent"}
        onNotify={onNotify}
      />
    </>
  );
}

function displaySchedules(value: SavedSchedules): SavedSchedules {
  // The reused engine reserves the old built-in ID, but unified schedules have
  // no implicit commitment-review workflow. Do not show legacy activation claims.
  return {
    ...value,
    schedules: value.schedules.map(
      ({ builtin: _builtin, ...schedule }) => schedule,
    ),
  };
}
