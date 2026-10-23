import type { AgentContent } from "../agents/contracts.mjs";

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface BrowserSelection {
  url: string;
  title: string;
  selector?: string;
  text?: string;
  rect?: BrowserBounds;
  capturedAt: string;
}
/** Owner-visible projection of the native project browser. */
export interface BrowserState {
  open: boolean;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  recipientAgentId?: string | null;
  ownerAgentId?: string | null;
  activeTabId?: string | null;
  tabs?: { id: string; title: string; url: string; loading: boolean }[];
  selecting?: boolean;
  error?: string | null;
  automation?: unknown;
  selection?: BrowserSelection | null;
  annotation?: { content: AgentContent[] } | null;
}
export interface BrowserRequest {
  projectId: string;
  action:
    | "select_agent"
    | "new_tab"
    | "select_tab"
    | "close_tab"
    | "state"
    | "open"
    | "close"
    | "navigate"
    | "back"
    | "forward"
    | "reload"
    | "bounds"
    | "selectElement"
    | "annotation";
  agentId?: string;
  tabId?: string;
  url?: string;
  bounds?: BrowserBounds;
  visible?: boolean;
  comment?: string;
  annotationScope?: "page" | "element";
  recipientAgentId?: string;
}
export interface BrowserEvent {
  type: "browser";
  projectId: string;
  state: BrowserState;
}
