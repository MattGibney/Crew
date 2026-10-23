import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Info, ChevronDown } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { InheritedPermissions } from "./InheritedPermissions";
import { useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Choice } from "../access/shared";
import { AgentPicture, type AgentImageClient } from "./AgentPicture";
import type { AgentSetupDraft } from "../../../src/desktop/agent-setup-contracts.mjs";
import type { AgentConfigurationOptions } from "../../../src/application/agent-configuration-contracts.mjs";
import type { AccessOwnerView } from "../../../src/access/owner-contracts.mjs";
import type { AgentsSnapshot } from "./client";
import type { EditorEnvironment } from "./useEditorEnvironment";

export function AgentEditorForm({
  draft,
  access,
  snapshot,
  directory,
  options,
  optionsError,
  locked,
  imageClient,
  environment,
  onChange,
  onPicture,
  onOpenAccess,
}: {
  draft: AgentSetupDraft;
  access: AccessOwnerView | null;
  snapshot: AgentsSnapshot;
  directory: string;
  options: AgentConfigurationOptions | null;
  optionsError: string;
  locked: boolean;
  imageClient: AgentImageClient;
  environment: EditorEnvironment;
  onChange(patch: Partial<AgentSetupDraft>): void;
  onPicture(file: File): void;
  onOpenAccess?(): void;
}) {
  const id = useId();
  const pictureInput = useRef<HTMLInputElement>(null);
  const selectedTemplate = environment.templates.find((template) => template.id === environment.templateId);
  const groups =
    access?.groups.filter((group) => draft.groupIds.includes(group.id)) ?? [];
  const skillIds = new Set(
    groups.flatMap((group) => group.grants.skillIds ?? []),
  );
  const connectionIds = new Set(
    groups.flatMap((group) =>
      group.grants.services.map((service) => service.connectionId),
    ),
  );
  const actions = [
    ...new Set(
      groups.flatMap((group) => group.grants.crew.map((grant) => grant.action)),
    ),
  ];
  const policies = new Set(
    groups.flatMap((group) => group.grants.environmentPolicyIds),
  );
  return (
    <div className="space-y-10 pb-8">
      <section className="grid gap-6 md:grid-cols-[minmax(0,0.8fr)_minmax(0,2fr)] md:gap-8">
        <div className="space-y-2">
          <h2 className="text-base font-semibold tracking-tight">Identity</h2>
          <p className="text-sm leading-6 text-muted-foreground">
            How this team member appears and communicates.
          </p>
        </div>
        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor={`${id}-picture`}>Profile picture</Label>
            <div className="flex flex-wrap items-center gap-3">
              <AgentPicture
                client={imageClient}
                imageRef={draft.pictureRef}
                className="size-20 shrink-0"
              />
              <Input
                id={`${id}-picture`}
                ref={pictureInput}
                className="hidden"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={locked}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) onPicture(file);
                }}
              />
              <Button variant="outline" disabled={locked} onClick={() => pictureInput.current?.click()}>
                Change picture
              </Button>
              {draft.pictureRef && (
                <Button
                  variant="ghost"
                  disabled={locked}
                  onClick={() => onChange({ pictureRef: null })}
                >
                  Remove
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              PNG, JPEG or WebP, up to 512 KB and 2048 × 2048 pixels.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${id}-name`}>
              Name <span className="text-muted-foreground">(required)</span>
            </Label>
            <Input
              id={`${id}-name`}
              value={draft.name}
              maxLength={200}
              disabled={locked}
              onChange={(event) => onChange({ name: event.target.value })}
              aria-invalid={!draft.name.trim()}
            />
            {!draft.name.trim() && (
              <p className="text-xs text-destructive">
                Enter a name for this agent.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Label htmlFor={`${id}-personality`}>Personality</Label>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger render={<Button type="button" variant="ghost" size="icon" className="size-5 text-muted-foreground" aria-label="About personality" />}>
                    <Info className="size-3.5" aria-hidden="true" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-72 leading-5">
                    Describe their tone, communication style and approach to working with you.
                    For example: “Warm and direct. Keeps answers concise, offers a clear recommendation,
                    and asks questions when unsure.” Put responsibilities and workflows in System prompt below.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <Textarea
              id={`${id}-personality`}
              rows={3}
              className="min-h-24 leading-6"
              value={draft.personality}
              disabled={locked}
              onChange={(event) =>
                onChange({ personality: event.target.value })
              }
              placeholder="How should this colleague communicate and approach work?"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${id}-voice`}>Voice</Label>
            <div className="flex flex-wrap gap-2">
              <Select
                value={draft.voice ?? ""}
                disabled={locked}
                onValueChange={(value) => onChange({ voice: value || null })}
                items={[
                  { value: "", label: "Native default" },
                  ...(options?.voices.values ?? []).map((voice) => ({ value: voice.id, label: voice.name })),
                  ...(draft.voice && !options?.voices.values.some((voice) => voice.id === draft.voice)
                    ? [{ value: draft.voice, label: `Saved voice: ${draft.voice}` }] : []),
                ]}
              >
                <SelectTrigger id={`${id}-voice`} className="min-w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Native default</SelectItem>
                  {draft.voice && !options?.voices.values.some((voice) => voice.id === draft.voice) && (
                    <SelectItem value={draft.voice}>Saved voice: {draft.voice}</SelectItem>
                  )}
                  {options?.voices.values.map((voice) => (
                    <SelectItem key={voice.id} value={voice.id}>{voice.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

            </div>
            <p className="text-xs text-muted-foreground">
              Used for this agent’s next voice call.
            </p>
            {optionsError && (
              <p role="alert" className="text-xs text-destructive">
                {optionsError}
              </p>
            )}
          </div>
        </div>
      </section>
      <Separator />
      <section className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-base font-semibold tracking-tight">Instructions</h2>
            <p className="text-sm text-muted-foreground">Set this agent’s responsibilities, standards and workflow.</p>
          </div>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger render={<Button type="button" variant="ghost" size="sm" className="text-muted-foreground" />}>
                <Info className="size-3.5" /> Writing guidance
              </TooltipTrigger>
              <TooltipContent className="max-w-80 leading-5">
                Include the agent’s role, expected outcomes, technical standards,
                workflow steps and when to ask for help. For example: “Review the
                relevant code, implement the change, run focused checks, and report
                the result. Ask before deploying.”
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${id}-instructions`} className="sr-only">System prompt</Label>
          <Textarea
            id={`${id}-instructions`}
            aria-describedby={`${id}-instructions-help ${id}-instructions-save`}
            rows={9}
            className="min-h-64 resize-y p-4 text-sm leading-7"
            maxLength={200000}
            value={draft.instructions}
            disabled={locked}
            placeholder="Describe the agent’s role, responsibilities, technical standards and workflow…"
            onChange={(event) => onChange({ instructions: event.target.value })}
          />
          <p id={`${id}-instructions-help`} className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            Personality is added automatically. Focus here on how the agent does its work.
          </p>
        </div>
        <Collapsible className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <p id={`${id}-instructions-save`} className="text-xs text-muted-foreground">Save your edits, then restart the agent to apply them to an existing chat.</p>
            <CollapsibleTrigger render={<Button type="button" variant="ghost" size="sm" className="group px-0 text-xs text-muted-foreground" />}>
              How changes take effect <ChevronDown className="size-3.5 transition-transform group-data-panel-open:rotate-180" />
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent className="space-y-2 text-xs leading-5 text-muted-foreground">
            <p>Saving stores your instructions and personality without starting the agent or interrupting its current work.</p>
            <p>Restart applies those changes while keeping the same chat and readable history. Codex summarizes the active context during this process, which uses some of your subscription allowance.</p>
          </CollapsibleContent>
        </Collapsible>
      </section>
      <Separator />
      <section className="grid gap-6 md:grid-cols-[minmax(0,0.8fr)_minmax(0,2fr)] md:gap-8">
        <div className="space-y-2">
          <h2 className="text-base font-semibold tracking-tight">Access</h2>
          <p className="text-sm leading-6 text-muted-foreground">
            Group memberships determine permissions, project resources, skills
            and service connections.
          </p>
        </div>
        <div className="space-y-5">
          {!access ? (
            <p role="status" className="text-sm leading-6 text-muted-foreground">
              Loading access groups…
            </p>
          ) : (
            <div className="space-y-2">
              {access.groups.map((group) => (
                <Choice
                  key={group.id}
                  checked={draft.groupIds.includes(group.id)}
                  disabled={locked}
                  onChange={(checked) =>
                    onChange({
                      groupIds: checked
                        ? [...new Set([...draft.groupIds, group.id])]
                        : draft.groupIds.filter((value) => value !== group.id),
                    })
                  }
                  description={group.description}
                >
                  {group.name}
                </Choice>
              ))}
              {!access.groups.length && (
                <p className="text-sm leading-6 text-muted-foreground">
                  No access groups configured yet.
                </p>
              )}
            </div>
          )}
          <div className="space-y-6 border-t pt-5">
            <InheritedPermissions actions={actions} />
            <div className="grid gap-6 border-t pt-5 sm:grid-cols-2">
              <div>
                <h3 className="text-sm font-medium">Inherited skills</h3>
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {[...skillIds].map((skillId) => (
                    <li key={skillId}>
                      {snapshot.skills.find((skill) => skill.id === skillId)
                        ?.name ?? "Unavailable skill"}
                    </li>
                  ))}
                  {!skillIds.size && <li>No skills assigned.</li>}
                </ul>
              </div>
              <div>
                <h3 className="text-sm font-medium">Connected services</h3>
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {[...connectionIds].map((connectionId) => (
                    <li key={connectionId}>
                      {access?.connections.find(
                        (connection) => connection.id === connectionId,
                      )?.name ?? "Unavailable connection"}
                    </li>
                  ))}
                  {!connectionIds.size && <li>No connections granted.</li>}
                </ul>
              </div>
            </div>
          </div>
          <div className="space-y-1 border-t pt-3">
            <p className="text-sm font-medium">Project resources</p>
            <p className="break-all text-xs text-muted-foreground">
              {directory}
            </p>
            <p className="text-xs text-muted-foreground">
              {policies.size
                ? `${policies.size} folder ${policies.size === 1 ? "policy" : "policies"} granted through selected groups.`
                : "No folder access granted by selected groups."}
            </p>
          </div>
          {onOpenAccess && (
            <Button variant="link" className="px-0" onClick={onOpenAccess}>
              Manage groups and connections
            </Button>
          )}
        </div>
      </section>
      <Separator />
      <section className="grid gap-6 md:grid-cols-[minmax(0,0.8fr)_minmax(0,2fr)] md:gap-8">
        <div className="space-y-2">
          <h2 className="text-base font-semibold tracking-tight">Environment</h2>
          <p className="text-sm leading-6 text-muted-foreground">
            Select the tools available to this agent. Access is still controlled
            by its groups.
          </p>
        </div>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={`${id}-template`}>Environment template</Label>
            <Select
              value={environment.templateId ?? ""}
              disabled={locked || environment.loading || !environment.loaded}
              onValueChange={(value) => environment.select(value || null)}
              items={[
                { value: "", label: "No template" },
                ...environment.templates.map((template) => ({ value: template.id, label: template.name })),
                ...(environment.templateId && !environment.templates.some((template) => template.id === environment.templateId)
                  ? [{ value: environment.templateId, label: "Saved template (unavailable)" }] : []),
              ]}
            >
              <SelectTrigger id={`${id}-template`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">No template</SelectItem>
                {environment.templateId && !environment.templates.some((template) => template.id === environment.templateId) && (
                  <SelectItem value={environment.templateId}>Saved template (unavailable)</SelectItem>
                )}
                {environment.templates.map((template) => (
                  <SelectItem key={template.id} value={template.id}>{template.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {environment.loading && (
              <p className="text-xs text-muted-foreground">
                Loading templates…
              </p>
            )}
            {environment.error && (
              <p role="alert" className="text-xs text-destructive">
                {environment.error}
              </p>
            )}
            {environment.error && (
              <Button
                variant="outline"
                disabled={locked}
                onClick={environment.reload}
              >
                Retry templates
              </Button>
            )}
            <p className="text-xs text-muted-foreground">
              Saved with the agent. Selecting a template does not prepare or
              launch its environment.
            </p>
          </div>
          {selectedTemplate ? (
            <div className="space-y-5 border-t pt-4" aria-live="polite">
              {selectedTemplate.description && <p className="text-sm leading-6 text-muted-foreground">{selectedTemplate.description}</p>}
              <div className="space-y-2">
                <h3 className="text-sm font-medium">Tools</h3>
                {selectedTemplate.tools.length ? <div className="flex flex-wrap gap-2">
                  {selectedTemplate.tools.map((tool) => <Badge variant="secondary" key={tool.name}>
                    {({ node: "Node.js", npm: "npm", git: "Git", python3: "Python", magick: "ImageMagick" } as Record<string, string>)[tool.name] ?? tool.name}
                    {tool.versionRequirement && <span className="font-normal text-muted-foreground">{tool.versionRequirement}</span>}
                  </Badge>)}
                </div> : <p className="text-xs text-muted-foreground">No tools specified by this template.</p>}
              </div>
              <div className="space-y-2">
                <h3 className="text-sm font-medium">Environment setup</h3>
                <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-xs">
                  <dt className="text-muted-foreground">Network access</dt><dd>{selectedTemplate.capabilities.network ? "Enabled" : "Disabled"}</dd>
                  <dt className="text-muted-foreground">Package downloads</dt><dd>{selectedTemplate.capabilities.packageDownloads ? "Enabled" : "Disabled"}</dd>
                </dl>
                <p className="text-xs leading-5 text-muted-foreground">Template requirements, not confirmation that tools are installed. The agent prepares its environment separately.</p>
              </div>
            </div>
          ) : !environment.loading && !environment.error && (
            <p className="text-xs text-muted-foreground">{environment.templateId ? "Details for the saved template are unavailable." : "No template selected. No tools or setup requirements are specified."}</p>
          )}
        </div>
      </section>
      <Separator />
      <section className="grid gap-6 md:grid-cols-[minmax(0,0.8fr)_minmax(0,2fr)] md:gap-8">
        <div className="space-y-2">
          <h2 className="text-base font-semibold tracking-tight">Runtime</h2>
          <p className="text-sm leading-6 text-muted-foreground">
            Model access is separate from service credentials.
          </p>
        </div>
        <div>
          <p className="text-sm">
            {options?.runtime.label ??
              "ChatGPT subscription · Crew isolated Codex profile"}
          </p>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            This project’s configured runtime is shared by its agents. Manage
            account sign-in and model configuration in Subscription & usage.
          </p>
        </div>
      </section>
    </div>
  );
}
