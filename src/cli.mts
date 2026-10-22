#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// All shipped entry points lead to the same desktop composition. The retained
// legacy source is no longer a selectable controller/backend from this CLI.
const runtime = dirname(fileURLToPath(import.meta.url));
const command = process.argv[2] ?? "help";
const help =
  "Crew uses the unified desktop application.\n\n  crew start       Open Crew (does not start agents or voice)\n  crew help        Show these commands\n\nDevelopment: npm run desktop:dev\nUnsigned candidate: npm run desktop:build:mac\nProject setup, Start/Stop/Restart and Quit are in the app.\n";
if (["help", "--help", "-h"].includes(command)) process.stdout.write(help);
else if (command === "start" && process.argv.length === 3) {
  let executable: string;
  let args: string[];
  const packaged = join(runtime, "../../../MacOS/Crew");
  try {
    await access(packaged, constants.X_OK);
    executable = packaged;
    args = [];
  } catch {
    const electron: unknown = createRequire(import.meta.url)("electron");
    if (typeof electron !== "string")
      throw new Error("Launch Crew through its desktop application.");
    executable = electron;
    args = [join(runtime, "desktop/main.mjs")];
  }
  const child = spawn(executable, args, {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.once("error", () => {
    process.stderr.write(
      "Crew could not be opened. Build the desktop application and retry.\n",
    );
    process.exitCode = 1;
  });
  child.unref();
} else {
  process.stderr.write(
    `The legacy '${command}' controller command is unavailable in unified Crew.\n${help}`,
  );
  process.exitCode = 1;
}
