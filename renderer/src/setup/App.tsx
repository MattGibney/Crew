import { WelcomeStep } from "./WelcomeStep.js";
import { LocalToolsStep } from "./LocalToolsStep.js";
import { AccountStep } from "./AccountStep.js";
import { ProjectStep } from "./ProjectStep.js";
import { PermissionsStep } from "./PermissionsStep.js";
import { StorageRecovery } from "./StorageRecovery.js";
import { ReadinessSummary } from "./ReadinessSummary.js";
import type { SetupBridge } from "../contracts/setup.js";
import { useState } from "react";
import { ArrowLeft, ArrowRight, LoaderCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import crewMark from "../../../build/crew-mark.png";
import { Actions, BusyContext, SetupButton } from "./components.js";

import { steps } from "./model.js";
import { useSetup } from "./useSetup.js";

export default function App({ api }: { api?: SetupBridge }) {
  const setup = useSetup(api);
  const [step, setStep] = useState(0);
  const [micSkipped, setMicSkipped] = useState(false);
  const { snapshot } = setup;
  const move = (next: number) => {
    setStep(Math.max(0, Math.min(5, next)));
    window.scrollTo(0, 0);
  };
  return (
    <BusyContext.Provider value={Boolean(setup.busy)}>
      <div className="min-h-screen bg-muted/20 text-foreground">
        <div className="mx-auto max-w-6xl space-y-7 px-5 py-7 sm:px-8 sm:py-10">
          <header className="flex items-center gap-4 border-b pb-6">
            <img
              src={crewMark}
              alt="Crew"
              width="44"
              height="44"
              className="size-11 shrink-0"
            />
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-semibold tracking-tight">
                  Set up Crew
                </h1>
                <Badge variant="secondary">Local setup</Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Connect your project. Crew handles the technical setup.
              </p>
            </div>
          </header>
          <Actions>
            {snapshot?.missingConfig && (
              <SetupButton
                id="initialize"
                onClick={() =>
                  setup.run("Create editable project template", async () =>
                    setup.accept(await setup.api.initialize(), true),
                  )
                }
              >
                Create local configuration
              </SetupButton>
            )}
            {!snapshot?.config && (
              <SetupButton
                id="repair-config"
                onClick={() =>
                  setup.run("Open configuration", () => setup.api.openConfig())
                }
              >
                Open configuration file
              </SetupButton>
            )}
            <SetupButton
              id="reload-all"
              variant="ghost"
              onClick={setup.refresh}
            >
              Reload setup
            </SetupButton>
          </Actions>
          <div className="grid items-start gap-8 lg:grid-cols-[210px_minmax(0,1fr)]">
            <nav
              aria-label="Setup steps"
              id="steps"
              className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:sticky lg:top-8 lg:grid-cols-1"
            >
              {steps.map((label, index) => (
                <SetupButton
                  key={label}
                  variant={index === step ? "default" : "ghost"}
                  aria-current={index === step ? "step" : undefined}
                  className="h-11 justify-start gap-3 px-3"
                  onClick={() => move(index)}
                >
                  <span
                    className={`flex size-5 shrink-0 items-center justify-center rounded-full border text-xs ${index === step ? "border-primary-foreground/40" : "border-border text-muted-foreground"}`}
                  >
                    {index + 1}
                  </span>
                  {label}
                </SetupButton>
              ))}
            </nav>
            <div className="min-w-0 space-y-5">
              <div className="space-y-3">
                <p
                  id="notice"
                  role="status"
                  aria-live="polite"
                  className="flex min-h-5 items-center gap-2 text-sm text-muted-foreground"
                >
                  {setup.busy && (
                    <LoaderCircle
                      aria-hidden="true"
                      className="size-4 shrink-0 animate-spin"
                    />
                  )}
                  {setup.notice}
                </p>
                {setup.error && (
                  <Alert id="error" variant="destructive">
                    <AlertDescription className="whitespace-pre-wrap">
                      {setup.error}
                    </AlertDescription>
                  </Alert>
                )}
                {setup.needsReload && (
                  <Alert>
                    <AlertDescription>
                      Saved settings changed. Your unsaved fields are still on
                      screen. Reload saved settings before saving again.
                    </AlertDescription>
                  </Alert>
                )}
              </div>
              <StorageRecovery setup={setup} />
              <main aria-busy={Boolean(setup.busy)}>
                {step === 0 && <WelcomeStep setup={setup} move={move} />}
                {step === 1 && <LocalToolsStep setup={setup} />}
                {step === 2 && <AccountStep setup={setup} />}
                {step === 3 && <ProjectStep setup={setup} />}
                {step === 4 && (
                  <PermissionsStep
                    setup={setup}
                    move={move}
                    setMicSkipped={setMicSkipped}
                  />
                )}
                {step === 5 && (
                  <ReadinessSummary setup={setup} micSkipped={micSkipped} />
                )}
              </main>
              <footer className="flex flex-wrap items-center gap-2 border-t border-border pt-5">
                <SetupButton
                  id="back"
                  disabled={step === 0}
                  onClick={() => move(step - 1)}
                >
                  <ArrowLeft aria-hidden="true" />
                  Back
                </SetupButton>
                <SetupButton
                  id="next"
                  disabled={step === 5}
                  onClick={() => move(step + 1)}
                >
                  Next
                  <ArrowRight aria-hidden="true" />
                </SetupButton>
                <span
                  id="position"
                  className="ml-auto text-sm text-muted-foreground"
                >
                  Step {step + 1} of 6
                </span>
              </footer>
            </div>
          </div>
        </div>
      </div>
    </BusyContext.Provider>
  );
}
