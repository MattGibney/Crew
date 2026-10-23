import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Info } from "lucide-react";

const categories: Record<string, string> = {
  agents: "Team & sessions", sessions: "Team & sessions",
  messages: "Communication", history: "Communication", help: "Communication",
  jobs: "Work & knowledge", scratchpad: "Work & knowledge", skills: "Work & knowledge",
  resources: "Environment & browser", environments: "Environment & browser", browser: "Environment & browser",
  groups: "Access & services", connections: "Access & services", grants: "Access & services",
};
const names: Record<string, [string, string]> = {
  "agents.read": ["View agents", "Read agent profiles and current state."],
  "agents.create": ["Create agents", "Create agents within the permitted group and project scope."],
  "agents.update": ["Edit agents", "Update agent configuration within the permitted scope."],
  "agents.archive": ["Archive agents", "Archive agents within the permitted scope."],
  "sessions.start": ["Start sessions", "Start an agent’s runtime session."],
  "sessions.stop": ["Stop sessions", "Stop an agent’s runtime session."],
  "sessions.restart": ["Restart sessions", "Restart an agent’s runtime session to apply configuration changes."],
  "messages.send": ["Send messages", "Send messages to permitted recipients."],
  "history.read": ["Read chat history", "Read retained chat history within the permitted scope."],
  "help.request": ["Request help", "Raise questions or requests for assistance."],
  "help.respond": ["Respond to help requests", "Answer help requests within the permitted scope."],
  "jobs.read": ["View jobs", "Read job details and progress."],
  "jobs.create": ["Create jobs", "Create new work records."],
  "jobs.assign": ["Assign jobs", "Assign work to agents."],
  "jobs.update": ["Update jobs", "Update job details, status and progress."],
  "scratchpad.read": ["Read notes", "Read agent scratchpad notes within the permitted scope."],
  "scratchpad.write": ["Write notes", "Update agent scratchpad notes within the permitted scope."],
  "skills.read": ["Read skills", "Read the instructions for available skills."],
  "skills.write": ["Edit skills", "Create or update skill definitions."],
  "skills.assign": ["Assign skills", "Change skill assignments within the permitted scope."],
  "resources.read": ["View resources", "Discover available project resources. File access is controlled separately."],
  "browser.control": ["Control browser", "Use the agent’s browser controls and tabs. Public sites require external browsing access."],
  "browser.external": ["Browse public websites", "Allow public website navigation when browser control is also granted."],
  "environments.read": ["View environments", "Inspect available environments and their state."],
  "environments.create": ["Create environments", "Create working environments using available templates."],
  "environments.attach": ["Attach environments", "Associate permitted environments with agents."],
  "environments.execute": ["Run commands", "Execute commands within the environment’s configured access limits."],
  "environments.dispose": ["Remove environments", "Dispose of owned environments subject to resource safeguards."],
  "groups.read": ["View groups", "Read permission groups and their grants."],
  "groups.write": ["Edit groups", "Create or update permission groups."],
  "groups.assign": ["Assign groups", "Change agent group membership."],
  "connections.read": ["View connections", "Read service connection information, without exposing credentials."],
  "connections.assign": ["Assign connections", "Change service connection assignments."],
  "connections.manage": ["Manage connections", "Configure service connections."],
  "grants.review": ["Review approvals", "Inspect access requests and approval grants."],
  "grants.approve": ["Approve access", "Approve access requests within the permitted authority."],
  "grants.revoke": ["Revoke approvals", "Revoke existing access approval grants."],
};

export function InheritedPermissions({ actions }: { actions: string[] }) {
  const grouped = new Map<string, string[]>();
  for (const action of actions) {
    const category = categories[action.split(".")[0]] ?? "Other permissions";
    grouped.set(category, [...(grouped.get(category) ?? []), action]);
  }
  return <TooltipProvider delay={200}>
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-medium">Inherited permissions</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">Granted by the selected groups. Resource limits and approvals still apply.</p>
      </div>
      <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
        {[...grouped].map(([category, items]) => <div key={category}>
          <h4 className="mb-2 text-xs font-medium text-muted-foreground">{category}</h4>
          <ul className="space-y-1">
            {items.map((action) => {
              const [label, description] = names[action] ?? [action.replaceAll(".", " ").replace(/^./, (letter) => letter.toUpperCase()), "Additional permission granted by a selected group."];
              return <li key={action}><Tooltip>
                <TooltipTrigger render={<Button type="button" variant="ghost" size="sm" className="h-auto max-w-full justify-start gap-2 px-0 py-1 text-left text-xs font-normal whitespace-normal" />}>
                  <span>{label}</span><Info className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                </TooltipTrigger>
                <TooltipContent className="max-w-64 leading-5">{description}</TooltipContent>
              </Tooltip></li>;
            })}
          </ul>
        </div>)}
      </div>
      {!actions.length && <p className="text-xs text-muted-foreground">No permissions granted.</p>}
    </div>
  </TooltipProvider>;
}
