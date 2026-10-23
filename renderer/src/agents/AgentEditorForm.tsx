import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
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
  onRefreshVoices,
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
  onRefreshVoices(): void;
  onOpenAccess?(): void;
}) {
  const id = useId();
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
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Identity</CardTitle>
          <CardDescription>
            How this team member appears and communicates.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
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
            <Label htmlFor={`${id}-picture`}>Profile picture</Label>
            <div className="flex flex-wrap items-center gap-3">
              <AgentPicture
                client={imageClient}
                imageRef={draft.pictureRef}
                className="size-14"
              />
              <Input
                id={`${id}-picture`}
                className="max-w-xs"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={locked}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) onPicture(file);
                }}
              />
              {draft.pictureRef && (
                <Button
                  variant="ghost"
                  disabled={locked}
                  onClick={() => onChange({ pictureRef: null })}
                >
                  Remove picture
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              PNG, JPEG or WebP, up to 512 KB and 2048 × 2048 pixels.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${id}-personality`}>Personality</Label>
            <Textarea
              id={`${id}-personality`}
              rows={3}
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
              <NativeSelect
                id={`${id}-voice`}
                value={draft.voice ?? ""}
                disabled={locked}
                onChange={(event) =>
                  onChange({ voice: event.target.value || null })
                }
              >
                <option value="">Native default</option>
                {draft.voice &&
                  !options?.voices.values.some(
                    (voice) => voice.id === draft.voice,
                  ) && (
                    <option value={draft.voice}>
                      Saved voice: {draft.voice}
                    </option>
                  )}
                {options?.voices.values.map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.name}
                  </option>
                ))}
              </NativeSelect>
              <Button
                variant="outline"
                disabled={locked}
                onClick={onRefreshVoices}
              >
                Refresh voices
              </Button>
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
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Instructions</CardTitle>
          <CardDescription>
            Define responsibilities, working style and when to ask for help.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor={`${id}-instructions`}>System prompt</Label>
          <Textarea
            id={`${id}-instructions`}
            rows={8}
            maxLength={200000}
            value={draft.instructions}
            disabled={locked}
            onChange={(event) => onChange({ instructions: event.target.value })}
          />
          <p className="text-xs leading-5 text-muted-foreground">
            Saving does not start work. For an existing agent, Restart applies
            changed instructions while retaining readable chat history; this
            uses model allowance.
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Access</CardTitle>
          <CardDescription>
            Group memberships determine permissions, project resources, skills
            and service connections.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {!access ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading access groups…
            </p>
          ) : (
            <div className="space-y-1">
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
                <p className="text-sm text-muted-foreground">
                  No access groups configured yet.
                </p>
              )}
            </div>
          )}
          <div className="grid gap-4 border-t pt-4 sm:grid-cols-2">
            <div>
              <h3 className="text-sm font-medium">Inherited permissions</h3>
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {actions.map((action) => (
                  <li key={action}>
                    {access?.crewCapabilities.find(
                      (entry) => entry.action === action,
                    )?.label ?? action}
                  </li>
                ))}
                {!actions.length && <li>No permissions granted.</li>}
              </ul>
            </div>
            <div className="space-y-4">
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
          {onOpenAccess && (
            <Button variant="link" onClick={onOpenAccess}>
              Manage groups and connections
            </Button>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Environment</CardTitle>
          <CardDescription>
            Select the tools available to this agent. Access is still controlled
            by its groups.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={`${id}-template`}>Environment template</Label>
            <NativeSelect
              id={`${id}-template`}
              value={environment.templateId ?? ""}
              disabled={locked || environment.loading || !environment.loaded}
              onChange={(event) =>
                environment.select(event.target.value || null)
              }
            >
              <option value="">No template</option>
              {environment.templateId &&
                !environment.templates.some(
                  (template) => template.id === environment.templateId,
                ) && (
                  <option value={environment.templateId}>
                    Saved template (unavailable)
                  </option>
                )}
              {environment.templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </NativeSelect>
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
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Runtime</CardTitle>
          <CardDescription>
            Model access is separate from service credentials.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm">
            {options?.runtime.label ??
              "ChatGPT subscription · Crew isolated Codex profile"}
          </p>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            This project’s configured runtime is shared by its agents. Manage
            account sign-in and model configuration in Subscription & usage.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
