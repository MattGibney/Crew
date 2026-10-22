import type { ManagerProps, ManagerAction } from "../../contracts/manager.js";
import { errorText } from "../api.js";
import { useState } from "react";
import { LoaderCircle, Play, RotateCcw, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

import { Alert, AlertDescription } from "@/components/ui/alert";

export function ManagerLifecycle({ manager }: ManagerProps) {
  const { state, error, activeVersion } = manager.managerLifecycle;
  const [failure, setFailure] = useState("");
  const transitioning = [
    "loading",
    "starting",
    "stopping",
    "restarting",
  ].includes(state);
  const act = async (action: ManagerAction) => {
    setFailure("");
    try {
      await manager.changeManagerLifecycle(action);
    } catch (error) {
      setFailure(errorText(error));
    }
  };
  const names: Record<string, string> = {
    loading: "Checking manager…",
    running: activeVersion ? "Running" : "Not connected",
    stopped: "Stopped",
    starting: "Starting…",
    stopping: "Stopping…",
    restarting: "Restarting…",
    error: "Needs attention",
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Badge variant={state === "running" ? "secondary" : "outline"}>
            {transitioning && (
              <LoaderCircle
                className="size-3 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            )}
            {names[state] || state}
          </Badge>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            id="start-manager"
            variant="outline"
            disabled={
              transitioning || state === "running" || !manager.eventReady
            }
            onClick={() => void act("start")}
          >
            <Play aria-hidden="true" />
            Start manager
          </Button>
          <Button
            id="stop-manager"
            variant="outline"
            disabled={
              transitioning || state === "stopped" || !manager.eventReady
            }
            onClick={() => void act("stop")}
          >
            <Square aria-hidden="true" />
            Stop manager
          </Button>
          <Button
            id="restart-manager"
            disabled={transitioning || !manager.eventReady}
            onClick={() => void act("restart")}
          >
            <RotateCcw aria-hidden="true" />
            Restart manager
          </Button>
        </div>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        Stop ends manager work and voice. Your saved conversation, project tasks
        and independent workers are preserved. Start never connects voice or
        starts a task.
      </p>
      {transitioning && (
        <p role="status" className="text-xs text-muted-foreground">
          {state === "stopping" || state === "restarting"
            ? "Releasing voice and waiting for manager work to stop…"
            : "Waiting for the controller to confirm the manager state…"}
        </p>
      )}
      {(failure || error) && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{failure || error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
