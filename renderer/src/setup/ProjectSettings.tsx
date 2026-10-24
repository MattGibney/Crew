import { ChevronDown as DisclosureChevronDown } from "lucide-react";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { useState } from "react";
import {
  trackingPreferences,
  type TrackerProvider,
} from "../../../src/shared/tracking.mjs";
import type { SetupProps, Repository } from "../contracts/setup.js";
import { readDraftPath } from "./draft.js";
import { FolderOpen, RefreshCw, Save, Square } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Actions,
  Field,
  Hint,
  Select,
  SetupButton,
  SetupCheckbox,
  Status,
} from "./components.js";
import { environmentChoices } from "./model.js";

function Repository({
  repo,
  index,
  setup,
}: SetupProps & { repo: Repository; index: number }) {
  const choice = setup.repositoryOptions.find(
    (item) => item.path === repo.path,
  );
  const branches = choice?.branches || [];
  return (
    <div className="repository space-y-3 rounded-lg border border-border p-4">
      <div>
        <h4 className="font-medium">{repo.name}</h4>
        <Hint className="break-all">{repo.path || "Choose a folder"}</Hint>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`repository-branch-${index}`}>Starting branch</Label>
        <Select
          id={`repository-branch-${index}`}
          aria-label={`Starting branch for ${repo.name}`}
          value={repo.baseRef || ""}
          onChange={(event) => setup.chooseBranch(index, event.target.value)}
        >
          <option value="">Choose a branch</option>
          {branches.map((branch) => (
            <option
              key={branch.ref || branch.value}
              value={branch.ref || branch.value}
            >
              {branch.kind === "remote"
                ? `${branch.label.replace(/^origin\//, "")} (remote)`
                : branch.label}
            </option>
          ))}
          {repo.baseRef &&
            !branches.some(
              (branch) => (branch.ref || branch.value) === repo.baseRef,
            ) && (
              <option value={repo.baseRef}>
                {repo.baseRef} (refresh folder to check)
              </option>
            )}
        </Select>
      </div>
      <Actions>
        <SetupButton onClick={() => setup.pickRepository(index)}>
          Change folder…
        </SetupButton>
        <SetupButton
          variant="ghost"
          onClick={() =>
            setup.edit(
              "project.repositories",
              setup.draft!.project.repositories.filter((_, i) => i !== index),
            )
          }
        >
          Remove folder
        </SetupButton>
      </Actions>
      {choice?.status !== "verified" && (
        <Hint>
          {choice?.detail || "Choose this folder to find its branches."}
        </Hint>
      )}
    </div>
  );
}

function TrackingSettings({ setup }: SetupProps) {
  const tracking = trackingPreferences(setup.draft!.project);
  const [repositoryQuery, setRepositoryQuery] = useState("");
  const github = setup.snapshot?.githubOptions;
  const update = (next: typeof tracking) =>
    setup.save(
      "Save tracking preferences",
      setup.edit("project.tracking", next),
    );
  const toggle = (provider: TrackerProvider, enabled: boolean) => {
    const providers = enabled
      ? [...new Set([...tracking.providers, provider])]
      : tracking.providers.filter((item) => item !== provider);
    update({
      ...tracking,
      providers,
      preferred: providers.includes(tracking.preferred as TrackerProvider)
        ? tracking.preferred
        : providers[0] || "none",
    });
  };
  return (
    <section className="space-y-4" aria-label="External tracking">
      <div>
        <h3 className="font-semibold">External tracking (optional)</h3>
        <Hint>
          Use Crew with no external tracker, Linear, GitHub or both. Change
          these preferences later. Existing workers keep their issue identity.
          Configuration does not start work or verify access.
        </Hint>
      </div>
      <Actions>
        <SetupButton
          onClick={() =>
            update({ ...tracking, providers: [], preferred: "none" })
          }
        >
          No external tracker
        </SetupButton>
      </Actions>
      <div className="flex gap-6">
        {(["linear", "github"] as const).map((provider) => (
          <Label key={provider}>
            <SetupCheckbox
              checked={tracking.providers.includes(provider)}
              onCheckedChange={(checked) => toggle(provider, checked)}
            />
            {provider === "linear" ? "Linear" : "GitHub"}
          </Label>
        ))}
      </div>
      <Label htmlFor="preferred-tracker">Preferred tracker for new work</Label>
      <Select
        id="preferred-tracker"
        value={tracking.preferred}
        onChange={(event) =>
          update({
            ...tracking,
            preferred: event.target.value as typeof tracking.preferred,
          })
        }
      >
        <option value="none">No external tracker</option>
        {tracking.providers.map((provider) => (
          <option key={provider} value={provider}>
            {provider === "linear" ? "Linear" : "GitHub"}
          </option>
        ))}
      </Select>
      {!tracking.providers.length && (
        <Hint>
          Local tasks use their own identity and agreed brief. No external issue
          or account is required.
        </Hint>
      )}
      {tracking.providers.includes("linear") && (
        <LinearSettings setup={setup} />
      )}
      {tracking.providers.includes("github") && (
        <section className="space-y-3" aria-label="GitHub tracking">
          <h4 className="font-medium">GitHub Issues</h4>
          <Status
            name="GitHub discovery"
            value={
              github || {
                status: tracking.githubRepository
                  ? "configured"
                  : "not-configured",
                detail:
                  "Choose a repository through your connected GitHub tools. Saved mapping is not verified access.",
              }
            }
          />
          <Label htmlFor="github-repository">Repository (owner/name)</Label>
          <Select
            id="github-repository"
            value={tracking.githubRepository || ""}
            onChange={(event) =>
              update({
                ...tracking,
                githubRepository: event.target.value || null,
              })
            }
          >
            <option value="">Choose a repository</option>
            {github?.repositories.map((repo) => (
              <option key={repo.fullName} value={repo.fullName}>
                {repo.fullName}
              </option>
            ))}
            {tracking.githubRepository &&
              !github?.repositories.some(
                (repo) => repo.fullName === tracking.githubRepository,
              ) && (
                <option value={tracking.githubRepository}>
                  {tracking.githubRepository} (saved, access unverified)
                </option>
              )}
          </Select>
          <Field
            id="github-repository-query"
            label="Find a specific repository"
            placeholder="owner/repository"
            value={repositoryQuery}
            onChange={setRepositoryQuery}
          />
          <SetupButton
            disabled={!repositoryQuery.trim()}
            onClick={() => setup.verifyGitHub(repositoryQuery.trim())}
          >
            Verify repository
          </SetupButton>
          <Actions>
            <SetupButton
              onClick={() =>
                setup.check("githubOptions", "Find GitHub repositories")
              }
            >
              <RefreshCw />
              {github ? "Retry GitHub discovery" : "Find GitHub repositories"}
            </SetupButton>
            <SetupButton
              variant="ghost"
              onClick={() => toggle("github", false)}
            >
              Disable GitHub
            </SetupButton>
          </Actions>
          {github?.truncated && (
            <Hint>
              This is a bounded list. Ask the manager to find and verify missing
              repositories through connected tools.
            </Hint>
          )}
          <Hint>
            Ask the manager to read an explicitly selected issue, its comments
            and links, or inspect linked pull request changes, reviews and
            checks. Available tools and actual access determine what can be
            read. Nothing is picked up or published automatically.
          </Hint>
        </section>
      )}
    </section>
  );
}

function LinearSettings({ setup }: SetupProps) {
  const catalog = setup.snapshot?.linearOptions;
  const linear = setup.draft!.project.linear;
  const projects = (catalog?.projects || []).filter((project) =>
    project.teamIds?.includes(linear.teamId || ""),
  );
  return (
    <section className="space-y-4" aria-labelledby="linear-heading">
      <div>
        <h3 id="linear-heading" className="font-semibold">
          Linear
        </h3>
        <Hint>
          Choose the team whose tickets this project uses. A Linear project
          filter is optional.
        </Hint>
      </div>
      <p
        id="linear-status"
        role="status"
        className="text-sm text-muted-foreground"
      >
        {(!linear.teamId
          ? "Not configured. "
          : "Configured mapping; access requires a current read. ") +
          (catalog?.detail ||
            "Find your teams through your connected Linear account. Retry discovery, switch tracker or disable Linear above.")}
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="linear-team-choice">Team</Label>
          <Select
            id="linear-team-choice"
            value={linear.teamId || ""}
            onChange={(event) => setup.chooseTeam(event.target.value)}
          >
            <option value="">Connect later</option>
            {(catalog?.teams || []).map((team) => (
              <option key={team.id} value={team.id}>
                {team.name} ({team.key})
              </option>
            ))}
            {linear.teamId &&
              !(catalog?.teams || []).some(
                (team) => team.id === linear.teamId,
              ) && (
                <option value={linear.teamId}>
                  Saved team — refresh to check its name
                </option>
              )}
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="linear-project-choice">Project filter</Label>
          <Select
            id="linear-project-choice"
            disabled={!linear.teamId}
            value={linear.projectId || ""}
            onChange={(event) =>
              setup.save(
                "Save Linear project",
                setup.edit("project.linear.projectId", event.target.value),
              )
            }
          >
            <option value="">All team tickets (no project filter)</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
            {linear.projectId &&
              !projects.some((project) => project.id === linear.projectId) && (
                <option value={linear.projectId}>
                  Saved project — refresh to check its name
                </option>
              )}
          </Select>
        </div>
      </div>
      <Actions>
        <SetupButton
          id="refresh-linear"
          onClick={() => setup.check("linearOptions", "Find Linear teams")}
        >
          <RefreshCw aria-hidden="true" />
          {catalog ? "Refresh Linear teams" : "Find my Linear teams"}
        </SetupButton>
        <SetupButton
          id="defer-linear"
          variant="ghost"
          onClick={setup.deferLinear}
        >
          Connect later
        </SetupButton>
      </Actions>
    </section>
  );
}

function AdvancedSettings({ setup }: SetupProps) {
  const { edit } = setup;
  const draft = setup.draft!;
  const fields = [
    ["id", "Internal project identifier", "project.id"],
    ["context", "Project instructions and context", "project.context"],
    ["team-key", "Linear team key (manual)", "project.linear.teamKey"],
    ["team-id", "Linear team identifier (manual)", "project.linear.teamId"],
    [
      "linear-project",
      "Linear project identifier (manual, optional)",
      "project.linear.projectId",
    ],
    ["data-dir", "Private state folder", "runtime.dataDir"],
    ["manager-prompt", "Manager instructions file", "project.prompts.manager"],
    ["worker-prompt", "Worker instructions file", "project.prompts.worker"],
  ];
  const value = (path: string) => readDraftPath(draft, path);
  return (
    <Collapsible className="rounded-lg border border-border">
      <CollapsibleTrigger
        type="button"
        className="group flex w-full items-center gap-2 text-left cursor-pointer px-4 py-3 font-medium"
      >
        <DisclosureChevronDown
          className="size-4 shrink-0 transition-transform group-aria-expanded:rotate-180"
          aria-hidden="true"
        />
        Advanced settings
      </CollapsibleTrigger>
      <CollapsibleContent keepMounted>
        <div className="space-y-5 border-t border-border p-4">
          <Hint>
            Optional technical settings. Normal setup fills these for you.
            Changes are validated before saving.
          </Hint>
          {fields.slice(0, 2).map(([id, label, path]) => (
            <Field
              key={id}
              id={id}
              label={label}
              value={value(path)}
              onChange={(next) => edit(path, next)}
              multiline={id === "context"}
            />
          ))}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="mode">Project type</Label>
              <Select
                id="mode"
                value={draft.project.mode}
                onChange={(event) => edit("project.mode", event.target.value)}
              >
                <option value="repository">Code project</option>
                <option value="fixture">Disposable test fixture</option>
              </Select>
            </div>
            <Field
              id="port"
              label="Local port"
              value={draft.runtime.port}
              onChange={(next) => edit("runtime.port", next)}
              type="number"
              min="1024"
              max="65535"
            />
          </div>
          <Field
            id="max-workers"
            label="Workers running at once"
            value={draft.project.worker.maxConcurrent ?? 2}
            onChange={(next) => edit("project.worker.maxConcurrent", next)}
            type="number"
            min="1"
            max="8"
            hint="Additional agreed tasks wait in a queue. Default: two."
          />
          {fields.slice(2).map(([id, label, path]) => (
            <Field
              key={id}
              id={id}
              label={label}
              value={value(path)}
              onChange={(next) => edit(path, next)}
            />
          ))}
          <Actions>
            <SetupButton
              id="open-config"
              onClick={() =>
                setup.run("Open configuration", () => setup.api.openConfig())
              }
            >
              Open settings file
            </SetupButton>
            <SetupButton
              id="open-prompts"
              onClick={() =>
                setup.run("Open configuration folder", () =>
                  setup.api.openPrompts(),
                )
              }
            >
              Open settings folder
            </SetupButton>
          </Actions>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export default function ProjectSettings({ setup }: SetupProps) {
  const { snapshot, draft } = setup;
  const environment = environmentChoices(snapshot);
  const savedFolder = snapshot?.config?.project?.repositories?.find(
    (repo) => repo.path,
  )?.path;
  const showSettings =
    draft &&
    !(snapshot?.discoveryRoot && snapshot.discoveryRoot !== savedFolder);
  const info = snapshot?.discoverySummary;
  return (
    <div className="space-y-6">
      <div className="space-y-4 rounded-lg border border-border bg-muted/30 p-4">
        <strong id="discovery-folder" className="block break-all text-sm">
          {snapshot?.discoveryRoot || "No project folder selected."}
        </strong>
        <Actions>
          <SetupButton
            id="pick-discovery"
            onClick={() =>
              setup.run("Choose project folder", async () => {
                const next = await setup.api.chooseDiscovery();
                setup.accept(next);
                return {
                  notice: next.discoveryRoot
                    ? "Folder selected. Choose Set up this project to save its details automatically."
                    : "Folder selection canceled.",
                };
              })
            }
          >
            <FolderOpen aria-hidden="true" />
            Choose project folder…
          </SetupButton>
          <SetupButton
            id="discover"
            variant="default"
            disabled={!snapshot?.discoveryRoot || setup.needsReload}
            onClick={setup.discover}
          >
            Set up this project
          </SetupButton>
          {setup.analyzing && (
            <SetupButton
              id="cancel-discovery"
              allowDuringBusy
              onClick={setup.cancelDiscovery}
            >
              <Square aria-hidden="true" />
              Cancel
            </SetupButton>
          )}
        </Actions>
        <Hint>
          Analysis uses selected code and documentation through your ChatGPT
          sign-in. It runs no project scripts and starts no worker.
        </Hint>
        <p
          id="discovery-progress"
          role="status"
          aria-live="polite"
          className="text-sm font-medium"
        >
          {setup.discoveryProgress}
        </p>
      </div>
      {showSettings && (
        <div id="project-settings" className="space-y-6">
          {draft.project.mode !== "fixture" && (
            <div id="worker-environment-settings" className="space-y-2">
              <Label htmlFor="worker-environment">
                Worker application environment
              </Label>
              <Select
                id="worker-environment"
                value={setup.environment}
                onChange={(event) =>
                  setup.chooseEnvironment(event.target.value)
                }
              >
                {environment.choices.map((choice) => (
                  <option
                    key={choice.value}
                    value={choice.value}
                    disabled={choice.disabled}
                  >
                    {choice.label}
                  </option>
                ))}
              </Select>
              <Hint id="worker-environment-detail">{environment.detail}</Hint>
              <Hint>
                Enabling an environment saves your preference. Provisioning
                starts only when you explicitly assign work.
              </Hint>
            </div>
          )}
          <Field
            id="name"
            label="Project name"
            autoComplete="off"
            value={draft.project.name}
            onChange={(value) => setup.edit("project.name", value)}
          />
          {draft.project.mode !== "fixture" && (
            <div id="business-fields" className="space-y-6">
              <section
                className="space-y-3"
                aria-labelledby="repositories-heading"
              >
                <div>
                  <h3 id="repositories-heading" className="font-semibold">
                    Project folders
                  </h3>
                  <Hint>
                    Workers start from the selected branch in their own separate
                    copy. Your current checkout stays as it is.
                  </Hint>
                </div>
                <div id="repositories" className="space-y-3">
                  {draft.project.repositories.map((repo, index) => (
                    <Repository
                      key={`${index}-${repo.path}`}
                      repo={repo}
                      index={index}
                      setup={setup}
                    />
                  ))}
                </div>
                <SetupButton
                  id="add-repo"
                  onClick={() => setup.pickRepository()}
                >
                  Add another folder…
                </SetupButton>
              </section>
              <Separator />
              <TrackingSettings setup={setup} />
            </div>
          )}
          <Collapsible
            id="understanding"
            className="rounded-lg border border-border"
          >
            <CollapsibleTrigger
              type="button"
              className="group flex w-full items-center gap-2 text-left cursor-pointer px-4 py-3 font-medium"
            >
              <DisclosureChevronDown
                className="size-4 shrink-0 transition-transform group-aria-expanded:rotate-180"
                aria-hidden="true"
              />
              What Crew learned about this project
            </CollapsibleTrigger>
            <CollapsibleContent keepMounted>
              <div className="space-y-3 border-t border-border p-4">
                <p
                  id="understanding-text"
                  className="whitespace-pre-wrap text-sm leading-relaxed"
                >
                  {snapshot?.config?.project?.context || ""}
                </p>
                <div
                  id="proposal-evidence"
                  className="space-y-2 text-sm text-muted-foreground"
                >
                  {info && (
                    <>
                      <p>
                        Based on {info.sources?.length || 0} selected files
                        {info.truncated ? " from part of this repository" : ""}.
                      </p>
                      {(info.findings || []).map((finding, index) => (
                        <p key={index}>
                          {finding.statement} (
                          {finding.sources?.join(", ") ||
                            "Not established by the selected files"}
                          )
                        </p>
                      ))}
                    </>
                  )}
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
          <AdvancedSettings setup={setup} />
          <Actions>
            <SetupButton
              id="save-project"
              variant="default"
              disabled={setup.needsReload}
              onClick={() => setup.save()}
            >
              <Save aria-hidden="true" />
              Save changes
            </SetupButton>
            <SetupButton id="reload" onClick={setup.refresh}>
              Reload saved settings
            </SetupButton>
          </Actions>
          <Hint>
            Branch and tracking choices save when selected. No work starts
            during setup.
          </Hint>
          <div id="project-result">
            <Status name="Project" value={snapshot?.checks?.project} />
          </div>
        </div>
      )}
    </div>
  );
}
