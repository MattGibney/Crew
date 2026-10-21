export type MessageRole = "user" | "assistant";
export type MessageStatus = "streaming" | "complete" | "partial";
export interface ConversationMessage {
  id: string;
  turnId?: string | null;
  role: MessageRole;
  text: string;
  phase?: string | null;
  source?: string;
  presentation?: string;
  status?: MessageStatus;
  position?: number;
  promotionId?: string;
}
export interface TimelineMessage extends ConversationMessage {
  status: MessageStatus;
  position: number;
}
export interface TimelineOptions {
  status?: MessageStatus;
  position?: number;
}
export interface NativeItem {
  id: string;
  type: string;
  role?: MessageRole;
  text?: string;
  phase?: string | null;
  content?: { type: string; text?: string }[];
  itemId?: string;
  command?: string;
  status?: string;
  exitCode?: number | null;
  aggregatedOutput?: string;
  server?: string;
  tool?: string;
  result?: unknown;
  error?: unknown;
  changes?: unknown;
}
