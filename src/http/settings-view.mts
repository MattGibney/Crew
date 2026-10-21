import { managerProfileSnapshot } from "../manager/profile.mjs";
import type { createEnvironmentSettings } from "../projects/environment-settings.mjs";
import type { PromptSettings } from "../manager/instructions/contracts.mjs";
import type { LoadedProject } from "../config/contracts.mjs";
import type { createManagerLifecycle } from "../manager/lifecycle.mjs";
import type { createManagerProfile } from "../manager/profile.mjs";
interface SettingsContext {
  prompts: PromptSettings;
  manager: Awaited<ReturnType<typeof createManagerLifecycle>>;
  managerProfile: ReturnType<typeof createManagerProfile>;
  project: LoadedProject;
  environmentSettings: Awaited<ReturnType<typeof createEnvironmentSettings>>;
}
export function createSettingsView({
  prompts,
  manager,
  managerProfile,
  project,
  environmentSettings,
}: SettingsContext) {
  return async () => {
    const saved = await prompts.read(),
      lifecycle = manager.view();
    const profile = await managerProfile.read();
    return {
      projectId: project.id,
      projectName: project.name,
      workerEnvironment: await environmentSettings.read(),
      managerProfile: profile,
      managerLifecycle: lifecycle,
      manager: {
        savedBehaviorVersion: managerProfileSnapshot(
          saved.manager.text,
          profile,
        ).version,
        saved: { text: saved.manager.text, version: saved.manager.version },
        defaultText: saved.manager.defaultText,
        activeVersion: lifecycle.activeVersion,
        retainedVersion: lifecycle.retainedVersion,
        pendingRestart:
          managerProfileSnapshot(saved.manager.text, profile).version !==
          (lifecycle.activeVersion || lifecycle.retainedVersion),
      },
      worker: {
        saved: { text: saved.worker.text, version: saved.worker.version },
        defaultText: saved.worker.defaultText,
      },
    };
  };
}
