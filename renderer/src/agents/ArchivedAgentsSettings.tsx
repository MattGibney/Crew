import { useEffect, useRef, useState } from "react";
import { Archive, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
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
  const [deleteError, setDeleteError] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const archived = agents.filter((agent) => Boolean(agent.archivedAt));
  useEffect(() => {
    if (confirmId && !archived.some((agent) => agent.id === confirmId))
      setConfirmId(null);
  }, [agents, confirmId]);
  if (!archived.length)
    return (
      <div className="py-12 text-center">
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
    <div className="space-y-6 pb-8">
      <p className="text-sm leading-6 text-muted-foreground">
        Restoring keeps the same identity and chat references. The agent stays
        stopped until you start it.
      </p>
      <div className="overflow-x-auto rounded-xl border">
        <Table
          className="w-full text-left text-sm"
          aria-label="Archived agents"
        >
          <TableHeader className="border-b bg-muted/40 text-muted-foreground">
            <TableRow>
              <TableHead scope="col" className="px-4 py-3 font-medium">
                Name
              </TableHead>
              <TableHead scope="col" className="px-4 py-3 font-medium">
                ID
              </TableHead>
              <TableHead scope="col" className="px-4 py-3 font-medium">
                Last used
              </TableHead>
              <TableHead scope="col" className="px-4 py-3 font-medium">
                Actions
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="divide-y">
            {archived.map((agent) => {
              const busy =
                pending.has(`restore-${agent.id}`) ||
                pending.has(`delete-${agent.id}`) ||
                deletingId === agent.id;
              return (
                <TableRow key={agent.id}>
                  <TableHead
                    scope="row"
                    className="px-4 py-4 align-top font-medium"
                  >
                    {agent.profile.name}
                  </TableHead>
                  <TableCell className="whitespace-normal px-4 py-4 align-top">
                    <code className="break-all text-xs">{agent.id}</code>
                  </TableCell>
                  <TableCell className="whitespace-nowrap px-4 py-4 align-top">
                    {lastUsed(agent)}
                  </TableCell>
                  <TableCell className="min-w-64 whitespace-normal px-4 py-4 align-top">
                    <AlertDialog
                      open={confirmId === agent.id}
                      onOpenChange={(open) => {
                        if (busy) return;
                        setDeleteError("");
                        setConfirmId(open ? agent.id : null);
                      }}
                    >
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
                        <AlertDialogTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-destructive"
                            />
                          }
                          disabled={busy || !client.deleteAgent}
                        >
                          <Trash2 aria-hidden="true" />
                          Permanently delete
                        </AlertDialogTrigger>
                      </div>
                      <AlertDialogContent size="sm" initialFocus={cancel}>
                        <AlertDialogHeader>
                          <AlertDialogMedia className="bg-destructive/10 text-destructive dark:bg-destructive/20">
                            <Trash2 aria-hidden="true" />
                          </AlertDialogMedia>
                          <AlertDialogTitle>
                            Permanently delete {agent.profile.name}?
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            Permanently delete {agent.profile.name}’s local
                            agent folder and record? This cannot be undone.
                            Shared work history, native chat archives, recovery
                            snapshots, resources and external accounts are
                            retained.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        {deleteError && (
                          <p role="alert" className="text-sm text-destructive">
                            {deleteError}
                          </p>
                        )}
                        <AlertDialogFooter>
                          <AlertDialogCancel ref={cancel} disabled={busy}>
                            Cancel
                          </AlertDialogCancel>
                          <AlertDialogAction
                            variant="destructive"
                            disabled={busy || !client.deleteAgent}
                            onClick={async () => {
                              setDeletingId(agent.id);
                              setDeleteError("");
                              let detail = "";
                              try {
                                const deleted = await act(
                                  `delete-${agent.id}`,
                                  async () => {
                                    try {
                                      return await client.deleteAgent!(
                                        agent.id,
                                      );
                                    } catch (cause) {
                                      detail =
                                        cause instanceof Error
                                          ? cause.message
                                          : String(cause);
                                      throw cause;
                                    }
                                  },
                                  "Agent permanently deleted.",
                                );
                                if (deleted) setConfirmId(null);
                                else
                                  setDeleteError(
                                    detail ||
                                      "The agent could not be deleted. Review the error and try again.",
                                  );
                              } finally {
                                setDeletingId(null);
                              }
                            }}
                          >
                            {deletingId === agent.id
                              ? "Deleting…"
                              : "Delete permanently"}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
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
