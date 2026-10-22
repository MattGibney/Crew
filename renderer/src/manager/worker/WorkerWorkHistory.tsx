import type { WorkerTask } from "../../contracts/manager.js";
import { workerWorkflow, queuedAssignments } from "../worker-model.js";
import { Markdown } from "./WorkerExchange.js";
/** Observable project workflow and retained direction history, separate from process/lifecycle controls. */
export function WorkerWorkHistory({ task }: { task: WorkerTask }) {
  const queued = queuedAssignments(task);
  return (
    <>
      {" "}
      <section aria-label="Workflow" className="rounded-xl border p-5">
        <h2 className="text-sm font-semibold">Workflow</h2>
        <p className="mt-2 break-words text-sm">
          {workerWorkflow(task) || "No workflow state has been set."}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Workflow is recorded by your manager or worker. Execution and native
          approvals are shown separately.
        </p>
        {(task.workflowHistory?.length || 0) > 0 && (
          <details className="mt-3 text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              Workflow history
            </summary>
            <ol className="mt-3 space-y-3">
              {task.workflowHistory?.map((item, index) => (
                <li key={item.requestId || index} className="break-words">
                  <p className="font-medium">{item.value}</p>
                  <p className="mt-1 text-muted-foreground">
                    {item.actor === "worker" ? "Worker" : "Manager"}
                    {item.at && (
                      <>
                        {" "}
                        ·{" "}
                        <time dateTime={item.at}>
                          {new Date(item.at).toLocaleString()}
                        </time>
                      </>
                    )}
                  </p>
                </li>
              ))}
            </ol>
          </details>
        )}
      </section>
      {queued.length > 0 && (
        <section
          aria-label="Queued assignments"
          className="rounded-xl border p-5"
        >
          <h2 className="text-sm font-semibold">
            Queued follow-ups ({queued.length})
          </h2>
          <p className="mt-2 text-xs text-muted-foreground">
            {task.followupWait || "Direction queued for native delivery."}
          </p>
          <ol className="mt-3 space-y-3">
            {queued.map((item) => (
              <li key={item.id} className="text-sm">
                <p className="font-medium">{item.ticket}</p>
                <p className="whitespace-pre-wrap break-words text-muted-foreground">
                  {item.brief}
                </p>
              </li>
            ))}
          </ol>
        </section>
      )}
      {(task.assignments || []).some(
        (item) =>
          item.id !== task.currentAssignmentId && item.status !== "queued",
      ) && (
        <section
          aria-label="Assignment history"
          className="rounded-xl border p-5"
        >
          <h2 className="text-sm font-semibold">Previous assignments</h2>
          <div className="mt-3 space-y-3">
            {task.assignments
              ?.filter(
                (item) =>
                  item.id !== task.currentAssignmentId &&
                  item.status !== "queued",
              )
              .map((item) => (
                <details
                  key={item.id}
                  className="rounded-lg border p-3 text-xs"
                >
                  <summary className="cursor-pointer">
                    <span className="font-medium">
                      {item.ticket} · {item.brief?.trim().split("\n")[0]}
                    </span>
                    <span className="ml-2 text-muted-foreground">
                      {item.status === "completed" ? "Turn ended" : item.status}
                    </span>
                  </summary>
                  <div className="mt-3 space-y-3">
                    <p className="whitespace-pre-wrap break-words text-muted-foreground">
                      {item.brief}
                    </p>
                    {item.result?.message && (
                      <Markdown>{item.result.message}</Markdown>
                    )}
                    <p className="break-all text-muted-foreground">
                      Assignment {item.id}
                      {item.runIds?.length
                        ? ` · Runs ${item.runIds.join(", ")}`
                        : ""}
                    </p>
                  </div>
                </details>
              ))}
          </div>
        </section>
      )}
    </>
  );
}
