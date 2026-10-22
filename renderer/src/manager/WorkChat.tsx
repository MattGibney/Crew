import { useManagerComposer } from "./conversation/useManagerComposer.js";
import { ManagerComposer } from "./conversation/ManagerComposer.js";
import { WorkDetails } from "./conversation/WorkDetails.js";

import type { ManagerProps } from "../contracts/manager.js";

import {
  ArrowDown,
  Check,
  Command,
  LoaderCircle,
  MessageSquare,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { ApprovalForm } from "./ApprovalForm.js";
import { Message } from "./Message.js";

import { conversationRows } from "./conversation.js";

export function WorkChat({ manager }: ManagerProps) {
  const { work, workNotice: notice, prepared, eventReady, sending } = manager;
  const approvals = work.approvals || [],
    items = work.items || [];
  const messages = conversationRows(work.messages);
  const composer = useManagerComposer(manager);
  const { busy, sendError, setDraft, selectInput, inputRef } = composer;
  return (
    <MessageScrollerProvider
      autoScroll
      defaultScrollPosition="end"
      scrollEdgeThreshold={8}
    >
      <div className="relative flex min-h-0 flex-1 flex-col">
        <MessageScroller className="flex-1">
          <MessageScrollerViewport
            aria-label="Manager conversation"
            className="px-5 sm:px-7 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40"
          >
            <MessageScrollerContent
              id="work-result"
              aria-label="Conversation messages"
              aria-live="off"
              className="mx-auto max-w-3xl gap-7 py-8"
            >
              <MessageScrollerItem
                messageId="conversation-notices"
                className="empty:hidden space-y-3"
              >
                {(manager.projectInfo?.readiness?.ready === false ||
                  (!manager.projectInfo &&
                    manager.project.startsWith(
                      "Project configuration unavailable",
                    ))) && (
                  <Alert role="alert">
                    <AlertDescription className="break-words">
                      {manager.project}
                      <p className="mt-2">
                        Open Set up Crew in the app menu to review your project.
                        You can still discuss setup with your manager.
                      </p>
                    </AlertDescription>
                  </Alert>
                )}
                {!manager.managerEnabled && (
                  <Alert>
                    <AlertDescription>
                      Your manager is{" "}
                      {manager.managerLifecycle.state === "stopped"
                        ? "stopped"
                        : "unavailable while its state is checked"}
                      . Open Settings to start or restart it. Your conversation
                      and worker history stay here.
                    </AlertDescription>
                  </Alert>
                )}
                {manager.soundUnavailable && (
                  <p role="status" className="text-xs text-muted-foreground">
                    Sound is unavailable. Click or press a key in Crew to enable
                    future cues; requests remain visible here.
                  </p>
                )}
                {manager.error && (
                  <Alert variant="destructive" id="error" role="alert">
                    <AlertDescription className="space-y-3 break-words">
                      <p>{manager.error}</p>
                      {!prepared && (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => void manager.retryConnection()}
                        >
                          Retry connection
                        </Button>
                      )}
                    </AlertDescription>
                  </Alert>
                )}
                {!messages.length &&
                  !approvals.length &&
                  !manager.workerApprovals?.length && (
                    <div className="flex min-h-64 flex-col items-center justify-center px-2 py-10 text-center">
                      <div className="mb-5 flex size-12 items-center justify-center rounded-2xl border bg-background">
                        <MessageSquare
                          className="size-5 text-primary"
                          aria-hidden="true"
                        />
                      </div>
                      <h2 className="text-2xl font-semibold tracking-tight">
                        What are we working on?
                      </h2>
                      <p className="mt-3 max-w-sm text-sm leading-6 text-muted-foreground">
                        Talk through an idea, review progress, or agree on a
                        task. Your manager brings in workers when you ask.
                      </p>
                      <div className="mt-6 flex flex-wrap justify-center gap-2">
                        {[
                          "What is the current project status?",
                          "Help me plan a task",
                        ].map((text) => (
                          <Button
                            key={text}
                            variant="outline"
                            className="h-auto whitespace-normal py-2 text-xs"
                            onClick={() => {
                              setDraft(text);
                              selectInput("text");
                              requestAnimationFrame(() =>
                                inputRef.current?.focus(),
                              );
                            }}
                          >
                            {text}
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}
              </MessageScrollerItem>
              {messages.map((message) => (
                <MessageScrollerItem key={message.id} messageId={message.id}>
                  {message.kind === "work-details" ? (
                    <WorkDetails
                      row={message}
                      profile={manager.settings?.managerProfile}
                    />
                  ) : (
                    <Message
                      message={message}
                      profile={manager.settings?.managerProfile}
                      copyable
                    />
                  )}
                </MessageScrollerItem>
              ))}
              {busy && (
                <MessageScrollerItem messageId="conversation-status">
                  <p
                    id="work-status"
                    role="status"
                    className="flex items-center gap-2 text-sm text-muted-foreground"
                  >
                    <LoaderCircle
                      className="size-4 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                    {approvals.length
                      ? "Waiting for your answer below"
                      : sending
                        ? "Sending your message…"
                        : "Your manager is working…"}
                  </p>
                </MessageScrollerItem>
              )}
              {(approvals.length > 0 ||
                manager.workerApprovals?.length > 0) && (
                <MessageScrollerItem
                  messageId="conversation-approvals"
                  className="space-y-4"
                >
                  <div id="approvals" className="space-y-3">
                    {approvals.map((request) => (
                      <ApprovalForm
                        key={request.id}
                        request={request}
                        workItems={items}
                        onAnswer={manager.answerApproval}
                      />
                    ))}
                  </div>
                  <div id="worker-approvals" className="space-y-3">
                    {(manager.workerApprovals || []).map((request) => {
                      const task = manager.orchestration.tasks?.find(
                        (task) => task.id === request.taskId,
                      );
                      return (
                        <section
                          key={request.approvalId}
                          aria-label={`Worker approval ${task?.ticket || request.taskId}`}
                          className="space-y-2"
                        >
                          <p className="text-sm font-medium">
                            Worker · {task?.ticket || request.taskId}
                          </p>
                          {task?.brief && (
                            <p className="line-clamp-2 text-xs text-muted-foreground">
                              {task.brief}
                            </p>
                          )}
                          <ApprovalForm
                            request={{ ...request, id: request.approvalId }}
                            workItems={[]}
                            onAnswer={(_id, response) =>
                              manager.answerWorkerApproval(request, response)
                            }
                          />
                        </section>
                      );
                    })}
                  </div>
                </MessageScrollerItem>
              )}
              <MessageScrollerItem
                messageId="conversation-feedback"
                className="empty:hidden"
              >
                {(notice || sendError) && (
                  <Alert id="work-notice" role="alert">
                    <AlertDescription className="break-words">
                      {sendError || notice}
                    </AlertDescription>
                  </Alert>
                )}
              </MessageScrollerItem>
              {items.length > 0 && (
                <MessageScrollerItem messageId="conversation-tools">
                  <Trace aria-label="Recorded tool activity">
                    <TraceCollapsible>
                      <TraceCollapsibleTrigger>
                        <TraceLine>
                          <TraceIcon>
                            <Wrench />
                          </TraceIcon>
                          <TraceTitle>
                            Tool activity · {items.length}{" "}
                            {items.length === 1 ? "step" : "steps"}
                          </TraceTitle>
                        </TraceLine>
                      </TraceCollapsibleTrigger>
                      <TraceCollapsibleContent>
                        <ul
                          id="work-log"
                          className="space-y-3"
                          aria-label="Actual backend tool activity"
                        >
                          {items.map((item, index) => (
                            <li key={item.id || index}>
                              <TraceLine
                                status={
                                  item.status === "failed"
                                    ? "error"
                                    : item.status === "inProgress" ||
                                        item.status === "running"
                                      ? "running"
                                      : undefined
                                }
                              >
                                <TraceIcon>
                                  {item.status === "completed" ? (
                                    <Check />
                                  ) : (
                                    <Command />
                                  )}
                                </TraceIcon>
                                <TraceTitle className="whitespace-normal break-words">
                                  {item.name}
                                </TraceTitle>
                                <span className="shrink-0 text-xs">
                                  {item.status}
                                  {item.exitCode != null
                                    ? ` · exit ${item.exitCode}`
                                    : ""}
                                </span>
                              </TraceLine>
                            </li>
                          ))}
                        </ul>
                      </TraceCollapsibleContent>
                    </TraceCollapsible>
                  </Trace>
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton
            size="sm"
            variant="outline"
            className="rounded-full px-3 shadow-md"
            aria-label="Jump to latest"
          >
            <ArrowDown className="size-3.5" />
            Jump to latest
          </MessageScrollerButton>
        </MessageScroller>
        <ManagerComposer manager={manager} composer={composer} />
      </div>
    </MessageScrollerProvider>
  );
}
