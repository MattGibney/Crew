import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "../../components/ui/collapsible.js";
import { WebLink } from "../WebLink.js";
import type { WorkerExchangeRecord } from "../../contracts/manager.js";
import { ChevronDown, Terminal } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Message } from "../Message.js";
const markdownClass =
  "break-words text-sm leading-7 [&_p]:my-3 [&_h1]:my-4 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:my-3 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-4 [&_code]:text-xs [&_blockquote]:border-l-2 [&_blockquote]:pl-4 [&_table]:block [&_table]:overflow-auto [&_td]:border [&_td]:p-2 [&_th]:border [&_th]:p-2";
export function Markdown({ children }: { children?: string | null }) {
  return (
    <div className={markdownClass}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: WebLink,
          img: ({ alt }) => <span>{alt || "Image"}</span>,
        }}
      >
        {children || ""}
      </ReactMarkdown>
    </div>
  );
}

function ExchangeDetails({ item }: { item: WorkerExchangeRecord }) {
  return (
    <div className="space-y-2 break-words text-xs leading-5 text-muted-foreground">
      {item.at && (
        <time dateTime={item.at}>{new Date(item.at).toLocaleString()}</time>
      )}
      {item.assignmentId && (
        <p className="break-all">Assignment {item.assignmentId}</p>
      )}
      {item.runId && <p className="break-all">Run {item.runId}</p>}
      {item.kind === "execution" && (
        <p>
          {item.status
            ? `Execution: ${item.status}`
            : "Execution status unavailable"}
          {item.exitCode != null ? ` · Exit ${item.exitCode}` : ""}
        </p>
      )}
      {(item.evidence?.length || 0) > 0 && (
        <div>
          <p className="font-medium">Reported evidence</p>
          <ul className="mt-1 space-y-2">
            {item.evidence?.map((value, index) => (
              <li key={index} className="whitespace-pre-wrap break-all">
                {value}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function WorkerExchange({ item }: { item: WorkerExchangeRecord }) {
  const manager = item.actor === "manager";
  const activity =
    ["execution", "command"].includes(item.kind || "") ||
    !["manager", "worker"].includes(item.actor || "");
  const actor = manager
    ? "Manager"
    : item.actor === "worker"
      ? "Worker"
      : item.actor || "Controller";
  const kind = (item.kind || "event").replaceAll("_", " ");
  if (activity)
    return (
      <Collapsible
        aria-label={`${item.actor || "Controller"} ${item.kind || "event"}`}
        className="group ml-9 rounded-lg bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground"
      >
        <CollapsibleTrigger className="flex w-full cursor-pointer list-none items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Terminal className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="shrink-0 capitalize">
            {actor} · {kind}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
            {item.message?.split("\n")[0]}
          </span>
          <ChevronDown
            className="size-3.5 shrink-0 transition-transform group-data-[open]:rotate-180"
            aria-hidden="true"
          />
        </CollapsibleTrigger>
        <CollapsibleContent keepMounted>
          <div className="space-y-4 pt-3">
            <Markdown>{item.message}</Markdown>
            <ExchangeDetails item={item} />
          </div>
        </CollapsibleContent>
      </Collapsible>
    );
  return (
    <Message
      message={{
        id: item.id,
        role: manager ? "user" : "assistant",
        text: item.message,
        phase: item.kind === "progress" ? "commentary" : undefined,
      }}
      label={item.kind === "progress" ? `${actor} · progress` : actor}
      ariaLabel={`${item.actor} ${item.kind || "event"}`}
    >
      {(item.at ||
        item.runId ||
        item.assignmentId ||
        (item.evidence?.length || 0) > 0) && (
        <Collapsible className="mt-2 text-[11px] text-muted-foreground">
          <CollapsibleTrigger className="text-left w-fit cursor-pointer">
            Details
          </CollapsibleTrigger>
          <CollapsibleContent keepMounted>
            <div className="pt-2">
              <ExchangeDetails item={item} />
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </Message>
  );
}
