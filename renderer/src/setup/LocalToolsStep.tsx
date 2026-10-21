import type { SetupProps } from "../contracts/setup.js";

import { ExternalLink } from "lucide-react";

import {
  Actions,
  CheckList,
  Field,
  Hint,
  Panel,
  SetupButton,
} from "./components.js";

export function LocalToolsStep({ setup }: SetupProps) {
  const { snapshot, draft } = setup;
  return (
    <Panel
      data-step="1"
      title="Check your local tools"
      description="Crew needs Git and a compatible Codex installation. Checks use normal executable discovery and version commands; they do not inspect stored credentials."
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void setup.save();
        }}
      >
        <Field
          id="codex"
          label="Codex executable (optional)"
          placeholder="Discover automatically"
          value={draft?.runtime.codexBinary || ""}
          onChange={(value) => setup.edit("runtime.codexBinary", value)}
        />
        <SetupButton
          id="pick-codex"
          onClick={() =>
            setup.run("Choose Codex executable", async () => {
              const selected = await setup.api.chooseCodex();
              if (selected) setup.edit("runtime.codexBinary", selected);
              return {
                notice: selected
                  ? "Executable selected; save the choice before checking."
                  : "Selection canceled.",
              };
            })
          }
        >
          Choose executable…
        </SetupButton>
        <Hint>
          Leave blank for automatic discovery. Install Codex on this Mac if it
          is missing; do not copy another computer’s authentication files.
        </Hint>
        <Actions>
          <SetupButton
            id="save-runtime"
            disabled={!draft || setup.needsReload}
            onClick={() => setup.save()}
          >
            Save executable choice
          </SetupButton>
          <SetupButton
            id="runtime"
            variant="default"
            onClick={() => setup.check("runtime", "Check local tools")}
          >
            Check local tools
          </SetupButton>
          <SetupButton
            id="help"
            variant="ghost"
            onClick={() =>
              setup.run("Open official Codex guide", () => setup.api.help())
            }
          >
            Codex setup guide
            <ExternalLink aria-hidden="true" />
          </SetupButton>
        </Actions>
      </form>
      <CheckList
        id="runtime-result"
        snapshot={snapshot}
        entries={[
          ["codex", "Codex"],
          ["git", "Git"],
        ]}
      />
    </Panel>
  );
}
