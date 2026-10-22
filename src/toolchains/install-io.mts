import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { errorCode } from "../shared/errors.mjs";
const run = promisify(execFile);
const fail = (code: string, message: string) =>
  Object.assign(new Error(message), { code });
// Download bounds, archive path inspection and the shared installation lock.
export async function jsonFetch(
  url: string,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(60000),
    redirect: "error",
  });
  if (!response.ok)
    throw fail(
      "TOOL_DOWNLOAD_FAILED",
      `Managed tool download failed (${response.status}) from ${new URL(url).hostname}. Check network access and retry.`,
    );
  const data = await response.text();
  if (data.length > 64000000)
    throw fail(
      "TOOL_DOWNLOAD_FAILED",
      "Managed tool metadata exceeds the supported size.",
    );
  const value: unknown = JSON.parse(data);
  return value;
}
export async function bytesFetch(
  url: string,
  fetchImpl: typeof fetch,
  maxBytes = 150000000,
) {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(120000),
    redirect: "error",
  });
  if (!response.ok)
    throw fail(
      "TOOL_DOWNLOAD_FAILED",
      `Managed tool download failed (${response.status}) from ${new URL(url).hostname}. Check network access and retry.`,
    );
  const chunks = [];
  let length = 0;
  if (!response.body)
    throw fail(
      "TOOL_DOWNLOAD_FAILED",
      "Managed tool download response has no body.",
    );
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maxBytes)
      throw fail(
        "TOOL_DOWNLOAD_FAILED",
        "Managed tool download exceeds the supported size.",
      );
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
export async function withLock<T>(
  root: string,
  action: () => Promise<T>,
): Promise<T> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const lock = path.join(root, ".install-lock");
  const deadline = Date.now() + 300000;
  while (true) {
    try {
      await fs.mkdir(lock);
      await fs.writeFile(
        path.join(lock, "owner.json"),
        JSON.stringify({ pid: process.pid, created: Date.now() }),
      );
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      // Never reclaim another process's lock by guessing its identity.
      if (Date.now() >= deadline)
        throw fail(
          "TOOL_CACHE_BUSY",
          "Crew tool installation is still locked by another process. Retry when that installation finishes.",
        );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await action();
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}
export async function extract(archive: string, destination: string, strip = 1) {
  const { stdout } = await run("/usr/bin/tar", ["-tzf", archive], {
    maxBuffer: 8000000,
  });
  if (
    stdout
      .split("\n")
      .some((entry) => entry.startsWith("/") || entry.split("/").includes(".."))
  )
    throw fail(
      "TOOL_ARCHIVE_INVALID",
      "Managed tool archive contains an unsafe path.",
    );
  await run(
    "/usr/bin/tar",
    ["-xzf", archive, "--strip-components", String(strip), "-C", destination],
    { maxBuffer: 1000000 },
  );
}
