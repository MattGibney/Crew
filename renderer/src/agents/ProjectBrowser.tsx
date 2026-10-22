import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Globe,
  LoaderCircle,
  MousePointer2,
  RotateCw,
  Send,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { Agent } from "../../../src/agents/contracts.mjs";
import type {
  BrowserEvent,
  BrowserRequest,
  BrowserState,
} from "../contracts/browser";
import type { AgentsClient, AgentsSnapshot } from "./client";
import "./project-browser.css";

const initialState: BrowserState = {
  open: false,
  url: "",
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false,
};

export interface ProjectBrowserProps {
  snapshot: AgentsSnapshot;
  selectedAgent: Agent | null;
  client: AgentsClient;
  visible: boolean;
}

/** Native page content remains in the project-owned WebContentsView. Only
 * owner commands and sanitized browser state cross this renderer bridge. */
export function ProjectBrowser({
  snapshot,
  selectedAgent,
  client,
  visible,
}: ProjectBrowserProps) {
  const bridge = window.crewDesktop;
  const projectId = snapshot.projectId;
  const [state, setState] = useState<BrowserState>(initialState);
  const [location, setLocation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [comment, setComment] = useState("");
  const [annotationTarget, setAnnotationTarget] = useState<{
    id: string;
    name: string;
    scope: "page" | "element";
  } | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const latestRequest = useRef(0);
  const locationFocused = useRef(false);
  const selected =
    selectedAgent && !selectedAgent.archivedAt ? selectedAgent : null;

  const request = useCallback(
    async (input: Omit<BrowserRequest, "projectId">) => {
      if (!bridge)
        throw new Error(
          "The project browser is available in the Crew desktop app.",
        );
      return (await bridge.request("browser", {
        ...input,
        projectId,
      })) as BrowserState;
    },
    [bridge, projectId],
  );

  useEffect(() => {
    mounted.current = true;
    let live = true;
    setState(initialState);
    setAnnotationTarget(null);
    setComment("");
    setError("");
    if (!bridge) return;
    const apply = (next: BrowserState) => {
      if (live) setState(next);
    };
    void request({ action: "state" })
      .then(apply)
      .catch(() => {
        if (live)
          setError(
            "Crew could not read the project browser. Try opening it again.",
          );
      });
    const unsubscribe = bridge.subscribe((value) => {
      const event = value as Partial<BrowserEvent> | null;
      if (
        event?.type === "browser" &&
        event.projectId === projectId &&
        event.state
      )
        apply(event.state);
    });
    return () => {
      live = false;
      mounted.current = false;
      unsubscribe();
    };
  }, [bridge, projectId, request]);

  useEffect(() => {
    if (!bridge) return;
    let live = true;
    void request({ action: "state" })
      .then((next) => {
        if (live) setState(next);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [
    request,
    selected?.id,
    selected?.runtime.session.sessionId,
    selected?.runtime.session.observedState,
  ]);

  useEffect(() => {
    if (!locationFocused.current)
      setLocation(state.url === "about:blank" ? "" : state.url);
  }, [state.url]);

  useEffect(() => {
    if (!bridge || !state.open) return;
    const element = viewport.current;
    let frame = 0;
    let disposed = false;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (disposed) return;
        const bounds = element?.getBoundingClientRect();
        const show =
          visible && !!bounds && bounds.width > 0 && bounds.height > 0;
        void request({
          action: "bounds",
          visible: show,
          ...(bounds
            ? {
                bounds: {
                  x: Math.round(bounds.x),
                  y: Math.round(bounds.y),
                  width: Math.round(bounds.width),
                  height: Math.round(bounds.height),
                },
              }
            : {}),
        }).catch(() => {
          if (!disposed)
            setError(
              "The browser could not update its position. Close and reopen it to retry.",
            );
        });
      });
    };
    const observer = new ResizeObserver(measure);
    if (element) observer.observe(element);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    measure();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      void request({ action: "bounds", visible: false }).catch(() => {});
    };
  }, [bridge, request, state.open, visible]);

  const run = async (input: Omit<BrowserRequest, "projectId">) => {
    const identity = ++latestRequest.current;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const next = await request(input);
      if (mounted.current && identity === latestRequest.current) setState(next);
      return next;
    } catch (failure) {
      if (mounted.current)
        setError(
          failure instanceof Error
            ? failure.message
            : "The browser action failed. Try again.",
        );
      return null;
    } finally {
      if (mounted.current && identity === latestRequest.current)
        setPending(false);
    }
  };

  const beginAnnotation = async (element: boolean) => {
    if (!selected) return;
    const target = {
      id: selected.id,
      name: selected.profile.name,
      scope: element ? ("element" as const) : ("page" as const),
    };
    setAnnotationTarget(target);
    setNotice("");
    setError("");
    if (element) {
      const result = await run({
        action: "selectElement",
        recipientAgentId: target.id,
      });
      if (!result) setAnnotationTarget(null);
    }
  };

  const sendAnnotation = async () => {
    if (
      !annotationTarget ||
      !comment.trim() ||
      pending ||
      !state.open ||
      (annotationTarget.scope === "element" &&
        (!state.selection || state.selecting))
    )
      return;
    // Preserve the captured recipient even if the owner selects another agent.
    const target = annotationTarget;
    const submitted = comment;
    setPending(true);
    setError("");
    setNotice("");
    try {
      if (
        !snapshot.agents.some(
          (agent) => agent.id === target.id && !agent.archivedAt,
        )
      )
        throw new Error(
          "The annotation recipient is no longer available. Choose an agent and capture again.",
        );
      const captured = await request({
        action: "annotation",
        recipientAgentId: target.id,
        comment: submitted.trim(),
        annotationScope: target.scope,
      });
      if (!captured.annotation?.content.length)
        throw new Error(
          "Crew could not capture page context. Your feedback has been kept.",
        );
      await client.sendMessage({
        recipientAgentId: target.id,
        jobId: null,
        replyToMessageId: null,
        content: captured.annotation.content,
        deliveryMode: "queue",
      });
      if (mounted.current) {
        setState(captured);
        setComment((current) => (current === submitted ? "" : current));
        setNotice(`Annotation queued for ${target.name}.`);
      }
    } catch (failure) {
      if (mounted.current)
        setError(
          failure instanceof Error
            ? failure.message
            : "The annotation could not be sent. Your feedback has been kept.",
        );
    } finally {
      if (mounted.current) setPending(false);
    }
  };

  const boundAgent = snapshot.agents.find(
    (agent) => agent.id === state.recipientAgentId,
  );
  return (
    <section
      className="project-browser"
      aria-label="Project browser"
      hidden={!visible}
    >
      <div className="project-browser-toolbar">
        <Globe className="size-4 text-muted-foreground" aria-hidden="true" />
        <span className="text-sm font-medium">Browser</span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Back"
          title="Back"
          disabled={pending || !state.canGoBack}
          onClick={() => void run({ action: "back" })}
        >
          <ArrowLeft />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Forward"
          title="Forward"
          disabled={pending || !state.canGoForward}
          onClick={() => void run({ action: "forward" })}
        >
          <ArrowRight />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Reload page"
          title="Reload page"
          disabled={pending || !state.open}
          onClick={() => void run({ action: "reload" })}
        >
          <RotateCw className={state.loading ? "animate-spin" : ""} />
        </Button>
        <form
          className="project-browser-location"
          onSubmit={(event) => {
            event.preventDefault();
            void run({
              action: state.open ? "navigate" : "open",
              url: location.trim() || "about:blank",
              ...(selected ? { recipientAgentId: selected.id } : {}),
            });
          }}
        >
          <Input
            aria-label="Page address"
            placeholder="Enter a local app URL, e.g. http://127.0.0.1:3000"
            value={location}
            onChange={(event) => setLocation(event.target.value)}
            onFocus={() => {
              locationFocused.current = true;
            }}
            onBlur={() => {
              locationFocused.current = false;
            }}
          />
          <Button
            variant="secondary"
            type="submit"
            disabled={pending || !bridge}
          >
            {state.open ? "Go" : "Open browser"}
          </Button>
        </form>
        {state.open && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close browser"
            title="Close browser"
            disabled={pending}
            onClick={() => void run({ action: "close" })}
          >
            <X />
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2 text-xs text-muted-foreground">
        <span>
          {boundAgent
            ? `Browser control: ${boundAgent.profile.name}`
            : "Select an agent to connect browser control."}
        </span>
        {selected && state.open && state.recipientAgentId !== selected.id && (
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() =>
              void run({ action: "open", recipientAgentId: selected.id })
            }
          >
            Connect {selected.profile.name}
          </Button>
        )}
        <span className="truncate">{state.title}</span>
      </div>
      <div className="project-browser-viewport" ref={viewport}>
        {!state.open && (
          <div className="project-browser-empty">
            {bridge
              ? "Open a page to browse and share feedback with an agent."
              : "Open this project in the Crew desktop app to browse."}
          </div>
        )}
      </div>
      <div className="project-browser-annotation">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!selected || !state.open || pending}
            onClick={() => void beginAnnotation(true)}
          >
            <MousePointer2 />
            {state.selecting
              ? "Click an element in the page…"
              : "Select element"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!selected || !state.open || pending}
            onClick={() => void beginAnnotation(false)}
          >
            Annotate page
          </Button>
          {!selected && (
            <span className="text-xs text-muted-foreground">
              Choose a Crew agent to send feedback.
            </span>
          )}
          {annotationTarget && (
            <span className="text-xs text-muted-foreground">
              To {annotationTarget.name}
              {annotationTarget.scope === "element" && state.selection
                ? ` · ${state.selection.selector || state.selection.text?.slice(0, 80) || "Selected element"}`
                : " · Current page"}
            </span>
          )}
        </div>
        {annotationTarget && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void sendAnnotation();
            }}
          >
            <Textarea
              aria-label={`Feedback for ${annotationTarget.name}`}
              placeholder="Describe the change or question…"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
            />
            <Button
              type="submit"
              disabled={
                pending ||
                !comment.trim() ||
                (annotationTarget.scope === "element" &&
                  (!state.selection || state.selecting)) ||
                !state.open
              }
            >
              {pending ? <LoaderCircle className="animate-spin" /> : <Send />}
              Send annotation
            </Button>
          </form>
        )}
        {(error || state.error) && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {error || state.error}
          </p>
        )}
        {notice && (
          <p role="status" className="mt-2 text-sm text-muted-foreground">
            {notice}
          </p>
        )}
      </div>
    </section>
  );
}
