import { useEffect, useState } from "react";
import { Archive, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Agent } from "../../../src/agents/contracts.mjs";
import type { AgentsClient } from "./client";

type Action = (
  key: string,
  operation: () => Promise<unknown>,
  success?: string,
) => Promise<boolean>;

/** Archival is reversible. Deletion is available only here and needs a second action. */
export function ArchivedAgentsSettings({
  agents,
  client,
  pending,
  act,
}: {
  agents: Agent[];
  client: AgentsClient;
  pending: Set<string>;
  act: Action;
}) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const archived = agents.filter((agent) => Boolean(agent.archivedAt));
  useEffect(() => {
    if (confirmId && !archived.some((agent) => agent.id === confirmId))
      setConfirmId(null);
  }, [agents, confirmId]);
  if (!archived.length)
    return (
      <div className="rounded-xl border border-dashed px-6 py-12 text-center">
        <Archive
          className="mx-auto mb-3 size-6 text-muted-foreground"
          aria-hidden="true"
        />
        <p className="text-sm font-medium">No archived agents</p>
        <p className="mt-2 text-sm text-muted-foreground">
          Agents you archive appear here. Archiving keeps their records for
          later restoration.
        </p>
      </div>
    );
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Restoring keeps the same identity and chat references. The agent stays
        stopped until you start it.
      </p>
      <div className="overflow-x-auto rounded-xl border">
        <table
          className="w-full text-left text-sm"
          aria-label="Archived agents"
        >
          <thead className="border-b bg-muted/40 text-muted-foreground">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">
                Name
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                ID
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Last used
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {archived.map((agent) => {
              const busy =
                pending.has(`restore-${agent.id}`) ||
                pending.has(`delete-${agent.id}`);
              return (
                <tr key={agent.id}>
                  <th scope="row" className="px-4 py-4 align-top font-medium">
                    {agent.profile.name}
                  </th>
                  <td className="px-4 py-4 align-top">
                    <code className="break-all text-xs">{agent.id}</code>
                  </td>
                  <td className="whitespace-nowrap px-4 py-4 align-top">
                    {lastUsed(agent)}
                  </td>
                  <td className="min-w-64 px-4 py-4 align-top">
                    {confirmId === agent.id ? (
                      <div
                        className="space-y-3"
                        role="group"
                        aria-label={`Confirm permanent deletion of ${agent.profile.name}`}
                      >
                        <p className="max-w-sm text-sm">
                          Permanently delete {agent.profile.name}’s local agent
                          folder and record? This cannot be undone. Shared work
                          history, native chat archives, recovery snapshots,
                          resources and external accounts are retained.
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="destructive"
                            size="sm"
                            disabled={busy || !client.deleteAgent}
                            onClick={async () => {
                              if (
                                await act(
                                  `delete-${agent.id}`,
                                  () => client.deleteAgent!(agent.id),
                                  "Agent permanently deleted.",
                                )
                              )
                                setConfirmId(null);
                            }}
                          >
                            Delete permanently
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() => setConfirmId(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy || !client.restoreAgent}
                          onClick={() =>
                            void act(
                              `restore-${agent.id}`,
                              () => client.restoreAgent!(agent.id),
                              "Agent restored. Start it when you are ready.",
                            )
                          }
                        >
                          <RotateCcw aria-hidden="true" />
                          Restore
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive"
                          disabled={busy || !client.deleteAgent}
                          onClick={() => setConfirmId(agent.id)}
                        >
                          <Trash2 aria-hidden="true" />
                          Permanently delete
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function lastUsed(agent: Agent): string {
  if (agent.lastUsedAt === undefined) return "Unknown";
  if (agent.lastUsedAt === null) return "Never used";
  const timestamp = Date.parse(agent.lastUsedAt);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleString()
    : "Unknown";
}
