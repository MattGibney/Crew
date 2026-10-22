// Read private evidence with bounded bytes, no symlink traversal and a shared
// request budget. Missing files are distinct from malformed/unavailable files.
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { errorCode, record as isRecord } from "../shared/errors.mjs";
export type EvidenceRecord = Record<string, unknown>;
export async function createEvidenceReader(
  stateDir: string,
): Promise<(...parts: string[]) => Promise<EvidenceRecord | null>> {
  const root = await realpath(path.resolve(stateDir));
  let reads = 0;
  return async (...parts) => {
    if (++reads > 4096) throw new Error("Evidence unavailable");
    const target = path.join(root, ...parts);
    let file;
    try {
      if ((await realpath(path.dirname(target))) !== path.dirname(target))
        throw new Error("Linked evidence directory");
      file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 262144)
        throw new Error("Unbounded evidence");
      const bytes = await file.readFile();
      if (bytes.length > 262144) throw new Error("Unbounded evidence");
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      if (!isRecord(value)) throw new Error("Malformed evidence");
      return value;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    } finally {
      await file?.close();
    }
  };
}
export function evidenceObject(value: unknown): EvidenceRecord {
  if (value === null || value === undefined) return {};
  if (!isRecord(value)) throw new Error("Malformed evidence object");
  return value;
}
export function evidenceList(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Malformed evidence list");
  return value;
}
