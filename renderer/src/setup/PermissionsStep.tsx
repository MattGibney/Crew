import type { SetupProps } from "../contracts/setup.js";

import { Actions, Hint, Panel, SetupButton, Status } from "./components.js";

export function PermissionsStep({
  setup,
  setMicSkipped,
  move,
}: SetupProps & {
  setMicSkipped: (skipped: boolean) => void;
  move: (step: number) => void;
}) {
  const { snapshot } = setup;
  const privacy = (name: string) =>
    setup.run("Open macOS privacy settings", () => setup.api.settings(name));
  return (
    <Panel data-step="4" title="Permissions and local access">
      <section className="space-y-4" aria-labelledby="microphone-heading">
        <h3 id="microphone-heading" className="font-semibold">
          Microphone
        </h3>
        <p className="text-sm leading-relaxed">
          Only voice needs microphone access. Request it now, or leave it for
          your first call. This button asks macOS for permission without
          recording or starting voice.
        </p>
        <div id="microphone-result">
          <Status
            name="Microphone"
            value={{
              status: snapshot?.microphone || "unknown",
              detail:
                "macOS permission status; no recording or voice call has started.",
            }}
          />
        </div>
        <Actions>
          <SetupButton
            id="microphone"
            onClick={() => {
              setMicSkipped(false);
              return setup.check("microphone", "Request microphone permission");
            }}
          >
            Request microphone permission
          </SetupButton>
          <SetupButton
            id="skip-microphone"
            onClick={() => {
              setMicSkipped(true);
              setup.setNotice(
                "Microphone check skipped. No permission request, recording or voice call started.",
              );
              move(5);
            }}
          >
            Not now
          </SetupButton>
          <SetupButton
            id="microphone-settings"
            variant="ghost"
            onClick={() => privacy("microphone")}
          >
            Open Microphone settings
          </SetupButton>
        </Actions>
      </section>
      <section className="space-y-4" aria-labelledby="files-heading">
        <h3 id="files-heading" className="font-semibold">
          Project files
        </h3>
        <p className="text-sm leading-relaxed">
          Check the configured folders, starting branches, prompt files and a
          temporary write in this instance’s state folder. macOS may prompt for
          a protected folder. Terminal access does not establish packaged-app
          access. Worker sandbox access still needs a bounded task.
        </p>
        <Actions>
          <SetupButton
            id="paths"
            variant="default"
            onClick={() => setup.check("paths", "Check configured file access")}
          >
            Check configured file access
          </SetupButton>
          <SetupButton id="files-settings" onClick={() => privacy("files")}>
            Open Files and Folders settings
          </SetupButton>
        </Actions>
        <div id="paths-result" className="space-y-2">
          {(snapshot?.checks?.paths || []).map((path, index) => (
            <Status
              key={`${path.name}-${index}`}
              name={path.name}
              value={path}
            />
          ))}
        </div>
      </section>
      <section className="space-y-4" aria-labelledby="network-heading">
        <h3 id="network-heading" className="font-semibold">
          Local network
        </h3>
        <p className="text-sm leading-relaxed">
          Crew’s window talks to its controller at 127.0.0.1; voice uses WebRTC
          and online Codex services. No LAN discovery feature is required. macOS
          does not offer Crew a universal Local Network request/check here. If
          macOS asks during an actual operation, review it then. A blocked
          operation is not automatically a Local Network denial.
        </p>
        <SetupButton id="network-settings" onClick={() => privacy("network")}>
          Open Local Network settings
        </SetupButton>
        <Hint>
          Crew does not need camera, screen recording or Full Disk Access for
          this setup.
        </Hint>
      </section>
    </Panel>
  );
}
