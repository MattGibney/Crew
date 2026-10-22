import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Globe,
  LoaderCircle,
  RotateCw,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { BrowserRequest, BrowserState } from "../contracts/browser.js";

const initialState: BrowserState = {
  open: false,
  url: "",
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false,
};

export function useProjectBrowser() {
  const bridge = window.crewBrowser;
  const [state, setState] = useState<BrowserState>(initialState);
  const [error, setError] = useState("");
  const revision = useRef(0);
  const send = async (request: BrowserRequest) => {
    if (!bridge) return;
    const observed = revision.current;
    try {
      const next = await bridge.request(request);
      // Layout acknowledgements must never replace newer navigation events.
      if (request.action !== "bounds" && revision.current === observed)
        setState(next);
      if (request.action !== "bounds") setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  useEffect(() => {
    if (!bridge) return;
    const unsubscribe = bridge.onState((next) => {
      revision.current += 1;
      setState(next);
    });
    void send({ action: "state" });
    return unsubscribe;
  }, [bridge]);
  return { available: Boolean(bridge), state, error, send };
}

export function ProjectBrowser({
  browser,
}: {
  browser: ReturnType<typeof useProjectBrowser>;
}) {
  const { state, error, send } = browser;
  const viewport = useRef<HTMLDivElement>(null);
  const [address, setAddress] = useState(state.url);
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => setAddress(state.url), [state.url]);
  useEffect(() => {
    if (!state.open || !viewport.current) return;
    let frame = 0;
    let previous = "";
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = viewport.current?.getBoundingClientRect();
        if (!rect) return;
        const bounds = {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.max(0, Math.round(rect.width)),
          height: Math.max(0, Math.round(rect.height)),
        };
        const key = JSON.stringify(bounds);
        if (key === previous) return;
        previous = key;
        void sendRef.current({ action: "bounds", bounds });
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(viewport.current);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [state.open]);
  if (!state.open) return null;
  return (
    <aside
      aria-label="Project browser"
      className="crew-project-browser flex min-h-0 min-w-0 flex-col border-l bg-background"
    >
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <Globe
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span
          className="min-w-0 flex-1 truncate text-sm font-medium"
          title={state.title || "Project browser"}
        >
          {state.title || "Project browser"}
        </span>
        <span className="text-xs text-muted-foreground">Experiment</span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close project browser"
          onClick={() => void send({ action: "close" })}
        >
          <X />
        </Button>
      </div>
      <form
        className="flex shrink-0 items-center gap-1 border-b p-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send({ action: "navigate", url: address });
        }}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Browser back"
          disabled={!state.canGoBack}
          onClick={() => void send({ action: "back" })}
        >
          <ArrowLeft />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Browser forward"
          disabled={!state.canGoForward}
          onClick={() => void send({ action: "forward" })}
        >
          <ArrowRight />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Reload browser page"
          onClick={() => void send({ action: "reload" })}
        >
          {state.loading ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <RotateCw />
          )}
        </Button>
        <Input
          aria-label="Browser address"
          value={address}
          placeholder="http://127.0.0.1:3000"
          onChange={(event) => setAddress(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <Button type="submit" variant="secondary" size="sm">
          Go
        </Button>
      </form>
      {(error || state.error) && (
        <p
          role="alert"
          className="shrink-0 border-b px-3 py-2 text-sm text-destructive"
        >
          {error || state.error}
        </p>
      )}
      <div
        ref={viewport}
        data-browser-viewport
        className="min-h-0 flex-1 bg-muted/20"
        aria-label="Embedded page"
      />
      <p
        role="status"
        className="shrink-0 border-t px-3 py-1.5 text-xs text-muted-foreground"
      >
        {state.automation ||
          "Agent control is not connected in this experiment."}
      </p>
    </aside>
  );
}
