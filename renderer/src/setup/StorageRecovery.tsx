import type { SetupProps } from "../contracts/setup.js";

import { Actions, Panel, SetupButton } from "./components.js";

export function StorageRecovery({ setup }: SetupProps) {
  const migration = setup.snapshot?.migration;
  if (!migration) return null;
  return (
    <Panel id="storage-recovery" title="Previous storage needs review">
      <p className="text-sm leading-relaxed">
        {migration.issue} No configuration, history or authentication was reset.
        Quit a previous app before retrying. Choosing a previous configuration
        keeps its explicit path for recovery.
      </p>
      <Actions>
        <SetupButton
          onClick={() =>
            setup.run("Retry migration", () => setup.api.storageRetry())
          }
        >
          Retry migration
        </SetupButton>
        <SetupButton
          onClick={() =>
            setup.run("Open Crew storage folder", () =>
              setup.api.storageFolder(),
            )
          }
        >
          Open Crew storage folder
        </SetupButton>
      </Actions>
      <div className="flex flex-col items-start gap-2">
        {[migration.newConfigPath, ...(migration.legacyConfigPaths || [])].map(
          (path, index) => (
            <SetupButton
              key={`${index}-${path}`}
              className="h-auto max-w-full whitespace-normal break-all text-left"
              onClick={() =>
                setup.run("Use previous configuration", () =>
                  setup.api.storageUse(index),
                )
              }
            >
              Use {path}
            </SetupButton>
          ),
        )}
      </div>
    </Panel>
  );
}
