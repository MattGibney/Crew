import type { WorkerDetailState } from "../../contracts/manager.js";
import { ArrowUpRight } from "lucide-react";

export function WorkerLinks({ detail }: { detail: WorkerDetailState }) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold">Task resources</h2>
        <p className="mt-2 text-xs text-muted-foreground">
          Recorded resources for this task. Ticket status is separate from
          worker status.
        </p>
      </div>
      {(detail.links || []).map((link, index) => (
        <div key={index} className="rounded-xl border p-4">
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            {link.kind || "Resource"}
          </p>
          {/^https?:\/\//i.test(link.url || "") ? (
            <a
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-start justify-between gap-3 break-all text-sm font-medium text-primary hover:underline"
            >
              {link.label || link.url}
              <ArrowUpRight className="size-4 shrink-0" />
            </a>
          ) : (
            <p className="break-all text-sm">
              {link.path || link.label || "Resource unavailable"}
            </p>
          )}
        </div>
      ))}
      {!detail.links?.length && (
        <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
          No external links have been recorded yet.
        </p>
      )}
    </div>
  );
}
