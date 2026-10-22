import { isRecord } from "../workers/errors.mjs";
export interface NodeRelease {
  version: string;
  npm: string;
  files: string[];
}
export interface NpmRelease {
  version: string;
  engines?: { node?: string };
  dist?: { integrity?: string; tarball?: string };
}
export interface ToolManifest {
  nodeVersion: string;
  npmVersion: string;
  platform: string;
  arch: string;
  nodeSha256?: string;
  npmIntegrity?: string;
}
export function parseNodeReleases(value: unknown): NodeRelease[] {
  if (!Array.isArray(value))
    throw new Error("Official Node release metadata is invalid.");
  return value.filter(
    (entry): entry is NodeRelease =>
      isRecord(entry) &&
      typeof entry.version === "string" &&
      typeof entry.npm === "string" &&
      Array.isArray(entry.files) &&
      entry.files.every((file) => typeof file === "string"),
  );
}
export function parseNpmRelease(value: unknown): NpmRelease {
  if (!isRecord(value) || typeof value.version !== "string")
    throw new Error("npm registry release metadata is invalid.");
  const engines =
    isRecord(value.engines) && typeof value.engines.node === "string"
      ? { node: value.engines.node }
      : undefined;
  const dist = isRecord(value.dist)
    ? {
        integrity:
          typeof value.dist.integrity === "string"
            ? value.dist.integrity
            : undefined,
        tarball:
          typeof value.dist.tarball === "string"
            ? value.dist.tarball
            : undefined,
      }
    : undefined;
  return { version: value.version, engines, dist };
}
export function parseNpmMetadata(value: unknown): {
  versions: Record<string, NpmRelease>;
} {
  if (!isRecord(value) || !isRecord(value.versions))
    throw new Error("npm registry metadata is invalid.");
  return {
    versions: Object.fromEntries(
      Object.entries(value.versions).map(([key, release]) => [
        key,
        parseNpmRelease(release),
      ]),
    ),
  };
}
export function parseToolManifest(value: unknown): ToolManifest {
  if (
    !isRecord(value) ||
    typeof value.nodeVersion !== "string" ||
    typeof value.npmVersion !== "string" ||
    typeof value.platform !== "string" ||
    typeof value.arch !== "string"
  )
    throw new Error("Managed tool manifest is invalid.");
  return {
    nodeVersion: value.nodeVersion,
    npmVersion: value.npmVersion,
    platform: value.platform,
    arch: value.arch,
    nodeSha256:
      typeof value.nodeSha256 === "string" ? value.nodeSha256 : undefined,
    npmIntegrity:
      typeof value.npmIntegrity === "string" ? value.npmIntegrity : undefined,
  };
}
