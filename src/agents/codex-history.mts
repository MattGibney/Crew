import type {
  Actor,
  AgentContent,
  JsonObject,
  RuntimeBinding,
  RuntimeHistoryItem,
} from "./contracts.mjs";
import { object } from "./codex-peer.mjs";

export type CodexSenderLookup = (
  binding: RuntimeBinding,
  clientId: string,
) => Actor | null;

/** Display projection only. Native history stays authoritative; private reasoning is omitted. */
export function projectCodexItem(
  binding: RuntimeBinding,
  value: unknown,
  turnId: string | null,
  lookupSender?: CodexSenderLookup,
): RuntimeHistoryItem | null {
  if (
    !object(value) ||
    typeof value.id !== "string" ||
    typeof value.type !== "string"
  )
    return null;
  const type = value.type;
  if (type === "reasoning" || type === "hookPrompt") return null;
  const metadata: JsonObject = { nativeType: type };
  const base = { runtimeRef: value.id, turnId, metadata };
  if (type === "userMessage") {
    const clientId = typeof value.clientId === "string" ? value.clientId : null;
    if (clientId) metadata.clientId = clientId;
    const content: AgentContent[] = [];
    if (Array.isArray(value.content))
      for (const block of value.content) {
        if (!object(block)) continue;
        if (block.type === "text" && typeof block.text === "string")
          content.push({ type: "text", text: block.text });
        else if (block.type === "image" && typeof block.fileId === "string")
          content.push({ type: "image", fileRef: block.fileId, caption: null });
        else if (block.type === "localImage" && typeof block.path === "string")
          content.push({ type: "image", fileRef: block.path, caption: null });
        else if (block.type === "mention" && typeof block.path === "string")
          content.push({
            type: "file",
            fileRef: block.path,
            name: typeof block.name === "string" ? block.name : "Attachment",
            mediaType: "application/octet-stream",
          });
      }
    return {
      ...base,
      kind: "message",
      sender: (clientId && lookupSender?.(binding, clientId)) || {
        type: "unattributed_native",
        nativeRole: "user",
      },
      content,
    };
  }
  if (type === "agentMessage") {
    if (typeof value.phase === "string") metadata.phase = value.phase;
    return {
      ...base,
      kind: "message",
      sender: { type: "assistant", agentId: binding.agentId },
      content:
        typeof value.text === "string"
          ? [{ type: "text", text: value.text }]
          : [],
    };
  }
  if (
    [
      "commandExecution",
      "fileChange",
      "mcpToolCall",
      "dynamicToolCall",
      "functionCallOutput",
      "collabAgentToolCall",
      "webSearch",
      "imageView",
      "imageGeneration",
      "sleep",
    ].includes(type)
  ) {
    // Tool payloads may contain credential material or private data; expose only execution facts.
    for (const key of ["status", "exitCode", "durationMs"]) {
      const field = value[key];
      if (
        field === null ||
        typeof field === "string" ||
        (typeof field === "number" && Number.isFinite(field))
      )
        metadata[key] = field;
    }
    const name =
      typeof value.tool === "string"
        ? value.tool
        : typeof value.name === "string"
          ? value.name
          : type;
    return {
      ...base,
      kind: "tool",
      sender: { type: "tool", name },
      content: [],
    };
  }
  return { ...base, kind: "other", sender: { type: "system" }, content: [] };
}

/** A disconnected observer must rehydrate native history; never silently drop live events. */
export class CodexEventStream<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiting: ((value: IteratorResult<T>) => void) | null = null;
  private ended = false;
  private overflow = false;
  constructor(private readonly onClose: () => void) {}
  push(event: T) {
    if (this.ended) return;
    if (this.waiting) {
      const wake = this.waiting;
      this.waiting = null;
      wake({ done: false, value: event });
    } else if (this.queue.length >= 1024) {
      this.overflow = true;
      this.end();
    } else this.queue.push(event);
  }
  end() {
    this.ended = true;
    this.onClose();
    if (this.waiting) {
      const wake = this.waiting;
      this.waiting = null;
      wake({ done: true, value: undefined });
    }
  }
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    try {
      while (true) {
        if (this.overflow)
          throw new Error(
            "Native event consumer fell behind; rehydrate history and reconnect observation.",
          );
        const item = this.queue.shift();
        if (item !== undefined) {
          yield item;
          continue;
        }
        if (this.ended) return;
        const result = await new Promise<IteratorResult<T>>((resolve) => {
          this.waiting = resolve;
        });
        if (result.done) return;
        yield result.value;
      }
    } finally {
      this.end();
    }
  }
}
