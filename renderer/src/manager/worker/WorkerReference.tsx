import { workReference } from "../../../../src/shared/tracking.mjs";
import type { WorkerAssignment } from "../../contracts/manager.js";

/** Keep the issue number before the truncating repository context. */
export function WorkerReference({
  assignment,
  fallback,
  className = "",
}: {
  assignment: Pick<WorkerAssignment, "ticket" | "workLink">;
  fallback: string;
  className?: string;
}) {
  const reference = workReference(assignment, fallback);
  return (
    <span
      data-worker-reference
      className={`inline-flex min-w-0 max-w-full items-baseline gap-1.5 ${className}`}
      title={reference.context}
      aria-label={reference.context}
    >
      <span className={reference.repository ? "shrink-0" : "truncate"}>
        {reference.label}
      </span>
      {reference.repository && (
        <span className="min-w-0 truncate font-normal">
          {reference.repository}
        </span>
      )}
    </span>
  );
}
