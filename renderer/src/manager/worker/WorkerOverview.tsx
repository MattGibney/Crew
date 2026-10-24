import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "../../components/ui/collapsible.js";
import { WorkerReference } from "./WorkerReference.js";
import {
  workLinkLabel,
  workReference,
} from "../../../../src/shared/tracking.mjs";
import { WorkerWorkHistory } from "./WorkerWorkHistory.js";
import type { ManagerProps, WorkerTask } from "../../contracts/manager.js";
import { Clock3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { WorkerStatus } from "../WorkerAttention.js";
import { errorText } from "../api.js";
import {
  currentAssignment,
  canDiscussFollowup,
  workerFollowupRequest,
  workerProgress,
  workerActions,
  workerRecoveryReviewRequest,
  workerTiming,
  workerStatus,
  formatElapsed,
} from "../worker-model.js";
import type { useWorkerActions } from "./useWorkerActions.js";
export function WorkerOverview({
  task,
  manager,
  onManager,
  actions,
  timing,
}: ManagerProps & {
  task: WorkerTask;
  onManager: () => void;
  actions: ReturnType<typeof useWorkerActions>;
  timing: ReturnType<typeof workerTiming>;
}) {
  const {
    actionBusy,
    setActionBusy,
    setActionError,
    confirmRemove,
    setConfirmRemove,
    act,
  } = actions;
  const assignment = currentAssignment(task);
  const reference = workReference(assignment, task.id);
  const managerBusy =
    actionBusy ||
    !manager.managerEnabled ||
    !manager.prepared ||
    !manager.eventReady;
  return (
    <div className="space-y-6">
      <div className="rounded-xl border bg-card p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <WorkerReference
                assignment={assignment}
                fallback={task.id}
                className="text-xs font-medium text-muted-foreground"
              />
              <WorkerStatus task={task} />
              <Badge variant="outline" className="text-[10px]">
                Read-only history
              </Badge>
            </div>
            <h2 className="break-words text-xl font-semibold tracking-tight">
              {assignment.brief?.trim().split("\n")[0] || "Worker task"}
            </h2>
            <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
              {workerProgress(task)}
            </p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          <span aria-label={`Execution: ${workerStatus(task)}`}>
            Execution: {workerStatus(task)}
          </span>
          <span>
            {timing.live === true
              ? "Process live"
              : timing.live === false
                ? "Process ended"
                : "Process liveness unverified"}
          </span>
          <span className="flex items-center gap-1">
            <Clock3 className="size-3" />
            {timing.elapsed === null
              ? "Execution timing unavailable"
              : `${formatElapsed(timing.elapsed)} elapsed`}
          </span>
          <span className="truncate" title={task.id}>
            Task {task.id}
          </span>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          {reference.link ? (
            <a href={reference.link.url} target="_blank" rel="noreferrer">
              {reference.link.provider === "github"
                ? "GitHub issue"
                : "Linear issue"}
              : {workLinkLabel(reference.link)}
            </a>
          ) : reference.label !== task.id ? (
            "Legacy work label — external identity/access unverified"
          ) : (
            "Local task · No external tracker"
          )}
        </p>
        {task.archiveRestoration?.requiresRecovery && (
          <p className="mt-3 rounded-lg border p-3 text-xs leading-5 text-muted-foreground">
            History restored only. Restore has not recreated this worker’s
            worktree or environment. Discuss any recreation with your manager
            before assigning more work.
          </p>
        )}
        {task.modelSelection && (
          <div
            aria-label="Worker model"
            className="mt-3 rounded-lg border bg-muted/20 p-3 text-xs leading-5"
          >
            <p>
              Requested model:{" "}
              <span className="font-medium text-foreground">
                {task.modelSelection.model}
              </span>
            </p>
            <p>
              Model change:{" "}
              {task.modelSelection.status === "selected"
                ? "Selected by native worker"
                : task.modelSelection.status === "rerouted"
                  ? "Rerouted by native provider — review with manager"
                  : task.modelSelection.status === "failed"
                    ? "Failed — review with manager"
                    : "Pending native validation"}
            </p>
            <p>
              Selected model for{" "}
              {task.modelSelection.runtime?.runId || "next run"}:{" "}
              {["selected", "rerouted"].includes(
                task.modelSelection.runtime?.status || "",
              )
                ? task.modelSelection.runtime?.selectedModel
                : "Not yet verified"}
            </p>
            <p className="text-muted-foreground">
              {task.modelSelection.message}
            </p>
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={onManager}
          >
            Discuss with manager
          </Button>
          {canDiscussFollowup(task) && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={managerBusy}
              onClick={async () => {
                setActionBusy(true);
                setActionError("");
                try {
                  await manager.sendMessage(workerFollowupRequest(task));
                  onManager();
                } catch (failure) {
                  setActionError(errorText(failure));
                } finally {
                  setActionBusy(false);
                }
              }}
            >
              Send direction
            </Button>
          )}
          {workerActions(task).map((action) => (
            <Button
              key={action}
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              disabled={
                actionBusy ||
                manager.sending ||
                Boolean(manager.work.activeTurnId) ||
                !manager.managerEnabled ||
                !manager.prepared ||
                !manager.eventReady
              }
              onClick={() =>
                action === "dispose" ? setConfirmRemove(true) : void act(action)
              }
            >
              {
                {
                  pause: "Pause",
                  stop: "Stop",
                  resume: "Resume",
                  dispose: "Archive",
                }[action]
              }
            </Button>
          ))}
        </div>
        {!task.archiveRestoration?.requiresRecovery &&
          task.worktree &&
          ["failed", "blocked"].includes(task.status) &&
          !task.lifecycleRequests?.some((request) =>
            ["pending", "processing"].includes(request.status),
          ) && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                disabled={
                  actionBusy ||
                  manager.sending ||
                  Boolean(manager.work.activeTurnId) ||
                  !manager.managerEnabled ||
                  !manager.prepared ||
                  !manager.eventReady
                }
                onClick={async () => {
                  setActionBusy(true);
                  setActionError("");
                  try {
                    await manager.sendMessage(
                      workerRecoveryReviewRequest(task),
                    );
                    onManager();
                  } catch (failure) {
                    setActionError(errorText(failure));
                  } finally {
                    setActionBusy(false);
                  }
                }}
              >
                Review recovery
              </Button>
              <span className="text-xs text-muted-foreground">
                Inspect worker or environment recovery with your manager.
              </span>
            </div>
          )}
        {confirmRemove && (
          <div className="mt-3 rounded-lg border p-3 text-xs">
            <p>
              Ask your manager to archive this worker? Its environment will be
              torn down safely before it moves to Archived workers. Dirty or
              unresolved work is protected; history is kept.
            </p>
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                variant="destructive"
                disabled={actionBusy}
                onClick={() => void act("dispose")}
              >
                Archive safely
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirmRemove(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
      <WorkerWorkHistory task={task} />
      <dl className="space-y-4 rounded-xl border p-5 text-xs">
        {[
          ["Project", task.projectId],
          ["Repository", task.repositoryId],
          ["Worktree", task.worktree],
          [
            "Work linkage",
            reference.link
              ? workLinkLabel(reference.link)
              : reference.label === task.id
                ? "No external tracker"
                : reference.label,
          ],
          ["Run", task.runId],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="font-medium">{label}</dt>
            <dd className="mt-1 break-all text-muted-foreground">
              {value || "Not recorded"}
            </dd>
          </div>
        ))}
        <div>
          <dt className="font-medium">Agreed assignment</dt>
          <dd className="mt-2 whitespace-pre-wrap break-words text-muted-foreground">
            {assignment.brief}
          </dd>
        </div>
        {task.workerPromptSnapshot?.text && (
          <div>
            <dt className="font-medium">Original worker instructions</dt>
            <dd>
              <Collapsible className="mt-2">
                <CollapsibleTrigger className="text-left cursor-pointer text-muted-foreground">
                  Retained snapshot ·{" "}
                  {task.workerPromptSnapshot.version?.slice(0, 10) ||
                    "Version unavailable"}
                </CollapsibleTrigger>
                <CollapsibleContent keepMounted>
                  <pre className="mt-3 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-4 text-xs">
                    {task.workerPromptSnapshot.text}
                  </pre>
                </CollapsibleContent>
              </Collapsible>
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}
