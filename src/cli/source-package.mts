import { parseRecord } from "../shared/errors.mjs";
import { access, lstat, mkdir, readFile, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { appRoot } from "../config/index.mjs";
import type { CliOptions } from "./options.mjs";
const run = promisify(execFile);
// An allowlisted source archive remains reproducible after extraction without Git.
// State, local configuration, credentials, captures and built installers never qualify.
export async function packageSource(
  options: CliOptions,
  version: string,
): Promise<void> {
  const sourceRoot = resolve(appRoot, "..");
  await access(join(sourceRoot, "tsconfig.json")).catch(() => {
    throw new Error(
      "Source packaging requires an extracted source checkout. The installed app contains compiled runtime assets.",
    );
  });
  const output = resolve(
    options["--output"] ||
      join(sourceRoot, "dist", `crew-${version}-source.tar.gz`),
  );
  if (!output.endsWith(".tar.gz"))
    throw new Error("--output must end in .tar.gz.");
  try {
    await access(output);
    throw new Error(
      `Refusing to overwrite ${output}. Choose a new --output or remove the old archive explicitly.`,
    );
  } catch (error) {
    if (error instanceof Error && !("code" in error)) throw error;
  }
  const manifest = parseRecord(
    await readFile(join(sourceRoot, "scripts/source-manifest.json"), "utf8"),
  );
  if (
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.files) ||
    !manifest.files.every(
      (file: unknown) =>
        typeof file === "string" &&
        file.length > 0 &&
        !file.startsWith("/") &&
        !file.split("/").includes(".."),
    )
  )
    throw new Error("Source manifest is invalid.");
  const sources: string[] = manifest.files;
  for (const file of sources) {
    const info = await lstat(join(sourceRoot, file));
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error(`Missing package source file: ${file}.`);
  }
  await mkdir(dirname(output), { recursive: true });
  try {
    await run("tar", ["-czf", output, "-C", sourceRoot, ...sources], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
      timeout: 30000,
      maxBuffer: 65536,
    });
  } catch {
    await unlink(output).catch(() => {});
    throw new Error(
      "Could not create source archive with tar. No partial archive was retained.",
    );
  }
  console.log(
    `Created ${output}\nAllowlisted typed source and templates only. No local configuration, state, chat history, Git repositories or credentials are included.\nOn the destination Mac: extract, install Node.js 22+ and Git, run npm ci and npm run build, sign into Codex with ChatGPT, then run npm run init -- --template set1.`,
  );
}
