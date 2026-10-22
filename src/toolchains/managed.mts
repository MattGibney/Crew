import { jsonFetch, bytesFetch, withLock, extract } from "./install-io.mjs";
import type { ToolRequirements } from "./tool-requirements.mjs";
import {
  parseNodeReleases,
  parseNpmMetadata,
  parseNpmRelease,
  parseToolManifest,
  type ToolManifest,
} from "./tool-metadata.mjs";
import { errorCode } from "../workers/errors.mjs";
export interface ManagedToolchain {
  PATH: string;
  env?: NodeJS.ProcessEnv;
  nodeVersion: string | null;
  npmVersion: string | null;
  nodePath?: string;
  npmPath?: string;
  cacheRoot: string;
  requirements: RequirementInput;
}
type RequirementInput = Partial<Omit<ToolRequirements, "node" | "npm">> & {
  node?: string[] | string | { requirement: string };
  npm?: string[] | string | { requirement: string };
};
interface ToolSelection extends ToolManifest {
  directory: string;
  nodePath: string;
  npmPath: string;
}
interface ResolveOptions {
  requirements?: RequirementInput;
  cacheRoot?: string;
  env?: NodeJS.ProcessEnv;
  install?: boolean;
  fetchImpl?: typeof fetch;
  platform?: string;
  arch?: string;
}
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
export const SYSTEM_TOOL_PATH =
  "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const fail = (code: string, message: string) =>
  Object.assign(new Error(message), { code });
import {
  version,
  compare,
  satisfiesToolVersion,
  discoverToolRequirements,
} from "./tool-requirements.mjs";
export {
  satisfiesToolVersion,
  discoverToolRequirements,
} from "./tool-requirements.mjs";
function requirementsFor(requirements: RequirementInput, tool: "node" | "npm") {
  const input = requirements?.[tool];
  return input == null
    ? []
    : Array.isArray(input)
      ? input
      : [typeof input === "object" ? input.requirement : input];
}
const compatible = (v: string, ranges: string[]) =>
  ranges.every((r) => satisfiesToolVersion(v, r));
const defaultRoot = () =>
  path.join(
    os.homedir(),
    ...(process.platform === "darwin"
      ? ["Library", "Application Support", "Crew", "toolchains"]
      : [".crew", "toolchains"]),
  );
// Installation/version probes use a controlled environment internally; returned
// launch defaults preserve user environment and never create shell startup files.
function launchEnvironment(PATH: string, env: NodeJS.ProcessEnv) {
  return {
    env: {
      ...env,
      PATH: [
        ...new Set(
          [PATH, env.PATH]
            .filter(Boolean)
            .flatMap((value) => (value || "").split(path.delimiter))
            .filter(Boolean),
        ),
      ].join(path.delimiter),
    },
  };
}
const cleanEnv = (env: NodeJS.ProcessEnv) => {
  const out: NodeJS.ProcessEnv = { ...env, PATH: SYSTEM_TOOL_PATH };
  delete out.NODE_OPTIONS;
  delete out.NODE_PATH;
  delete out.NPM_CONFIG_PREFIX;
  delete out.npm_config_prefix;
  return out;
};

async function cached(
  root: string,
  ranges: { node: string[]; npm: string[] },
  platform: string,
  arch: string,
): Promise<ToolSelection | null> {
  let entries;
  try {
    entries = await fs.readdir(root);
  } catch {
    return null;
  }
  const candidates = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    try {
      const directory = path.join(root, entry);
      const manifest = parseToolManifest(
        JSON.parse(
          await fs.readFile(path.join(directory, "manifest.json"), "utf8"),
        ),
      );
      if (
        manifest.platform !== platform ||
        manifest.arch !== arch ||
        !compatible(manifest.nodeVersion, ranges.node) ||
        !compatible(manifest.npmVersion, ranges.npm)
      )
        continue;
      const nodePath = path.join(directory, "bin", "node");
      const npmPath = path.join(directory, "bin", "npm");
      const env = {
        PATH: `${path.join(directory, "bin")}:${SYSTEM_TOOL_PATH}`,
      };
      const actualNode = (
        await run(nodePath, ["--version"], { env, timeout: 10000 })
      ).stdout
        .trim()
        .replace(/^v/, "");
      const actualNpm = (
        await run(
          nodePath,
          [path.join(directory, "npm", "bin", "npm-cli.js"), "--version"],
          { env, timeout: 10000 },
        )
      ).stdout.trim();
      await fs.access(npmPath, 1);
      if (
        actualNode === manifest.nodeVersion &&
        actualNpm === manifest.npmVersion
      )
        candidates.push({ ...manifest, directory, nodePath, npmPath });
    } catch {}
  }
  return (
    candidates.sort(
      (a, b) =>
        compare(b.nodeVersion, a.nodeVersion) ||
        compare(b.npmVersion, a.npmVersion),
    )[0] || null
  );
}

export async function resolveManagedToolchain({
  requirements = {},
  cacheRoot = defaultRoot(),
  env = process.env,
  install = true,
  fetchImpl = globalThis.fetch,
  platform = process.platform,
  arch = process.arch,
}: ResolveOptions = {}): Promise<ManagedToolchain> {
  const ranges = {
    node: requirementsFor(requirements, "node"),
    npm: requirementsFor(requirements, "npm"),
  };
  for (const r of [...ranges.node, ...ranges.npm])
    satisfiesToolVersion("22.0.0", r);
  const baseEnv = cleanEnv(env);
  if (!ranges.node.length && requirements.nodeProject)
    throw fail(
      "TOOL_REQUIREMENT_MISSING",
      "This Node project does not declare its Node version. Add the intended version to its existing configuration or instructions.",
    );
  if (!ranges.node.length && !ranges.npm.length)
    return {
      ...launchEnvironment(baseEnv.PATH || SYSTEM_TOOL_PATH, env),
      PATH: baseEnv.PATH || SYSTEM_TOOL_PATH,
      nodeVersion: null,
      npmVersion: null,
      requirements,
      cacheRoot,
    };
  if (!ranges.node.length)
    throw fail(
      "TOOL_REQUIREMENT_MISSING",
      "This project specifies npm but no Node version. Add the intended Node requirement to the existing project configuration.",
    );
  if (
    !["darwin", "linux"].includes(platform) ||
    !["arm64", "x64"].includes(arch)
  )
    throw fail(
      "TOOL_PLATFORM_UNSUPPORTED",
      `Crew managed Node is not supported on ${platform}/${arch}.`,
    );
  cacheRoot = path.resolve(cacheRoot);
  const finish = async (selected: ToolSelection) => {
    const PATH = `${path.join(selected.directory, "bin")}:${SYSTEM_TOOL_PATH}`;
    return {
      ...selected,
      PATH,
      ...launchEnvironment(PATH, env),
      cacheRoot,
      requirements,
    };
  };
  let selected = await cached(cacheRoot, ranges, platform, arch);
  if (selected) return finish(selected);
  if (!install)
    throw fail(
      "TOOL_CACHE_MISSING",
      "The required Crew-managed Node/npm version is missing or damaged. Run environment preparation to install it; retained setup was not replayed.",
    );
  try {
    return await withLock(cacheRoot, async () => {
      selected = await cached(cacheRoot, ranges, platform, arch);
      if (selected) return finish(selected);
      const releases = parseNodeReleases(
        await jsonFetch("https://nodejs.org/dist/index.json", fetchImpl),
      );
      const node = releases
        .filter(
          (r) =>
            /^v\d+\.\d+\.\d+$/.test(r.version) &&
            compatible(version(r.version), ranges.node) &&
            r.files?.includes(
              `${platform === "darwin" ? "osx" : "linux"}-${arch}-tar`,
            ),
        )
        .sort((a, b) => compare(b.version, a.version))[0];
      if (!node)
        throw fail(
          "TOOL_REQUIREMENT_CONFLICT",
          `No supported Node release satisfies all project requirements: ${ranges.node.join(", ")}.`,
        );
      const npmMetadata = ranges.npm.length
        ? parseNpmMetadata(
            await jsonFetch("https://registry.npmjs.org/npm", fetchImpl),
          )
        : {
            versions: {
              [node.npm]: parseNpmRelease(
                await jsonFetch(
                  `https://registry.npmjs.org/npm/${node.npm}`,
                  fetchImpl,
                ),
              ),
            },
          };
      const npm = Object.values(npmMetadata.versions || {})
        .filter((r) => {
          try {
            return (
              /^\d+\.\d+\.\d+$/.test(r.version) &&
              compatible(r.version, ranges.npm) &&
              (!r.engines?.node ||
                satisfiesToolVersion(version(node.version), r.engines.node))
            );
          } catch {
            return false;
          }
        })
        .sort((a, b) => compare(b.version, a.version))[0];
      if (!npm)
        throw fail(
          "TOOL_REQUIREMENT_CONFLICT",
          `No npm release satisfies the project requirements and Node ${version(node.version)}.`,
        );
      // With no npm requirement, retain the release's known bundled npm version.
      const npmVersion = ranges.npm.length ? npm.version : node.npm;
      const npmRelease = npmMetadata.versions[npmVersion];
      if (!npmRelease?.dist?.integrity?.startsWith("sha512-"))
        throw fail(
          "TOOL_DOWNLOAD_INVALID",
          "npm registry did not supply the required SHA-512 package integrity.",
        );
      const directory = path.join(
        cacheRoot,
        `node-${version(node.version)}-npm-${npmVersion}-${platform}-${arch}`,
      );
      const staging = await fs.mkdtemp(path.join(cacheRoot, ".staging-"));
      try {
        const filename = `node-${node.version}-${platform}-${arch}.tar.gz`;
        const origin = `https://nodejs.org/dist/${node.version}`;
        const checksums = (
          await bytesFetch(`${origin}/SHASUMS256.txt`, fetchImpl, 1000000)
        ).toString("utf8");
        const checksum = checksums
          .split("\n")
          .map((line) => line.trim().split(/\s+/))
          .find((parts) => parts[1] === filename)?.[0];
        if (!/^[a-f0-9]{64}$/.test(checksum || ""))
          throw fail(
            "TOOL_DOWNLOAD_INVALID",
            "Official Node checksum is unavailable for this release.",
          );
        const data = await bytesFetch(`${origin}/${filename}`, fetchImpl);
        if (crypto.createHash("sha256").update(data).digest("hex") !== checksum)
          throw fail(
            "TOOL_CHECKSUM_MISMATCH",
            "Node download failed checksum verification. Retry preparation.",
          );
        const archive = path.join(staging, "node.tar.gz");
        await fs.writeFile(archive, data);
        await extract(archive, staging);
        await fs.unlink(archive);
        const npmUrl = npmRelease.dist.tarball;
        if (!npmUrl)
          throw fail(
            "TOOL_DOWNLOAD_INVALID",
            "npm package download URL is unavailable.",
          );
        if (new URL(npmUrl).origin !== "https://registry.npmjs.org")
          throw fail(
            "TOOL_DOWNLOAD_INVALID",
            "npm package download must use the official registry.",
          );
        const npmData = await bytesFetch(npmUrl, fetchImpl);
        if (
          `sha512-${crypto.createHash("sha512").update(npmData).digest("base64")}` !==
          npmRelease.dist.integrity
        )
          throw fail(
            "TOOL_CHECKSUM_MISMATCH",
            "npm download failed integrity verification. Retry preparation.",
          );
        await fs.mkdir(path.join(staging, "npm"));
        const npmArchive = path.join(staging, "npm.tar.gz");
        await fs.writeFile(npmArchive, npmData);
        await extract(npmArchive, path.join(staging, "npm"));
        await fs.unlink(npmArchive);
        for (const [name, script] of [
          ["npm", "npm-cli.js"],
          ["npx", "npx-cli.js"],
        ]) {
          await fs.rm(path.join(staging, "bin", name), { force: true });
          await fs.symlink(
            `../npm/bin/${script}`,
            path.join(staging, "bin", name),
          );
        }
        await fs.writeFile(
          path.join(staging, "manifest.json"),
          JSON.stringify({
            nodeVersion: version(node.version),
            npmVersion,
            platform,
            arch,
            nodeSha256: checksum,
            npmIntegrity: npmRelease.dist.integrity,
          }),
        );
        // Validate before publishing; readers only see a complete executable cache entry.
        const stagingEnv = {
          PATH: `${path.join(staging, "bin")}:${SYSTEM_TOOL_PATH}`,
        };
        const actualNode = (
          await run(path.join(staging, "bin", "node"), ["--version"], {
            env: stagingEnv,
            timeout: 10000,
          })
        ).stdout
          .trim()
          .replace(/^v/, "");
        const actualNpm = (
          await run(
            path.join(staging, "bin", "node"),
            [path.join(staging, "npm", "bin", "npm-cli.js"), "--version"],
            { env: stagingEnv, timeout: 10000 },
          )
        ).stdout.trim();
        if (actualNode !== version(node.version) || actualNpm !== npmVersion)
          throw fail(
            "TOOL_INSTALL_INVALID",
            "Downloaded tool executables do not match the selected versions.",
          );
        try {
          const retained = parseToolManifest(
            JSON.parse(
              await fs.readFile(path.join(directory, "manifest.json"), "utf8"),
            ),
          );
          if (
            retained.nodeVersion !== version(node.version) ||
            retained.npmVersion !== npmVersion ||
            retained.platform !== platform ||
            retained.arch !== arch
          )
            throw fail(
              "TOOL_CACHE_CONFLICT",
              "The managed tool cache destination has unexpected ownership metadata. Preserve it and inspect the cache before retrying.",
            );
          await fs.rename(
            directory,
            path.join(cacheRoot, `.retained-invalid-${crypto.randomUUID()}`),
          );
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
        await fs.rename(staging, directory);
        selected = await cached(cacheRoot, ranges, platform, arch);
        if (!selected) {
          await fs.rm(directory, { recursive: true, force: true });
          throw fail(
            "TOOL_INSTALL_INVALID",
            "Installed Node/npm could not execute. Check architecture, filesystem permissions and retry.",
          );
        }
        return finish(selected);
      } finally {
        await fs.rm(staging, { recursive: true, force: true });
      }
    });
  } catch (error) {
    if (String(errorCode(error)).startsWith("TOOL_")) throw error;
    throw fail(
      "TOOL_INSTALL_FAILED",
      `Crew could not prepare managed Node/npm (${errorCode(error) || (error instanceof Error ? error.name : "unknown")}). Check network access and write permission for ${cacheRoot}, then retry.`,
    );
  }
}

export async function validateManagedToolchain(
  snapshot: Partial<ManagedToolchain> | null | undefined,
  { env = process.env }: { env?: NodeJS.ProcessEnv } = {},
) {
  if (!snapshot?.nodeVersion)
    return resolveManagedToolchain({
      requirements: {},
      cacheRoot: snapshot?.cacheRoot,
      env,
      install: false,
    });
  return resolveManagedToolchain({
    requirements: {
      node: [snapshot.nodeVersion],
      npm: snapshot.npmVersion ? [snapshot.npmVersion] : [],
    },
    cacheRoot: snapshot.cacheRoot,
    env,
    install: false,
  });
}
