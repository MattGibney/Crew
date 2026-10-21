import type { WorkerDetailState } from "../../contracts/manager.js";
import { FileText } from "lucide-react";

import { Markdown } from "./WorkerExchange.js";

import type { useWorkerActions } from "./useWorkerActions.js";
export function WorkerNotes({ detail }: { detail: WorkerDetailState }) {
  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Shared work notes</h2>
        <span className="text-[11px] text-muted-foreground">
          Read only · refreshes as work changes
        </span>
      </div>
      {detail.notes?.exists ? (
        <>
          <Markdown>{detail.notes.markdown}</Markdown>
          <p className="mt-8 break-all border-t pt-3 text-[11px] text-muted-foreground">
            Source: {detail.notes.path}
            {detail.notes.updatedAt
              ? ` · Updated ${new Date(detail.notes.updatedAt).toLocaleString()}`
              : ""}
          </p>
        </>
      ) : (
        <div className="rounded-xl border border-dashed p-7">
          <FileText className="mb-3 size-5 text-muted-foreground" />
          <h3 className="text-sm font-medium">No shared notes yet</h3>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Your manager and worker can maintain a Markdown work document for
            this task. Ask your manager to record decisions or findings here.
          </p>
          <p className="mt-3 text-xs text-muted-foreground">
            Structured task state is separate from this document.
          </p>
        </div>
      )}
    </div>
  );
}
