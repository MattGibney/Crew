import type { Actor, AgentProvisioning } from "./contracts.mjs";
import type { ProjectEnvironmentTemplateCatalogue } from "./environment-templates.mjs";

/** Creation metadata only: no preparation, tool inspection or project execution.
 * The foundation holds Start until both access and this exact template pin have
 * been persisted. Retrying either store must preserve later owner choices.
 */
export function withEnvironmentTemplateProvisioning(
  provisioning: AgentProvisioning,
  catalogue: ProjectEnvironmentTemplateCatalogue,
  owner: Actor,
): AgentProvisioning {
  const trustedOwner = structuredClone(owner);
  return {
    listPresets: () => provisioning.listPresets(),
    accessFor: (agentId) => provisioning.accessFor(agentId),
    async applyPreset(input) {
      input = structuredClone(input);
      const preset = (await provisioning.listPresets()).find(
        (row) => row.id === input.presetId,
      );
      if (
        !preset ||
        !preset.enabled ||
        preset.revision !== input.expectedPresetRevision
      )
        throw new Error(
          "Creation preset changed or is unavailable; refresh owner-approved choices.",
        );

      const pin = preset.environmentTemplate;
      if (pin) {
        // Authenticate the trusted owner and resolve the exact immutable version
        // before access can be committed. Never substitute the latest version.
        catalogue.ownerSnapshot(trustedOwner);
        const template = catalogue.resolvePinned(pin.id, pin.revision);
        if (template.projectId !== preset.projectId)
          throw new Error(
            "Creation preset template belongs to another project.",
          );
        const current = catalogue.assignment(input.agentId);
        if (
          current &&
          (current.templateId !== pin.id ||
            current.templateRevision !== pin.revision)
        )
          throw new Error(
            "Environment template assignment changed; preserve the owner's current choice.",
          );
      }

      const access = await provisioning.applyPreset(input);
      if (pin)
        // Missing-only CAS is repeated inside the catalogue transaction, after
        // access admission. A retry never restores an assignment cleared by its
        // owner, even if the first response was lost after both writes succeeded.
        await catalogue.assignPreset(trustedOwner, {
          agentId: input.agentId,
          templateId: pin.id,
          templateRevision: pin.revision,
        });
      return access;
    },
  };
}
