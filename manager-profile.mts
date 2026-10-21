import { parseRecord, record } from "./shared/errors.mjs";
export interface ManagerProfile {
  voice: string | null;
  configured: boolean;
  version: string;
}
import { errorCode, errorMessage } from "./shared/errors.mjs";
// Project-owned manager preferences, independent of prompt activation and browser storage.
import { readFile, mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

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
  const view = (voice: string | null, configured = true): ManagerProfile => ({
    voice,
    configured,
    version: createHash("sha256")
      .update(JSON.stringify({ projectId, voice }))
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
      data.schemaVersion !== 1 ||
      data.projectId !== projectId ||
      !validVoice(data.voice)
    )
      throw Error("Invalid manager profile. Existing settings are preserved.");
    return view(data.voice);
  }
  function save(input: unknown) {
    const result = pending.then(async () => {
      if (
        !record(input) ||
        Object.keys(input).some(
          (key) => !["voice", "expectedVersion"].includes(key),
        ) ||
        !validVoice(input.voice)
      )
        throw Error("Invalid manager voice preference.");
      const current = await read();
      if (input.expectedVersion !== current.version)
        throw Error(
          "Manager profile changed elsewhere. Reload Settings before saving.",
        );
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(
          temporary,
          JSON.stringify({ schemaVersion: 1, projectId, voice: input.voice }) +
            "\n",
          { flag: "wx", mode: 0o600 },
        );
        await rename(temporary, file);
      } finally {
        await unlink(temporary).catch((error) => {
          if (errorCode(error) !== "ENOENT") throw error;
        });
      }
      return view(input.voice);
    });
    pending = result.catch(() => {});
    return result;
  }
  return { read, save };
}
