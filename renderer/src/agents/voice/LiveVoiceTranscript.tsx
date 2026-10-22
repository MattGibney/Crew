import { Message } from "../../manager/Message";
import type { LiveTranscriptItem } from "./live-transcript";

export function LiveVoiceTranscript({
  items,
  agentName,
}: {
  items: LiveTranscriptItem[];
  agentName: string;
}) {
  const visible = items.filter((item) => item.text.length > 0);
  if (!visible.length) return null;
  return (
    <section aria-label="Live call transcript" className="space-y-7">
      <p className="text-xs text-muted-foreground">
        Recent live call transcript · available during this call
      </p>
      {visible.map((item) => (
        <Message
          key={item.itemId}
          message={{
            id: item.itemId,
            role: item.role,
            text: item.text,
            status: item.done ? "complete" : "streaming",
            source: "voice",
          }}
          label={
            item.role === "user"
              ? "You · live voice"
              : `${agentName} · live voice`
          }
          ariaLabel={
            item.role === "user"
              ? "Your live voice transcript"
              : "Assistant live voice transcript"
          }
          copyable={false}
        />
      ))}
    </section>
  );
}
