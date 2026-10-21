import type { PromptSettings } from "../shared/prompts.mjs";
import type { LoadedProject } from "../config/contracts.mjs";
import type { createManagerLifecycle } from "../manager-lifecycle.mjs";
import type { createManagerProfile } from "../manager-profile.mjs";
interface SettingsContext {
  prompts: PromptSettings;
  manager: Awaited<ReturnType<typeof createManagerLifecycle>>;
  managerProfile: ReturnType<typeof createManagerProfile>;
  project: LoadedProject;
}
export function createSettingsView({
  prompts,
  manager,
  managerProfile,
  project,
}: SettingsContext) {
  return async () => {
    const saved = await prompts.read(),
      lifecycle = manager.view();
    const profile = await managerProfile.read();
    return {
      projectId: project.id,
      projectName: project.name,
      managerProfile: profile,
      managerLifecycle: lifecycle,
      manager: {
        saved: { text: saved.manager.text, version: saved.manager.version },
        defaultText: saved.manager.defaultText,
        activeVersion: lifecycle.activeVersion,
        retainedVersion: lifecycle.retainedVersion,
        pendingRestart:
          saved.manager.version !==
          (lifecycle.activeVersion || lifecycle.retainedVersion),
      },
      worker: {
        saved: { text: saved.worker.text, version: saved.worker.version },
        defaultText: saved.worker.defaultText,
      },
    };
  };
}
