import type { ReactNode } from "react";
import type { MessageRecord, ManagerProfile } from "../contracts/manager.js";
import { copyText } from "./clipboard.js";
import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock, MessageImage } from "./MessageContent.js";
import { ManagerAvatar } from "./ManagerAvatar.js";
import { managerDisplayName } from "./profile.js";

export function Message({
  message,
  label,
  ariaLabel,
  children,
  copyable = false,
  profile,
}: {
  message: MessageRecord;
  label?: string;
  ariaLabel?: string;
  children?: ReactNode;
  copyable?: boolean;
  profile?: ManagerProfile | null;
}) {
  const [copyState, setCopyState] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await copyText(message.text || "");
      setCopyState("Copied");
    } catch {
      setCopyState("Could not copy");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopyState(""), 2000);
  };
  const managerName = managerDisplayName(profile);
  const user = message.role === "user";
  return (
    <article
      data-message-id={message.id}
      aria-label={ariaLabel || (user ? "Your message" : "Manager message")}
      className={`group/message flex gap-3 ${user ? "justify-end" : ""}`}
    >
      {!user && <ManagerAvatar profile={profile} className="mt-1 size-6" />}
      <div
        className={`relative min-w-0 max-w-full ${user ? "rounded-2xl bg-muted px-4 py-3 sm:max-w-[85%]" : "flex-1 pt-0.5"}`}
      >
        <p className="mb-1.5 break-words text-xs font-medium text-muted-foreground">
          {label ||
            (user
              ? "You"
              : message.phase === "commentary"
                ? `${managerName} · progress`
                : managerName)}
          {message.status === "streaming" && (
            <span className="ml-2 font-normal">· Live</span>
          )}
          {message.status === "partial" && (
            <span className="ml-2 font-normal">
              ·{" "}
              {message.source === "voice"
                ? "Partial transcript"
                : "Interrupted"}
            </span>
          )}
        </p>
        <div
          className={`break-words text-sm leading-7 [&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1 [&_h1]:my-3 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:my-3 [&_h2]:font-semibold [&_h3]:my-2 [&_h3]:font-medium [&_code]:text-xs [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_table]:w-full [&_th]:border-b [&_th]:p-2 [&_th]:text-left [&_td]:border-b [&_td]:p-2 ${message.phase === "commentary" ? "text-muted-foreground" : ""}`}
        >
          {user ? (
            <p className="whitespace-pre-wrap">{message.text || ""}</p>
          ) : (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ children, href }) => (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline underline-offset-4"
                  >
                    {children}
                  </a>
                ),
                pre: CodeBlock,
                code: ({ children, className }) => (
                  <code
                    className={
                      className || "rounded bg-muted px-1.5 py-0.5 font-mono"
                    }
                  >
                    {children}
                  </code>
                ),
                img: MessageImage,
                table: ({ children }) => (
                  <div className="overflow-auto">
                    <table>{children}</table>
                  </div>
                ),
              }}
            >
              {message.text || ""}
            </ReactMarkdown>
          )}
        </div>
        {copyable &&
          !user &&
          message.text &&
          message.status !== "streaming" && (
            <div className="absolute -top-1 right-0 flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={
                  copyState === "Copied" ? "Message copied" : "Copy message"
                }
                title="Copy message"
                className="text-muted-foreground opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100 [@media(hover:none)]:opacity-100"
                onClick={() => void copy()}
              >
                {copyState === "Copied" ? <Check /> : <Copy />}
              </Button>
              <span role="status" className="text-xs text-muted-foreground">
                {copyState}
              </span>
            </div>
          )}
        {children}
      </div>
    </article>
  );
}
