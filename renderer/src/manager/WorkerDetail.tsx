import { WorkerNotes } from "./worker/WorkerNotes.js";
import { WorkerLinks } from "./worker/WorkerLinks.js";
import { WorkerOverview } from "./worker/WorkerOverview.js";
import { WorkerExchange } from "./worker/WorkerExchange.js";
import { useWorkerActions } from "./worker/useWorkerActions.js";
import type { LucideIcon } from "lucide-react";
import type {
  ManagerProps,
  WorkerTask,
  WorkerDetailState,
} from "../contracts/manager.js";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  FileText,
  LayoutDashboard,
  Link2,
  LoaderCircle,
  MessageSquare,
} from "lucide-react";

import { Button } from "@/components/ui/button";

import { api, errorText } from "./api.js";
import { WorkerStatus } from "./WorkerAttention.js";

import {
  currentAssignment,
  pendingAttention,
  workerTiming,
} from "./worker-model.js";

export function WorkerDetail({
  task,
  manager,
  onBack,
  onManager,
}: ManagerProps & {
  task: WorkerTask;
  onBack: () => void;
  onManager: () => void;
}) {
  const [tab, setTab] = useState("conversation"),
    [detail, setDetail] = useState<WorkerDetailState | null>(null),
    [error, setError] = useState(""),
    [now, setNow] = useState(Date.now());
  const scroll = useRef<HTMLDivElement | null>(null),
    follow = useRef(true);
  useEffect(() => {
    let canceled = false,
      pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await api(
          `workers/${encodeURIComponent(task.id)}`,
          {},
          { method: "GET" },
        );
        if (!canceled) {
          setDetail(result);
          setError("");
        }
      } catch (failure) {
        if (!canceled) setError(errorText(failure));
      } finally {
        pending = false;
      }
    };
    setDetail(null);
    setTab("conversation");
    follow.current = true;
    void load();
    const timer = setInterval(() => {
      setNow(Date.now());
      void load();
    }, 2000);
    return () => {
      canceled = true;
      clearInterval(timer);
    };
  }, [task.id]);
  useEffect(() => {
    if (tab !== "conversation" && scroll.current) scroll.current.scrollTop = 0;
  }, [tab]);
  useEffect(() => {
    if (tab === "conversation" && follow.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [detail?.revision, detail?.conversation?.length, tab]);
  const actions = useWorkerActions(task, manager, onManager);
  const { actionError, actionBusy, setActionBusy, setActionError } = actions;
  const timing = workerTiming(task, now),
    attention = pendingAttention(task),
    assignment = currentAssignment(task);
  return (
    <section
      aria-label="Worker detail"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="shrink-0 border-b px-5 pb-0 pt-4 sm:px-8">
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 h-7 shrink-0 text-xs text-muted-foreground"
            onClick={onBack}
          >
            <ArrowLeft />
            Back to manager
          </Button>
          <span className="hidden h-4 border-l sm:block" aria-hidden="true" />
          <span className="shrink-0 text-xs text-muted-foreground">
            {assignment.ticket || task.id}
          </span>
          <h1
            className="min-w-0 flex-1 truncate text-sm font-semibold"
            title={assignment.brief?.trim().split("\n")[0]}
          >
            {assignment.brief?.trim().split("\n")[0] || "Worker task"}
          </h1>
          <WorkerStatus task={task} />
        </div>
        <div
          role="tablist"
          aria-label="Worker detail tabs"
          className="-mb-px mt-3 flex gap-4 overflow-x-auto sm:gap-5"
        >
          {(
            [
              ["overview", "Overview", LayoutDashboard],
              ["conversation", "Conversation", MessageSquare],
              ["notes", "Work notes", FileText],
              ["links", "Links", Link2],
            ] as [string, string, LucideIcon][]
          ).map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              id={`worker-tab-${value}`}
              role="tab"
              aria-selected={tab === value}
              aria-controls={`worker-panel-${value}`}
              tabIndex={tab === value ? 0 : -1}
              onKeyDown={(event) => {
                const values = ["overview", "conversation", "notes", "links"];
                const offset =
                  event.key === "ArrowRight"
                    ? 1
                    : event.key === "ArrowLeft"
                      ? -1
                      : 0;
                if (offset) {
                  event.preventDefault();
                  const next =
                    values[
                      (values.indexOf(value) + offset + values.length) %
                        values.length
                    ];
                  setTab(next);
                  document.getElementById(`worker-tab-${next}`)?.focus();
                }
              }}
              onClick={() => setTab(value)}
              className={`flex shrink-0 items-center gap-2 border-b-2 pb-3 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring ${tab === value ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
            >
              <Icon className="size-3.5" />
              {label}
            </button>
          ))}
        </div>
      </div>
      <div
        ref={scroll}
        onScroll={() => {
          const node = scroll.current;
          if (!node) return;
          follow.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 100;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-8"
        role="tabpanel"
        id={`worker-panel-${tab}`}
        aria-labelledby={`worker-tab-${tab}`}
        tabIndex={0}
      >
        <div
          className={`mx-auto ${tab === "conversation" ? "max-w-3xl" : "max-w-4xl"}`}
        >
          {error && (
            <p
              role="alert"
              className="mb-4 rounded-lg border border-destructive/30 p-3 text-xs text-destructive"
            >
              Could not refresh this worker: {error}.{" "}
              {detail
                ? "Previously loaded evidence remains below."
                : "Retrying automatically."}
            </p>
          )}
          {actionError && (
            <p
              role="alert"
              className="mb-4 rounded-lg border border-destructive/30 p-3 text-xs text-destructive"
            >
              {actionError}
            </p>
          )}
          {!detail && !error && (
            <p
              role="status"
              className="flex items-center gap-2 text-sm text-muted-foreground"
            >
              <LoaderCircle className="size-4 animate-spin" />
              Loading worker evidence…
            </p>
          )}
          {tab === "overview" && (
            <WorkerOverview
              task={task}
              manager={manager}
              onManager={onManager}
              actions={actions}
              timing={timing}
            />
          )}
          {tab === "conversation" && (
            <div className="space-y-6">
              <p className="text-xs leading-5 text-muted-foreground">
                {detail?.historyNotice ||
                  "Recorded manager instructions, worker replies and execution activity for this task."}
              </p>
              {(manager.workerApprovals || []).some(
                (request) =>
                  request.taskId === task.id && request.runId === task.runId,
              ) && (
                <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
                  <p className="text-sm font-medium">Your approval is needed</p>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Review this worker's native request in your manager
                    conversation.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-3"
                    onClick={onManager}
                  >
                    Review approval with manager
                  </Button>
                </div>
              )}
              {attention.map((item) => (
                <div
                  key={item.id}
                  className="rounded-xl border border-primary/20 bg-primary/5 p-4"
                >
                  <p className="text-sm font-medium">
                    {item.kind === "question"
                      ? "Your answer is needed"
                      : item.kind === "completion"
                        ? "Result ready to review"
                        : "Review with your manager"}
                  </p>
                  <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-muted-foreground">
                    {item.message}
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-3"
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
                        await manager.reviewAttention(task.id, item.id);
                        onManager();
                      } catch (failure) {
                        setActionError(errorText(failure));
                      } finally {
                        setActionBusy(false);
                      }
                    }}
                  >
                    <ArrowUpRight />
                    Review with manager
                  </Button>
                </div>
              ))}
              {(detail?.conversation || []).map((item, index) => (
                <WorkerExchange key={item.id || index} item={item} />
              ))}
              {detail && !detail.conversation?.length && (
                <p className="py-8 text-sm text-muted-foreground">
                  No recorded conversation is available for this task.
                </p>
              )}
            </div>
          )}
          {tab === "notes" && detail && <WorkerNotes detail={detail} />}
          {tab === "links" && detail && <WorkerLinks detail={detail} />}
        </div>
      </div>
    </section>
  );
}
