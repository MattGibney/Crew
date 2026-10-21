import type { PromptSettings } from "../manager/instructions/contracts.mjs";
import type { createManagerProfile } from "../manager/profile.mjs";
import { managerProfileSnapshot } from "../manager/profile.mjs";
import { validatePrompt } from "../manager/instructions/settings.mjs";
import { record } from "../shared/errors.mjs";
/** Combined profile/prompt bounds are checked atomically across both editors. */
export function createSettingsSave(
  prompts: PromptSettings,
  profile: ReturnType<typeof createManagerProfile>,
) {
  let pending: Promise<unknown> = Promise.resolve();
  function serialize<T>(operation: () => Promise<T>) {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  }
  return {
    profile: (input: unknown) =>
      serialize(() =>
        profile.save(input, async (selected) => {
          managerProfileSnapshot(
            (await prompts.snapshot("manager")).text,
            selected,
          );
        }),
      ),
    prompts: (input: unknown) =>
      serialize(async () => {
        if (record(input)) {
          const text =
            input.role === "manager"
              ? input.text
              : !Object.hasOwn(input, "role")
                ? input.manager
                : null;
          if (text !== null)
            managerProfileSnapshot(validatePrompt(text), await profile.read());
        }
        return prompts.save(input);
      }),
  };
}
