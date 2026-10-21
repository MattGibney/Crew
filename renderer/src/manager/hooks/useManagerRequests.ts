import { useCallback, useRef, useState } from "react";
import { api, errorText } from "../api.js";
import { workerActionRequest } from "../worker-model.js";
import type {
  RequestId,
  WorkerApproval,
  WorkRequest,
  WorkerTask,
  WorkerAction,
} from "../../contracts/manager.js";

export function useManagerRequests(
  managerEnabled: boolean,
  showError: (error: unknown) => void,
) {
  const [sending, setSending] = useState(false);
  const [workNotice, setWorkNotice] = useState("");
  const requestLock = useRef(false);
  const retryRequests = useRef(new Map<string, WorkRequest>());
  const reviewAttention = useCallback(
    async (taskId: string, attentionId: string) => {
      try {
        await api("discuss-attention", { taskId, attentionId });
      } catch (failure) {
        showError(failure);
        throw failure;
      }
    },
    [showError],
  );
  const answerApproval = useCallback(
    async (id: RequestId, response: unknown) => {
      try {
        await api("approval", { id, response });
      } catch (failure) {
        setWorkNotice(errorText(failure));
      }
    },
    [],
  );
  const answerWorkerApproval = useCallback(
    async (request: WorkerApproval, response: unknown) => {
      const { taskId, runId, approvalId, threadId, turnId, requestId } =
        request;
      try {
        await api("worker-approval", {
          taskId,
          runId,
          approvalId,
          threadId,
          turnId,
          requestId,
          response,
        });
      } catch (failure) {
        setWorkNotice(errorText(failure));
        throw failure;
      }
    },
    [],
  );
  const interruptManager = useCallback(async () => {
    try {
      await api("stop-work");
    } catch (failure) {
      setWorkNotice(errorText(failure));
    }
  }, []);
  const sendRequest = useCallback(
    async (request: WorkRequest) => {
      if (!managerEnabled)
        throw new Error(
          "Start your manager before sending a message or action.",
        );
      if (requestLock.current)
        throw new Error("A message is already being sent.");
      requestLock.current = true;
      setSending(true);
      setWorkNotice("");
      try {
        return await api("work", request);
      } catch (failure) {
        setWorkNotice(errorText(failure));
        throw failure;
      } finally {
        requestLock.current = false;
        setSending(false);
      }
    },
    [managerEnabled],
  );
  const correlatedRequest = useCallback(
    async (key: string, create: () => WorkRequest) => {
      const request = retryRequests.current.get(key) || create();
      retryRequests.current.set(key, request);
      const result = await sendRequest(request);
      retryRequests.current.delete(key);
      return result;
    },
    [sendRequest],
  );
  const sendMessage = useCallback(
    (text: string) =>
      correlatedRequest(`message:${text}`, () => ({
        text,
        requestId: `message-${crypto.randomUUID()}`,
      })),
    [correlatedRequest],
  );
  const workerAction = useCallback(
    (task: WorkerTask, action: WorkerAction) =>
      correlatedRequest(`worker:${task.id}:${task.runId}:${action}`, () =>
        workerActionRequest(task, action),
      ),
    [correlatedRequest],
  );
  return {
    sending,
    workNotice,
    setWorkNotice,
    reviewAttention,
    answerApproval,
    answerWorkerApproval,
    interruptManager,
    sendMessage,
    workerAction,
  };
}
