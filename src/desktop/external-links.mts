import { execFile } from "node:child_process";
import { shell } from "electron";
import { webLink } from "../shared/web-links.mjs";

/** An argv call, never shell interpolation or a system preference change. */
export async function openWebLink(value: unknown): Promise<void> {
  const url = webLink(value);
  if (!url) throw new TypeError("Only HTTP and HTTPS web links can be opened.");
  if (process.platform === "darwin") {
    await new Promise<void>((resolve, reject) => {
      execFile("/usr/bin/open", ["-a", "Safari", url], (error) =>
        error ? reject(error) : resolve(),
      );
    });
  } else await shell.openExternal(url);
}
