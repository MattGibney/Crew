import { ArrowRight, CircleHelp, Settings2, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Agent } from "../../../src/agents/contracts.mjs";
import type { AgentsClient, AgentsSnapshot } from "./client";
import { useAgentPicture } from "./AgentPicture";

interface ManagerOverviewProps {
  snapshot: AgentsSnapshot;
  client: AgentsClient;
  pending: boolean;
  onOpen(agent: Agent): void;
  onManage(): void;
}

function sessionLabel(agent: Agent): string {
  const session = agent.runtime.session;
  if (session.observedState === "started")
    return session.activeTurnId ? "Working" : "Idle";
  return {
    stopped: "Stopped",
    starting: "Starting",
    stopping: "Stopping",
    error: "Error",
    unknown: "Unknown",
  }[session.observedState];
}

function ManagerCard({
  agent,
  client,
  workers,
  questions,
  pending,
  onOpen,
}: {
  agent: Agent;
  client: AgentsClient;
  workers: number;
  questions: number;
  pending: boolean;
  onOpen(agent: Agent): void;
}) {
  const picture = useAgentPicture(client, agent.profile.pictureRef);
  const initials =
    agent.profile.name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => Array.from(part)[0] ?? "")
      .join("")
      .toLocaleUpperCase() || "A";
  const label = sessionLabel(agent);
  const working = label === "Working";

  return (
    <button
      type="button"
      aria-label={`Open ${agent.profile.name}`}
      disabled={pending}
      onClick={() => onOpen(agent)}
      className="group flex min-w-0 flex-col rounded-2xl border border-border bg-card p-6 text-left text-card-foreground shadow-sm transition-colors hover:border-primary/40 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
    >
      <div className="mb-6 flex items-start justify-between gap-3">
        <span className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-muted text-xl font-semibold text-muted-foreground">
          {picture ? (
            <img src={picture} alt="" className="size-full object-cover" />
          ) : (
            initials
          )}
        </span>
        <Badge
          variant={label === "Error" ? "destructive" : "outline"}
          className="gap-1.5"
        >
          <span
            aria-hidden="true"
            className={`size-1.5 rounded-full ${working ? "bg-primary" : "bg-current opacity-50"}`}
          />
          {label}
        </Badge>
      </div>
      <h2 className="break-words text-xl font-semibold tracking-tight">
        {agent.profile.name}
      </h2>
      <p className="mt-2 line-clamp-3 min-h-15 text-sm leading-5 text-muted-foreground">
        {agent.profile.personality.trim() ||
          "Open this manager’s chat to discuss work and coordinate their team."}
      </p>
      <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Users aria-hidden="true" className="size-3.5" />
          {workers} {workers === 1 ? "worker" : "workers"}
        </span>
        {questions > 0 && (
          <span className="inline-flex items-center gap-1.5 text-foreground">
            <CircleHelp aria-hidden="true" className="size-3.5" />
            {questions} {questions === 1 ? "open question" : "open questions"}
          </span>
        )}
        <ArrowRight
          aria-hidden="true"
          className="ml-auto size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
        />
      </div>
    </button>
  );
}

export function ManagerOverview({
  snapshot,
  client,
  pending,
  onOpen,
  onManage,
}: ManagerOverviewProps) {
  const active = snapshot.agents.filter((agent) => !agent.archivedAt);
  const managers = active.filter((agent) => agent.reportsTo.type === "user");

  return (
    <section
      aria-labelledby="managers-heading"
      className="mx-auto w-full max-w-6xl px-5 py-8 sm:px-8 sm:py-10"
    >
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1
            id="managers-heading"
            className="text-2xl font-semibold tracking-tight sm:text-3xl"
          >
            Managers
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Choose a manager to chat, review their work, and coordinate their
            team.
          </p>
        </div>
        <Button variant="outline" onClick={onManage} disabled={pending}>
          <Settings2 aria-hidden="true" />
          Manage agents
        </Button>
      </div>
      {managers.length ? (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
          {managers.map((agent) => (
            <ManagerCard
              key={agent.id}
              agent={agent}
              client={client}
              workers={
                active.filter(
                  (worker) =>
                    worker.reportsTo.type === "agent" &&
                    worker.reportsTo.agentId === agent.id,
                ).length
              }
              questions={
                snapshot.helpRequests.filter(
                  (request) =>
                    request.state === "open" &&
                    (request.requesterAgentId === agent.id ||
                      (request.target.type === "agent" &&
                        request.target.agentId === agent.id)),
                ).length
              }
              pending={pending}
              onOpen={onOpen}
            />
          ))}
        </div>
      ) : (
        <div className="flex min-h-72 flex-col items-center justify-center rounded-2xl border border-dashed border-border px-6 py-12 text-center">
          <span className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
            <Users aria-hidden="true" className="size-6" />
          </span>
          <h2 className="text-lg font-semibold">No managers yet</h2>
          <p className="mb-5 mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
            Create an agent who reports to you to start a chat and build your
            team.
          </p>
          <Button onClick={onManage} disabled={pending}>
            Manage agents
          </Button>
        </div>
      )}
    </section>
  );
}
