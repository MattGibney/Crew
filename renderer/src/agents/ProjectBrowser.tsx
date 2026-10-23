import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Globe,
  LoaderCircle,
  MousePointer2,
  Plus,
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
type AnnotationTarget = {
  id: string;
  name: string;
  tabId: string;
  url: string;
  scope: "page" | "element";
};
export interface ProjectBrowserProps {
  snapshot: AgentsSnapshot;
  selectedAgent: Agent | null;
  client: AgentsClient;
  visible: boolean;
}

/** Native content belongs to an agent and tab. Hiding this surface never closes it. */
export function ProjectBrowser({
  snapshot,
  selectedAgent,
  client,
  visible,
}: ProjectBrowserProps) {
  const bridge = window.crewDesktop;
  const projectId = snapshot.projectId;
  const agents = snapshot.agents.filter((agent) => !agent.archivedAt);
  const [ownerId, setOwnerId] = useState<string | null>(
    selectedAgent && !selectedAgent.archivedAt
      ? selectedAgent.id
      : (agents[0]?.id ?? null),
  );
  const owner = agents.find((agent) => agent.id === ownerId);
  const [storedState, setState] = useState<BrowserState>(initialState);
  const state =
    (storedState.ownerAgentId ?? storedState.recipientAgentId ?? null) ===
    ownerId
      ? storedState
      : initialState;
  const [location, setLocation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [comment, setComment] = useState("");
  const [annotationTarget, setAnnotationTarget] =
    useState<AnnotationTarget | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const latestRequest = useRef(0);
  const eventRevision = useRef(0);
  const ownerRef = useRef(ownerId);
  const stateRef = useRef(state);
  const drafts = useRef(new Map<string, string>());
  ownerRef.current = ownerId;
  stateRef.current = state;
  const tabId = state.activeTabId ?? null;
  const identity = `${projectId}:${ownerId ?? ""}:${tabId ?? ""}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const annotationMatches =
    !!annotationTarget &&
    annotationTarget.id === ownerId &&
    annotationTarget.tabId === tabId &&
    annotationTarget.url === state.url;

  const request = useCallback(
    async (input: Omit<BrowserRequest, "projectId">) => {
      if (!bridge)
        throw new Error("The browser is available in the Crew desktop app.");
      return (await bridge.request("browser", {
        ...input,
        projectId,
      })) as BrowserState;
    },
    [bridge, projectId],
  );

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = bridge?.subscribe((value) => {
      const event = value as Partial<BrowserEvent> | null;
      if (
        event?.type === "browser" &&
        event.projectId === projectId &&
        event.state &&
        (event.state.ownerAgentId ?? event.state.recipientAgentId ?? null) ===
          ownerRef.current
      ) {
        eventRevision.current += 1;
        stateRef.current = event.state;
        setState(event.state);
      }
    });
    return () => {
      mounted.current = false;
      unsubscribe?.();
    };
  }, [bridge, projectId]);

  useEffect(() => {
    if (visible && selectedAgent && !selectedAgent.archivedAt)
      setOwnerId(selectedAgent.id);
  }, [visible, selectedAgent?.id, selectedAgent?.archivedAt]);

  useEffect(() => {
    if (
      ownerId &&
      !snapshot.agents.some(
        (agent) => agent.id === ownerId && !agent.archivedAt,
      )
    )
      setOwnerId(null);
  }, [snapshot.agents, ownerId]);

  useEffect(() => {
    let live = true;
    const revision = eventRevision.current;
    ++latestRequest.current;
    setPending(false);
    setState(initialState);
    setError("");
    setNotice("");
    if (bridge && ownerId)
      void request({ action: "select_agent", agentId: ownerId })
        .then((next) => {
          if (
            live &&
            ownerRef.current === ownerId &&
            revision === eventRevision.current
          )
            setState(next);
        })
        .catch((failure) => {
          if (live)
            setError(
              failure instanceof Error
                ? failure.message
                : "Crew could not read this agent's browser.",
            );
        });
    return () => {
      live = false;
    };
  }, [bridge, projectId, ownerId, request]);

  useEffect(() => {
    setLocation(
      drafts.current.get(identity) ??
        (state.url === "about:blank" ? "" : state.url),
    );
  }, [identity, state.url]);

  useEffect(() => {
    if (!bridge || !ownerId || !tabId || !state.open) return;
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
          agentId: ownerId,
          tabId,
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
              "The browser could not update its position. Reopen the browser panel to retry.",
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
      void request({
        action: "bounds",
        agentId: ownerId,
        tabId,
        visible: false,
      }).catch(() => {});
    };
  }, [bridge, request, ownerId, tabId, state.open, visible]);

  const run = async (input: Omit<BrowserRequest, "projectId">) => {
    if (!ownerId) return null;
    const currentOwner = ownerId;
    const revision = eventRevision.current;
    const sequence = ++latestRequest.current;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const next = await request({
        agentId: currentOwner,
        ...(tabId ? { tabId } : {}),
        ...input,
      });
      if (
        mounted.current &&
        ownerRef.current === currentOwner &&
        sequence === latestRequest.current &&
        revision === eventRevision.current
      )
        setState(next);
      if (
        revision !== eventRevision.current &&
        (next.activeTabId !== stateRef.current.activeTabId ||
          next.url !== stateRef.current.url)
      )
        return null;
      return next;
    } catch (failure) {
      if (
        mounted.current &&
        ownerRef.current === currentOwner &&
        sequence === latestRequest.current
      )
        setError(
          failure instanceof Error
            ? failure.message
            : "The browser action failed. Try again.",
        );
      return null;
    } finally {
      if (mounted.current && sequence === latestRequest.current)
        setPending(false);
    }
  };

  const beginAnnotation = async (element: boolean) => {
    if (!owner || !tabId) return;
    const target: AnnotationTarget = {
      id: owner.id,
      name: owner.profile.name,
      tabId,
      url: state.url,
      scope: element ? "element" : "page",
    };
    setAnnotationTarget(target);
    setNotice("");
    setError("");
    if (element) {
      const result = await run({
        action: "selectElement",
        agentId: target.id,
        tabId: target.tabId,
        recipientAgentId: target.id,
      });
      if (!result)
        setAnnotationTarget((current) => (current === target ? null : current));
    }
  };

  const sendAnnotation = async () => {
    if (!annotationTarget || !comment.trim() || pending || !state.open) return;
    const target = annotationTarget;
    const submitted = comment;
    const matches = () =>
      ownerRef.current === target.id &&
      stateRef.current.activeTabId === target.tabId &&
      stateRef.current.url === target.url;
    const sequence = ++latestRequest.current;
    setPending(true);
    setError("");
    setNotice("");
    try {
      if (!matches())
        throw new Error(
          "The browser tab or page changed. Capture the intended page again; your feedback has been kept.",
        );
      if (
        !snapshot.agents.some(
          (agent) => agent.id === target.id && !agent.archivedAt,
        )
      )
        throw new Error(
          "This agent is no longer available. Your feedback has been kept.",
        );
      const captured = await request({
        action: "annotation",
        agentId: target.id,
        tabId: target.tabId,
        recipientAgentId: target.id,
        comment: submitted.trim(),
        annotationScope: target.scope,
      });
      if (
        !matches() ||
        captured.activeTabId !== target.tabId ||
        captured.url !== target.url
      )
        throw new Error(
          "The browser tab or page changed. Capture the intended page again; your feedback has been kept.",
        );
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
      if (mounted.current && sequence === latestRequest.current) {
        setComment((current) => (current === submitted ? "" : current));
        setNotice(`Annotation queued for ${target.name}.`);
      }
    } catch (failure) {
      if (mounted.current && sequence === latestRequest.current)
        setError(
          failure instanceof Error
            ? failure.message
            : "The annotation could not be sent. Your feedback has been kept.",
        );
    } finally {
      if (mounted.current && sequence === latestRequest.current)
        setPending(false);
    }
  };

  return (
    <section
      className="project-browser"
      aria-label="Agent browser"
      hidden={!visible}
    >
      <div className="project-browser-owner">
        <Globe className="size-4 text-muted-foreground" aria-hidden="true" />
        <label htmlFor="browser-owner" className="text-sm font-medium">
          Browser for
        </label>
        <select
          id="browser-owner"
          className="project-browser-agent-select"
          value={ownerId ?? ""}
          onChange={(event) => setOwnerId(event.target.value || null)}
          disabled={!bridge}
        >
          <option value="" disabled>
            Choose an agent
          </option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.profile.name}
            </option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground">
          Each agent keeps its own tabs.
        </span>
      </div>
      <div
        className="project-browser-tabs"
        role="tablist"
        aria-label="Browser tabs"
      >
        {(state.tabs ?? []).map((tab) => (
          <div
            className="project-browser-tab"
            data-active={tab.id === tabId}
            key={tab.id}
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab.id === tabId}
              aria-label={tab.title || tab.url || "New tab"}
              disabled={pending}
              onClick={() => void run({ action: "select_tab", tabId: tab.id })}
            >
              {tab.loading ? (
                <LoaderCircle
                  className="size-3 animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <Globe className="size-3" aria-hidden="true" />
              )}
              <span>
                {tab.title ||
                  (tab.url && tab.url !== "about:blank" ? tab.url : "New tab")}
              </span>
            </button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Close ${tab.title || "tab"}`}
              title="Close tab"
              disabled={pending}
              onClick={() => void run({ action: "close_tab", tabId: tab.id })}
            >
              <X />
            </Button>
          </div>
        ))}
        <Button
          variant="ghost"
          size="icon"
          aria-label="New tab"
          title="New tab"
          disabled={pending || !bridge || !owner}
          onClick={() => void run({ action: "new_tab" })}
        >
          <Plus />
        </Button>
      </div>
      <div className="project-browser-toolbar">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Back"
          title="Back"
          disabled={pending || !state.canGoBack || !tabId}
          onClick={() => void run({ action: "back" })}
        >
          <ArrowLeft />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Forward"
          title="Forward"
          disabled={pending || !state.canGoForward || !tabId}
          onClick={() => void run({ action: "forward" })}
        >
          <ArrowRight />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Reload page"
          title="Reload page"
          disabled={pending || !state.open || !tabId}
          onClick={() => void run({ action: "reload" })}
        >
          <RotateCw className={state.loading ? "animate-spin" : ""} />
        </Button>
        <form
          className="project-browser-location"
          onSubmit={(event) => {
            event.preventDefault();
            const submittedIdentity = identity;
            const submitted = location;
            void run({
              action: state.open ? "navigate" : "open",
              url: location.trim() || "about:blank",
            }).then((next) => {
              if (next && drafts.current.get(submittedIdentity) === submitted) {
                drafts.current.delete(submittedIdentity);
                if (identityRef.current === submittedIdentity)
                  setLocation(next.url === "about:blank" ? "" : next.url);
              }
            });
          }}
        >
          <Input
            aria-label="Page address"
            placeholder="Local preview or permitted public website URL"
            value={location}
            disabled={!owner || !bridge}
            onChange={(event) => {
              drafts.current.set(identity, event.target.value);
              setLocation(event.target.value);
            }}
          />
          <Button
            variant="secondary"
            type="submit"
            disabled={pending || !bridge || !owner}
          >
            {state.open ? "Go" : "Open page"}
          </Button>
        </form>
      </div>
      <div className="project-browser-viewport" ref={viewport}>
        {!state.open && (
          <div className="project-browser-empty">
            {!bridge
              ? "Open this project in the Crew desktop app to browse."
              : !owner
                ? "Choose an agent to inspect its browser."
                : "Enter a page address to browse, or add a tab. This agent's tabs stay available when you switch agents."}
          </div>
        )}
      </div>
      <div className="project-browser-annotation">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!owner || !state.open || !tabId || pending}
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
            disabled={!owner || !state.open || !tabId || pending}
            onClick={() => void beginAnnotation(false)}
          >
            Annotate page
          </Button>
          {annotationTarget && (
            <span className="text-xs text-muted-foreground">
              To {annotationTarget.name}
              {annotationMatches
                ? annotationTarget.scope === "element" && state.selection
                  ? ` · ${state.selection.selector || state.selection.text?.slice(0, 80) || "Selected element"}`
                  : " · Current page"
                : " · Page changed; capture again to send"}
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
                !annotationMatches ||
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
