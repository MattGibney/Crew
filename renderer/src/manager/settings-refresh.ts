import type { SettingsState } from "../contracts/manager.js";

/** Coalesce invalidations into one in-flight read plus a fresh read if needed.
 * Never publish an observation invalidated during its request, or from another project.
 */
export function createSettingsRefresh(
  read: () => Promise<SettingsState>,
  apply: (value: SettingsState) => void,
  failed: (error: unknown) => void,
) {
  let generation = 0;
  let projectId: string | undefined;
  let latest: SettingsState["settingsRevision"];
  let active = true;
  let flight: Promise<SettingsState> | null = null;
  const bind = (id?: string) => {
    if (id === projectId) return;
    projectId = id;
    latest = undefined;
    generation++;
  };
  const load = (): Promise<SettingsState> => {
    generation++;
    if (flight) return flight;
    flight = (async () => {
      for (;;) {
        const request = generation;
        try {
          const value = await read();
          if (!active) return value;
          if (request !== generation) continue;
          if (projectId && value.projectId !== projectId)
            throw new Error(
              "Settings belong to a different project. Reopen this project before retrying.",
            );
          const revision = value.settingsRevision;
          if (
            revision &&
            latest?.source === revision.source &&
            revision.sequence < latest.sequence
          )
            throw new Error(
              "An older Settings response was received. Reload settings to retry.",
            );
          latest = revision;
          apply(value);
          return value;
        } catch (error) {
          if (active && request !== generation) continue;
          if (active) failed(error);
          throw error;
        }
      }
    })().finally(() => {
      flight = null;
    });
    return flight;
  };
  return {
    load,
    bind,
    invalidate: (id: string) =>
      !projectId || id === projectId ? load() : Promise.resolve(null),
    activate: () => {
      active = true;
    },
    dispose: () => {
      active = false;
      generation++;
    },
  };
}
