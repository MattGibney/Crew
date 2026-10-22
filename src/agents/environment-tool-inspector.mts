import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMacWorkspaceCommand } from "../access/workspace-executor.mjs";
import { satisfiesToolVersion } from "../toolchains/tool-requirements.mjs";
import type {
  EnvironmentTemplate,
  EnvironmentTemplateInspection,
} from "./environment-templates.mjs";

/** Owner-requested, bounded discovery uses the same clean environment and
 * filesystem boundary as project commands. Never reads login shell or npmrc. */
export async function inspectEnvironmentTemplate(
  template: EnvironmentTemplate,
  privateDirectory: string,
): Promise<EnvironmentTemplateInspection> {
  const report: EnvironmentTemplateInspection = {
    templateId: template.id,
    templateRevision: template.revision,
    checkedAt: new Date().toISOString(),
    tools: [],
    processEvidenceRefs: [],
    processEvidenceComplete: true,
    processesSettled: true,
    limitations: [
      "Existing host tools only; inspection does not install packages or prepare a project.",
      "Host Docker requires a separately acknowledged broad host capability; version inspection does not connect to it.",
      "Localhost-only server binding cannot currently be enforced by the macOS executor; localhost-port requests fail closed.",
      "Explicit incoming TCP ports, when configured, permit listening on all interfaces; tool-version inspection opens no server.",
    ],
  };
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
  const workspace = await realpath(
    await mkdtemp(join(tmpdir(), "crew-tool-inspection-")),
  );
  let settled = true;
  try {
    // Noncanonical roots, including symlinked installations, must be explicitly
    // corrected by the owner; inspecting a template cannot silently widen it.
    for (const root of [
      ...template.executableDirectories,
      ...template.readableDirectories,
    ]) {
      if ((await realpath(root)) !== root || !(await lstat(root)).isDirectory())
        throw new Error(
          "Tool directories must be existing canonical directories.",
        );
    }
    for (const tool of template.tools) {
      let executablePath: string | null = null;
      let inaccessible = false;
      for (const root of [
        ...template.executableDirectories,
        "/usr/bin",
        "/bin",
      ]) {
        const candidate = join(root, tool.name);
        try {
          await access(candidate, constants.X_OK);
          executablePath = candidate;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            inaccessible = true;
        }
      }
      const entry: EnvironmentTemplateInspection["tools"][number] = {
        name: tool.name,
        requestedVersion: tool.versionRequirement,
        observedVersion: null,
        executablePath,
        state: executablePath
          ? "unavailable"
          : inaccessible
            ? "inaccessible"
            : "missing",
        reason: executablePath
          ? null
          : "No accessible executable in the template PATH.",
      };
      report.tools.push(entry);
      if (!executablePath) continue;
      const priorSettled: boolean = settled;
      const priorComplete: boolean = report.processEvidenceComplete === true;
      settled = false;
      report.processEvidenceComplete = false;
      const result = await runMacWorkspaceCommand(
        {
          workspaceDirectory: workspace,
          privateDirectory,
          writable: false,
          executableDirectories: template.executableDirectories,
          readableRoots: template.readableDirectories,
          writableRoots: [],
          environment: template.environment,
        },
        { command: `${tool.name} --version`, timeoutMs: 10_000 },
      );
      settled =
        priorSettled && (!result.mayHaveExecuted || result.processesSettled);
      if (result.processEvidenceRef)
        report.processEvidenceRefs!.push(result.processEvidenceRef);
      report.processEvidenceComplete =
        priorComplete &&
        (!result.mayHaveExecuted || result.processEvidenceRef !== null);
      const version = result.stdout.trim();
      if (
        result.state !== "exited" ||
        result.exitCode !== 0 ||
        !/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)
      ) {
        entry.state = "inaccessible";
        entry.reason =
          "The bounded sandbox version check failed; verify the executable and its required readable tool directories.";
        continue;
      }
      entry.observedVersion = version.replace(/^v/, "");
      entry.state =
        !tool.versionRequirement ||
        satisfiesToolVersion(entry.observedVersion, tool.versionRequirement)
          ? "available"
          : "wrong_version";
      entry.reason =
        entry.state === "wrong_version"
          ? "Installed version does not satisfy this template."
          : null;
    }
  } catch {
    for (const tool of template.tools) {
      if (!report.tools.some((entry) => entry.name === tool.name))
        report.tools.push({
          name: tool.name,
          state: "unavailable",
          requestedVersion: tool.versionRequirement,
          observedVersion: null,
          executablePath: null,
          reason:
            "Tool roots could not be verified within the workspace boundary.",
        });
    }
  } finally {
    report.processesSettled = settled;
    if (settled) await rm(workspace, { recursive: true, force: true });
  }
  return report;
}
