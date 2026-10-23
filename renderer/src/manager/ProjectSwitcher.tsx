import type { WorkspaceSnapshot, WorkspaceBridge } from "../contracts/setup.js";
import { errorText } from "./api.js";
import { useEffect, useState } from "react";
import { ChevronDown, Plus, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import { NativeSelect } from "@/components/ui/native-select";

export function ProjectSwitcher({
  fallbackName,
  bridge: suppliedBridge,
}: {
  fallbackName?: string;
  bridge?: Pick<WorkspaceBridge, "snapshot" | "subscribe" | "select" | "add">;
}) {
  const bridge = suppliedBridge ?? window.crewWorkspaces;
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [open, setOpen] = useState(false);
  const selected = snapshot?.projects.find(
    (project) => project.id === snapshot?.selectedId,
  );

  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    // Subscribe first so changes during the initial request cannot be missed.
    let changed = false;
    const unsubscribe = bridge.subscribe((value) => {
      changed = true;
      if (alive) setSnapshot(value);
    });
    bridge
      .snapshot()
      .then((value) => {
        if (alive && !changed) setSnapshot(value);
      })
      .catch((reason) => {
        if (alive) setError(errorText(reason));
      });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [bridge]);

  async function run(operation: () => Promise<unknown>, after?: () => void) {
    setWorking(true);
    setError("");
    try {
      await operation();
      after?.();
    } catch (reason) {
      setError(errorText(reason) || "Unable to update your projects.");
    } finally {
      setWorking(false);
    }
  }

  if (!bridge)
    return (
      <p className="truncate text-sm font-medium" id="instance-project">
        {fallbackName || "Your project"}
      </p>
    );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        id="instance-project"
        aria-label={`Project: ${selected?.name || fallbackName || "Your project"}. Manage projects`}
        className="flex cursor-pointer list-none items-center gap-1 rounded-md py-1 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden"
      >
        <span className="max-w-[28vw] truncate sm:max-w-64">
          {selected?.name || fallbackName || "Your project"}
        </span>
        <ChevronDown
          className="size-3.5 shrink-0 text-muted-foreground transition-transform in-aria-expanded:rotate-180"
          aria-hidden="true"
        />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label="Manage projects"
        className="max-h-[calc(100dvh-6rem)] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto p-4"
      >
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <FolderOpen className="size-4 text-primary" aria-hidden="true" />
          Your projects
        </div>
        <label
          htmlFor="workspace-select"
          className="mb-1.5 block text-xs font-medium"
        >
          Current project
        </label>
        <NativeSelect
          className="w-full"
          id="workspace-select"
          value={snapshot?.selectedId || ""}
          disabled={working || !snapshot}
          onChange={(event) => {
            const nextId = event.target.value;
            if (nextId !== snapshot?.selectedId)
              run(
                () => bridge.select(nextId),
                () => {
                  setOpen(false);
                },
              );
          }}
        >
          {!snapshot && <option value="">Loading projects…</option>}
          {snapshot?.projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
              {project.pending
                ? ` · ${project.pending} need attention`
                : project.error || project.ready === false
                  ? " · Needs setup"
                  : project.active
                    ? " · Working"
                    : ""}
            </option>
          ))}
        </NativeSelect>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Work continues in other projects. Switching disconnects voice; connect
          again when you’re ready.
        </p>
        <Button
          variant="outline"
          className="mt-3 w-full"
          disabled={working || !snapshot}
          onClick={() =>
            run(
              () => bridge.add(),
              () => {
                setOpen(false);
              },
            )
          }
        >
          <Plus aria-hidden="true" />
          Add project
        </Button>
        {error && (
          <p role="alert" className="mt-3 text-xs text-destructive">
            {error}
          </p>
        )}
        {working && (
          <p role="status" className="mt-3 text-xs text-muted-foreground">
            Saving…
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
