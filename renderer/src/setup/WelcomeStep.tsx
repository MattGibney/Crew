import type { SetupProps } from "../contracts/setup.js";

import {
  ArrowRight,
  ShieldCheck,
  FolderGit2,
  AudioLines,
  Layers,
} from "lucide-react";

import { Actions, Panel, SetupButton } from "./components.js";

export function WelcomeStep({
  setup,
  move,
}: SetupProps & { move: (step: number) => void }) {
  const { snapshot } = setup;
  return (
    <Panel
      data-step="0"
      title="A workspace for you and your crew"
      description="Connect one project and your existing ChatGPT account. We'll take care of the local setup."
    >
      <div className="space-y-6">
        {(
          [
            [
              FolderGit2,
              "Start with your project",
              "Choose a folder. Crew reads its existing instructions and finds a starting branch.",
            ],
            [
              Layers,
              "Give each worker room to work",
              "Agreed tasks run in separate worktrees. Progress and questions come back to your manager.",
            ],
            [
              AudioLines,
              "Talk or type, on your terms",
              "Voice is optional. Your microphone only turns on when you choose to speak.",
            ],
          ] as const
        ).map(([Icon, title, description]) => (
          <div key={title} className="flex gap-4">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted">
              <Icon
                className="size-5 text-muted-foreground"
                aria-hidden="true"
              />
            </span>
            <div>
              <h3 className="text-sm font-semibold">{title}</h3>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                {description}
              </p>
            </div>
          </div>
        ))}
      </div>
      <div className="flex gap-3 rounded-lg border bg-muted/30 p-4">
        <ShieldCheck
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <p className="text-xs leading-5 text-muted-foreground">
          Settings and execution records stay on this Mac. ChatGPT and connected
          tools use their normal online services. Setup starts no worker or
          voice call.
        </p>
      </div>
      {snapshot?.config && (
        <p id="instance" className="text-sm text-muted-foreground">
          Your existing conversations and project settings are kept.
        </p>
      )}
      <Actions>
        <SetupButton variant="default" data-next onClick={() => move(1)}>
          Get started
          <ArrowRight aria-hidden="true" />
        </SetupButton>
        {snapshot?.config && (
          <SetupButton variant="ghost" onClick={() => move(5)}>
            Review current setup
          </SetupButton>
        )}
      </Actions>
    </Panel>
  );
}
