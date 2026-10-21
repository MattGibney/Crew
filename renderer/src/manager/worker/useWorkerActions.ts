import { useState } from "react";
import type {
  Manager,
  WorkerTask,
  WorkerAction,
} from "../../contracts/manager.js";
import { errorText } from "../api.js";
/** Lifecycle UI delivers exact human intent through the manager; never talks to a worker. */
export function useWorkerActions(
  task: WorkerTask,
  manager: Manager,
  onManager: () => void,
) {
  const [actionError, setActionError] = useState(""),
    [actionBusy, setActionBusy] = useState(false),
    [confirmRemove, setConfirmRemove] = useState(false);
  const act = async (action: WorkerAction) => {
    setActionBusy(true);
    setActionError("");
    try {
      await manager.workerAction(task, action);
      setConfirmRemove(false);
      onManager();
    } catch (failure) {
      setActionError(errorText(failure));
    } finally {
      setActionBusy(false);
    }
  };
  return {
    actionError,
    setActionError,
    actionBusy,
    setActionBusy,
    confirmRemove,
    setConfirmRemove,
    act,
  };
}
