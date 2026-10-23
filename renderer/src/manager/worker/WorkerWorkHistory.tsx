import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "../../components/ui/collapsible.js";
import { workReference } from "../../../../src/shared/tracking.mjs";
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
          <Collapsible className="mt-3 text-xs">
            <CollapsibleTrigger className="text-left cursor-pointer text-muted-foreground">
              Workflow history
            </CollapsibleTrigger>
            <CollapsibleContent keepMounted>
              <ol className="mt-3 space-y-3">
                {task.workflowHistory?.map((item, index) => (
                  <li key={item.requestId || index} className="break-words">
                    <p className="font-medium">{item.value}</p>
                    {typeof item.progressPercent === "number" && (
                      <p className="mt-1 text-muted-foreground">
                        Reported estimate: {item.progressPercent}%
                      </p>
                    )}
                    {item.progressPercent === null && (
                      <p className="mt-1 text-muted-foreground">
                        Progress estimate unset
                      </p>
                    )}
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
            </CollapsibleContent>
          </Collapsible>
        )}
      </section>
      {queued.length > 0 && (
        <section
          aria-label="Pending directions"
          className="rounded-xl border p-5"
        >
          <h2 className="text-sm font-semibold">
            Pending directions ({queued.length})
          </h2>
          <p className="mt-2 text-xs text-muted-foreground">
            {task.followupWait ||
              "Waiting for native delivery. Active turns receive steering promptly."}
          </p>
          <ol className="mt-3 space-y-3">
            {queued.map((item) => (
              <li key={item.id} className="text-sm">
                <p className="font-medium">{item.ticket}</p>
                <p className="text-xs text-muted-foreground">
                  Native delivery:{" "}
                  {item.delivery?.state === "attempted"
                    ? "awaiting acknowledgement"
                    : item.delivery?.state || "pending"}
                  {item.delivery?.error && ` · ${item.delivery.error}`}
                </p>
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
          <h2 className="text-sm font-semibold">
            Direction and assignment history
          </h2>
          <div className="mt-3 space-y-3">
            {task.assignments
              ?.filter(
                (item) =>
                  item.id !== task.currentAssignmentId &&
                  item.status !== "queued",
              )
              .map((item) => (
                <Collapsible
                  key={item.id}
                  className="rounded-lg border p-3 text-xs"
                >
                  <CollapsibleTrigger className="text-left cursor-pointer">
                    <span className="font-medium">
                      {workReference(item, "Local assignment").context} ·{" "}
                      {item.brief?.trim().split("\n")[0]}
                    </span>
                    <span className="ml-2 text-muted-foreground">
                      {item.status === "completed"
                        ? "Turn ended"
                        : item.status === "steered"
                          ? "Native steering acknowledged"
                          : item.status}
                    </span>
                  </CollapsibleTrigger>
                  <CollapsibleContent keepMounted>
                    <div className="mt-3 space-y-3">
                      <p className="whitespace-pre-wrap break-words text-muted-foreground">
                        {item.brief}
                      </p>
                      {item.delivery?.state === "acknowledged" && (
                        <p className="text-muted-foreground">
                          Native input accepted in the existing turn. Worker
                          reports and conversation provide evidence of any
                          action taken.
                        </p>
                      )}
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
                  </CollapsibleContent>
                </Collapsible>
              ))}
          </div>
        </section>
      )}
    </>
  );
}
