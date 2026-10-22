interface ArchiveRequest {
  taskId: string;
  action: "restore" | "delete";
  expectedRevision?: number;
  operationId: string;
}
import { useState, useRef } from "react";

import type { ManagerProps, WorkerTask } from "../../contracts/manager.js";
import { Button } from "@/components/ui/button";

import { api, errorText } from "../api.js";
import { archivedWorkers } from "../worker-model.js";
import { archiveTime } from "../../../../src/shared/worker-archive.mjs";
export function ArchivedWorkers({ manager }: ManagerProps) {
  const [confirmation, setConfirmation] = useState<ArchiveRequest | null>(null);
  const [busy, setBusy] = useState<string | null>(null),
    [error, setError] = useState("");
  const retry = useRef<ArchiveRequest | null>(null);
  const projectId = manager.settings?.projectId || manager.projectInfo?.id;
  const tasks = archivedWorkers(
    manager.orchestration.tasks || [],
    projectId,
    manager.projectInfo?.mode,
  );
  const act = async (
    task: WorkerTask,
    action: "restore" | "delete",
    selection?: ArchiveRequest,
  ) => {
    const request =
      selection ||
      (retry.current?.taskId === task.id &&
      retry.current?.action === action &&
      retry.current?.expectedRevision === task.revision
        ? retry.current
        : {
            taskId: task.id,
            action,
            expectedRevision: task.revision,
            operationId: `archive-${crypto.randomUUID()}`,
          });
    retry.current = request;
    setBusy(task.id);
    setError("");
    try {
      await api("archived-worker-action", request);
      retry.current = null;
      setConfirmation(null);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section aria-label="Archived worker list" className="border-t">
      {(error || manager.orchestration.error) && (
        <p role="alert" className="py-4 text-sm text-destructive">
          {error || manager.orchestration.error}
        </p>
      )}
      {tasks.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th scope="col" className="py-3 pr-4 font-medium">
                  Worker
                </th>
                <th scope="col" className="py-3 pr-4 font-medium">
                  Status
                </th>
                <th scope="col" className="py-3 pr-4 font-medium">
                  Archived
                </th>
                <th scope="col" className="py-3 text-right font-medium">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => {
                const at = archiveTime(task);
                return (
                  <tr
                    key={task.id}
                    data-archived-worker-id={task.id}
                    className="border-b align-top"
                  >
                    <td className="py-4 pr-4">
                      <p className="text-xs text-muted-foreground">
                        {task.ticket || task.id}
                      </p>
                      <p className="mt-1 font-medium">
                        {task.brief?.trim().split("\n")[0] || "Worker task"}
                      </p>
                    </td>
                    <td className="py-4 pr-4 text-muted-foreground">
                      {task.status} · Resources retained unless explicitly
                      deleted
                    </td>
                    <td className="py-4 pr-4 text-xs text-muted-foreground">
                      {at ? (
                        <time dateTime={at}>
                          {new Date(at).toLocaleString()}
                        </time>
                      ) : (
                        "Time unavailable"
                      )}
                    </td>
                    <td className="py-4 text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={Boolean(busy)}
                          onClick={() => void act(task, "restore")}
                        >
                          Restore
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={Boolean(busy)}
                          onClick={() => {
                            setError("");
                            setConfirmation({
                              taskId: task.id,
                              action: "delete",
                              expectedRevision: task.revision,
                              operationId: `archive-${crypto.randomUUID()}`,
                            });
                          }}
                        >
                          Delete permanently
                        </Button>
                      </div>
                      {confirmation?.taskId === task.id && (
                        <div className="mt-3 max-w-sm rounded-lg border p-3 text-left text-xs">
                          <p>
                            Permanently delete this worker’s saved Crew history,
                            results, notes and execution evidence? This cannot
                            be undone. Environment files are separate and are
                            not deleted here.
                          </p>
                          <div className="mt-3 flex gap-2">
                            <Button
                              variant="destructive"
                              size="sm"
                              disabled={Boolean(busy)}
                              onClick={() =>
                                void act(task, "delete", confirmation)
                              }
                            >
                              {busy === task.id
                                ? "Deleting…"
                                : "Delete permanently"}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={Boolean(busy)}
                              onClick={() => setConfirmation(null)}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="py-8 text-sm text-muted-foreground">
          {projectId
            ? "No archived workers for this project."
            : "Loading project archive…"}
        </p>
      )}
    </section>
  );
}
