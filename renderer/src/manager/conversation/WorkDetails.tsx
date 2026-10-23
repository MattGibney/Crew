import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "../../components/ui/collapsible.js";
import type { ManagerProfile } from "../../contracts/manager.js";
import type { WorkDetailsRow } from "../conversation.js";
import { Wrench } from "lucide-react";

import { Message } from "../Message.js";

export function WorkDetails({
  row,
  profile,
}: {
  row: WorkDetailsRow;
  profile?: ManagerProfile | null;
}) {
  const hasResponse = row.messages.some(
    (message) =>
      message.role === "assistant" &&
      message.phase !== "commentary" &&
      message.text,
  );
  return (
    <Collapsible
      data-work-turn-id={row.turnId}
      className="rounded-lg border px-4 py-3 text-sm"
    >
      <CollapsibleTrigger className="text-left cursor-pointer rounded-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="inline-flex items-center gap-2">
          <Wrench className="size-3.5" aria-hidden="true" />
          Work details
          {hasResponse && <span className="text-xs">· Written response</span>}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent keepMounted>
        <div className="mt-4 space-y-5" aria-label="Backing work exchange">
          {row.messages.map((message) => (
            <Message
              key={message.id}
              message={message}
              profile={profile}
              label={
                message.role === "user"
                  ? "Voice work request"
                  : message.phase === "commentary"
                    ? "Work progress"
                    : "Written response"
              }
              copyable
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
