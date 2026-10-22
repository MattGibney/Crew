import type { SetupProps } from "../contracts/setup.js";

import { Panel } from "./components.js";
import ProjectSettings from "./ProjectSettings.js";

export function ProjectStep({ setup }: SetupProps) {
  return (
    <Panel
      data-step="3"
      title="Your project"
      description="Choose its folder. Crew finds the project details, starting branch and optional tracking choices, then saves your settings."
    >
      <form
        aria-label="Project configuration"
        onSubmit={(event) => {
          event.preventDefault();
          void setup.save();
        }}
      >
        <ProjectSettings setup={setup} />
      </form>
    </Panel>
  );
}
