import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Info, ChevronDown } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type PromptFieldProps = {
  id: string;
  value: string;
  locked: boolean;
  onChange(value: string): void;
};

export function PersonalityField({
  id,
  value,
  locked,
  onChange,
}: PromptFieldProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Label htmlFor={`${id}-personality`}>Personality</Label>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-5 text-muted-foreground"
                  aria-label="About personality"
                />
              }
            >
              <Info className="size-3.5" aria-hidden="true" />
            </TooltipTrigger>
            <TooltipContent className="max-w-72 leading-5">
              Describe their tone, communication style and approach to working
              with you. For example: “Warm and direct. Keeps answers concise,
              offers a clear recommendation, and asks questions when unsure.”
              Put responsibilities and workflows in System prompt below.
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <Textarea
        id={`${id}-personality`}
        rows={3}
        className="min-h-24 leading-6"
        value={value}
        disabled={locked}
        onChange={(event) => onChange(event.target.value)}
        placeholder="How should this colleague communicate and approach work?"
      />
    </div>
  );
}

export function AgentInstructionsSection({
  id,
  value,
  locked,
  onChange,
  template = false,
}: PromptFieldProps & { template?: boolean }) {
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-base font-semibold tracking-tight">
            Instructions
          </h2>
          <p className="text-sm text-muted-foreground">
            Set this agent’s responsibilities, standards and workflow.
          </p>
        </div>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                />
              }
            >
              <Info className="size-3.5" /> Writing guidance
            </TooltipTrigger>
            <TooltipContent className="max-w-80 leading-5">
              Include the agent’s role, expected outcomes, technical standards,
              workflow steps and when to ask for help. For example: “Review the
              relevant code, implement the change, run focused checks, and
              report the result. Ask before deploying.”
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${id}-instructions`} className="sr-only">
          System prompt
        </Label>
        <Textarea
          id={`${id}-instructions`}
          aria-describedby={`${id}-instructions-help ${id}-instructions-save`}
          rows={9}
          className="min-h-64 resize-y p-4 text-sm leading-7"
          maxLength={200000}
          value={value}
          disabled={locked}
          placeholder="Describe the agent’s role, responsibilities, technical standards and workflow…"
          onChange={(event) => onChange(event.target.value)}
        />
        <p
          id={`${id}-instructions-help`}
          className="flex items-start gap-2 text-xs leading-5 text-muted-foreground"
        >
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          Personality is added automatically. Focus here on how the agent does
          its work.
        </p>
      </div>
      <Collapsible className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <p
            id={`${id}-instructions-save`}
            className="text-xs text-muted-foreground"
          >
            {template
              ? "Template changes apply to agents created after you save."
              : "Save your edits, then restart the agent to apply them to an existing chat."}
          </p>
          <CollapsibleTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="group px-0 text-xs text-muted-foreground"
              />
            }
          >
            How changes take effect{" "}
            <ChevronDown className="size-3.5 transition-transform group-data-panel-open:rotate-180" />
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent className="space-y-2 text-xs leading-5 text-muted-foreground">
          {template ? (
            <>
              <p>
                Saving updates this template’s instructions and personality for
                future agents. Existing agents keep their current configuration.
              </p>
              <p>
                New agents inherit access from the template’s selected groups.
                Saving a template does not create or start an agent.
              </p>
            </>
          ) : (
            <>
              <p>
                Saving stores your instructions and personality without starting
                the agent or interrupting its current work.
              </p>
              <p>
                Restart applies those changes while keeping the same chat and
                readable history. Codex summarizes the active context during
                this process, which uses some of your subscription allowance.
              </p>
            </>
          )}
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}
