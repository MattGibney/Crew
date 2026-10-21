// Project-owned manager preferences, independent of prompt activation and browser storage.
import { readFile, mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { validatePrompt, promptSnapshot } from "./instructions/text.mjs";
import { validateProfilePicture } from "./profile-picture.mjs";
export { validateProfilePicture } from "./profile-picture.mjs";
import { errorCode, parseRecord, record } from "../shared/errors.mjs";
export interface ManagerProfileDetails {
  name: string;
  picture: string | null;
  personality: string;
}
export interface ManagerProfile extends ManagerProfileDetails {
  voice: string | null;
  configured: boolean;
  version: string;
}

const defaults: ManagerProfileDetails = {
  name: "",
  picture: null,
  personality: "",
};
function validateDetails(
  input: Record<string, unknown>,
): ManagerProfileDetails {
  if (
    typeof input.name !== "string" ||
    input.name.length > 80 ||
    /[\x00-\x1f\x7f]/.test(input.name)
  )
    throw Error(
      "Manager name must be at most 80 characters without control characters.",
    );
  if (
    typeof input.personality !== "string" ||
    input.personality.length > 8000 ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.personality)
  )
    throw Error(
      "Personality must be at most 8,000 characters without control characters.",
    );
  if (input.name.trim()) validatePrompt(input.name);
  if (input.personality.trim()) validatePrompt(input.personality);
  return {
    name: input.name.trim(),
    personality: input.personality,
    picture: validateProfilePicture(input.picture),
  };
}
// Explicit, user-editable profile preferences supplement the unchanged replacement prompt.
// Empty profiles preserve the exact original snapshot, including legacy lifecycles.
export function managerProfileSnapshot(
  text: string,
  profile: Partial<ManagerProfile> = defaults,
) {
  const parts = [];
  if (profile.name)
    parts.push(
      `Manager name: ${JSON.stringify(profile.name)}. You are still an AI manager. When introducing yourself by name, use this configured manager name rather than the selected audio voice name.`,
    );
  if (profile.personality?.trim())
    parts.push(
      `Personality and communication preferences:\n${profile.personality}`,
    );
  return promptSnapshot(
    parts.length
      ? `${text}\n\n# Configured manager profile (editable in Settings)\n${parts.join("\n\n")}`
      : text,
  );
}

export function createManagerProfile({
  stateDir,
  projectId,
}: {
  stateDir: string;
  projectId: string;
}) {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(projectId))
    throw Error("Invalid manager profile project.");
  const directory = path.join(stateDir, "manager-profiles"),
    file = path.join(directory, `${projectId}.json`);
  let pending: Promise<unknown> = Promise.resolve();
  const validVoice = (voice: unknown): voice is string | null =>
    voice === null ||
    (typeof voice === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(voice));
  const view = (
    voice: string | null,
    configured = true,
    details: ManagerProfileDetails = defaults,
  ): ManagerProfile => ({
    voice,
    ...details,
    configured,
    version: createHash("sha256")
      .update(
        JSON.stringify({
          projectId,
          voice,
          voiceConfigured: configured,
          ...details,
        }),
      )
      .digest("hex"),
  });
  async function read() {
    let data;
    try {
      data = parseRecord(await readFile(file, "utf8"));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return view(null, false);
      throw Error(
        "Cannot read manager profile. Existing settings are preserved.",
      );
    }
    if (
      (data.schemaVersion !== 1 && data.schemaVersion !== 2) ||
      data.projectId !== projectId ||
      !validVoice(data.voice)
    )
      throw Error("Invalid manager profile. Existing settings are preserved.");
    if (
      data.schemaVersion === 2 &&
      data.voiceConfigured !== undefined &&
      typeof data.voiceConfigured !== "boolean"
    )
      throw Error(
        "Invalid manager voice selection state. Existing settings are preserved.",
      );
    return view(
      data.voice,
      data.schemaVersion === 1 || data.voiceConfigured !== false,
      validateDetails({
        ...defaults,
        ...(data.schemaVersion === 2
          ? {
              name: data.name,
              picture: data.picture,
              personality: data.personality,
            }
          : {}),
      }),
    );
  }
  function save(
    input: unknown,
    validate: (profile: ManagerProfile) => void | Promise<void> = () => {},
  ) {
    const result = pending.then(async () => {
      if (
        !record(input) ||
        Object.keys(input).some(
          (key) =>
            ![
              "voice",
              "name",
              "picture",
              "personality",
              "expectedVersion",
            ].includes(key),
        ) ||
        (Object.hasOwn(input, "voice") && !validVoice(input.voice))
      )
        throw Error("Invalid manager profile update.");
      const current = await read();
      if (input.expectedVersion !== current.version)
        throw Error(
          "Manager profile changed elsewhere. Reload Settings before saving.",
        );
      const voice =
        Object.hasOwn(input, "voice") && validVoice(input.voice)
          ? input.voice
          : current.voice;
      const details = validateDetails({ ...defaults, ...current, ...input });
      // Saving identity must not suppress the one-time legacy voice migration.
      const configured = Object.hasOwn(input, "voice") || current.configured;
      await validate(view(voice, configured, details));
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(
          temporary,
          JSON.stringify({
            schemaVersion: 2,
            projectId,
            voice,
            voiceConfigured: configured,
            ...details,
          }) + "\n",
          { flag: "wx", mode: 0o600 },
        );
        await rename(temporary, file);
      } finally {
        await unlink(temporary).catch((error) => {
          if (errorCode(error) !== "ENOENT") throw error;
        });
      }
      return view(voice, configured, details);
    });
    pending = result.catch(() => {});
    return result;
  }
  return { read, save };
}
