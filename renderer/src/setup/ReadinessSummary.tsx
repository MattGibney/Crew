import type { SetupProps } from "../contracts/setup.js";

import { ArrowRight } from "lucide-react";

import {
  Actions,
  CheckList,
  Hint,
  Panel,
  SetupButton,
  Status,
} from "./components.js";

export function ReadinessSummary({
  setup,
  micSkipped,
}: SetupProps & { micSkipped: boolean }) {
  const snapshot = setup.snapshot;
  const checks = snapshot?.checks || {};
  return (
    <Panel
      data-step="5"
      title="Your readiness summary"
      description="Checks describe the evidence available now. Configured identifiers and discovered tools are not verified business access. Changed files or account settings need fresh checks."
    >
      <div id="summary" className="space-y-2">
        <CheckList
          snapshot={snapshot}
          entries={[
            ["codex", "Codex"],
            ["git", "Git"],
            ["protocol", "App-server protocol"],
            ["auth", "ChatGPT"],
            ["voices", "Voice catalog"],
            ["project", "Project configuration"],
            ["tools", "Connected tools"],
          ]}
        />
        {Object.entries(checks)
          .filter(([key]) => key.startsWith("toolchain_"))
          .map(([key, value]) => (
            <Status
              key={key}
              name="Project Node/npm"
              value={Array.isArray(value) ? undefined : value}
            />
          ))}
        {checks.tools?.linear && (
          <Status name="Linear access" value={checks.tools.linear} />
        )}
        <Status
          name="Microphone"
          value={{
            status: micSkipped ? "skipped" : snapshot?.microphone || "unknown",
            detail: `Optional until you choose voice. macOS status: ${snapshot?.microphone || "unknown"}. A granted OS permission does not prove audible conversation.`,
          }}
        />
        <Status
          name="File access"
          value={{
            status: checks.paths?.length
              ? checks.paths.every((path) => path.status === "verified")
                ? "verified"
                : "incomplete"
              : "unknown",
            detail: checks.paths?.length
              ? "Scope: configured paths in this packaged process; worker sandbox access still needs a bounded task."
              : "Not checked in this setup.",
          }}
        />
        {snapshot?.controllerRunning && (
          <Status
            name="Existing controller"
            value={{
              status: "running",
              detail:
                "Setup does not stop or replace this controller. Config changes require a safe restart.",
            }}
          />
        )}
      </div>
      <p className="text-sm leading-relaxed">
        You can open the manager for setup discussion even with an incomplete
        project once local runtime and ChatGPT are available. Assigning work
        requires a selected folder, starting branch, Linear team and an agreed
        ticket. No task starts on opening.
      </p>
      <Actions>
        <SetupButton
          id="launch"
          variant="default"
          onClick={() => setup.run("Check readiness", () => setup.api.launch())}
        >
          {snapshot?.controllerRunning
            ? "Return to running manager"
            : "Check readiness and open manager"}
          <ArrowRight aria-hidden="true" />
        </SetupButton>
      </Actions>
      <Hint>
        Skipping microphone means voice is not ready yet; it does not block
        configuration or text review. If macOS privacy changes do not take
        effect, quit and reopen Crew.
      </Hint>
    </Panel>
  );
}
