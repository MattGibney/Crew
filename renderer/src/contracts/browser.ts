// GitHub #56: optional, native-only isolated browser experiment.
export interface BrowserState {
  open: boolean;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
  automation?: string;
}

export interface BrowserRequest {
  action:
    | "state"
    | "open"
    | "close"
    | "navigate"
    | "back"
    | "forward"
    | "reload"
    | "bounds";
  url?: string;
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface BrowserBridge {
  request: (request: BrowserRequest) => Promise<BrowserState>;
  onState: (listener: (state: BrowserState) => void) => () => void;
}
