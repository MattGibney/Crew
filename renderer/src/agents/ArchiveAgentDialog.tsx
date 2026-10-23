import { useRef } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { Archive } from "lucide-react";

export function ArchiveAgentDialog({
  agent,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  agent: { id: string; name: string } | null;
  busy: boolean;
  error: string;
  onCancel(): void;
  onConfirm(): void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog
      open={Boolean(agent)}
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <AlertDialogContent size="sm" initialFocus={cancel}>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-destructive/10 text-destructive dark:bg-destructive/20 dark:text-destructive">
            <Archive aria-hidden="true" />
          </AlertDialogMedia>
          <AlertDialogTitle>Archive {agent?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This will stop their session and remove them from active agents.
            Their chat history and records will be kept. You can restore them
            from Archived agents in Settings.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel
            ref={cancel}
            variant="outline"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "Archiving…" : "Archive agent"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
