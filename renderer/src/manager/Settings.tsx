import type { ManagerProps } from "../contracts/manager.js";

import { useEffect, useRef, useState } from "react";
import { Radio, UserRound, Users, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";

import { Alert, AlertDescription } from "@/components/ui/alert";

import { SettingsToast } from "./settings/SettingsToast.js";
import {
  useWorkspaceSettings,
  ProjectGeneral,
  GlobalSettings,
} from "./settings/WorkspaceSettings.js";
import { ManagerSchedules } from "./settings/ManagerSchedules.js";
import { ManagerProfile } from "./settings/ManagerProfile.js";
import { ManagerLifecycle } from "./settings/ManagerLifecycle.js";
import { PromptEditor } from "./settings/PromptEditor.js";
export { ManagerLifecycle } from "./settings/ManagerLifecycle.js";

import { Archive } from "lucide-react";
import { ArchivedWorkers } from "./settings/ArchivedWorkers.js";
import { ManagerIdentity } from "./settings/ManagerIdentity.js";
import { ManagerPersonality } from "./settings/ManagerPersonality.js";
import { WorkerEnvironment } from "./WorkerEnvironment.js";
export function Settings({ manager }: ManagerProps) {
  const [page, setPage] = useState("sessions");
  const workspace = useWorkspaceSettings();
  const selectedProject = workspace.snapshot?.projects.find(
    (project) => project.id === workspace.snapshot?.selectedId,
  );
  const [toast, setToast] = useState<{ id: string; message: string } | null>(
    null,
  );
  const notify = (message: string) =>
    setToast({ id: crypto.randomUUID(), message });
  const content = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (content.current) content.current.scrollTop = 0;
  }, [page]);
  const pages = [
    {
      id: "global",
      label: "General",
      icon: SlidersHorizontal,
      description: "Preferences shared across every project on this Mac.",
    },
    {
      id: "project",
      label: "General",
      icon: SlidersHorizontal,
      description: "Manage the details for this project.",
    },
    {
      id: "archive",
      label: "Archived workers",
      icon: Archive,
      description:
        "Past workers whose teardown is complete. Restore a worker or permanently delete its saved Crew history.",
    },
    {
      id: "sessions",
      label: "Sessions",
      icon: Radio,
      description: "Manage the live manager session for this project.",
    },
    {
      id: "schedules",
      label: "Manager schedules",
      icon: Radio,
      description:
        "Choose what your manager checks and when it runs in the background.",
    },
    {
      id: "manager",
      label: "Manager profile",
      icon: UserRound,
      description:
        "Customize your AI manager’s name, picture, personality, voice and instructions.",
    },
    {
      id: "environment",
      label: "Worker environment",
      icon: SlidersHorizontal,
      description: "Manage lifecycle commands used in worker worktrees.",
    },
    {
      id: "worker",
      label: "Worker profile",
      icon: Users,
      description:
        "Set the instructions used for worker directions and launches.",
    },
  ];
  const current = pages.find((item) => item.id === page);
  return (
    <section
      ref={content}
      aria-label="Settings"
      className="min-h-0 flex-1 overflow-y-auto px-5 py-10 sm:px-10"
    >
      <div className="mx-auto grid max-w-6xl items-start gap-8 md:grid-cols-[192px_minmax(0,1fr)] md:gap-12 lg:grid-cols-[224px_minmax(0,1fr)] lg:gap-16">
        <aside className="self-start md:sticky md:top-0">
          <h1 className="mb-3 px-3 text-sm font-semibold tracking-tight">
            Settings
          </h1>
          <nav aria-label="Settings pages" className="space-y-6">
            {[
              {
                label: "Global settings",
                items: pages.filter((item) => item.id === "global"),
              },
              {
                label: "Project settings",
                items: pages.filter((item) => item.id !== "global"),
              },
            ].map((group) => (
              <div key={group.label}>
                <h2 className="mb-2 px-3 text-[11px] font-medium text-muted-foreground">
                  {group.label}
                </h2>
                <div className="flex flex-wrap gap-2 md:flex-col">
                  {group.items.map(({ id, label, icon: Icon }) => (
                    <Button
                      key={id}
                      type="button"
                      variant="ghost"
                      aria-label={
                        id === "global"
                          ? "Global general settings"
                          : id === "project"
                            ? "Project general settings"
                            : label
                      }
                      aria-current={page === id ? "page" : undefined}
                      className={`h-11 justify-start gap-3 rounded-lg px-3 text-sm md:w-full ${page === id ? "bg-muted/60 font-semibold text-primary" : "font-medium text-muted-foreground hover:text-foreground"}`}
                      onClick={() => setPage(id)}
                    >
                      <Icon
                        className={`size-5 ${page === id ? "text-primary" : "text-muted-foreground/70"}`}
                        aria-hidden="true"
                      />
                      {label}
                    </Button>
                  ))}
                </div>
              </div>
            ))}
          </nav>
        </aside>
        <div className="min-w-0 space-y-8">
          <div>
            <p className="mb-2 text-xs font-medium text-primary">
              {page === "global"
                ? "All projects · This Mac"
                : selectedProject?.name ||
                  manager.settings?.projectName ||
                  manager.projectInfo?.name ||
                  "This project"}
            </p>
            <h2 className="text-2xl font-semibold tracking-tight">
              {current?.label}
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {current?.description}
            </p>
          </div>
          <div hidden={page !== "global"} aria-label="Global settings">
            <GlobalSettings workspace={workspace} onNotify={notify} />
          </div>
          <div
            hidden={page !== "project"}
            aria-label="Project general settings"
          >
            <ProjectGeneral
              key={selectedProject?.id || "loading"}
              workspace={workspace}
              onNotify={notify}
            />
          </div>
          {page !== "global" && manager.settingsError && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>
                {manager.settingsError}
                <Button
                  className="ml-2"
                  variant="outline"
                  onClick={() => void manager.loadSettings().catch(() => {})}
                >
                  Reload settings
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {page === "archive" && (
            <ArchivedWorkers
              key={
                manager.settings?.projectId ||
                manager.projectInfo?.id ||
                "loading"
              }
              manager={manager}
            />
          )}
          <div
            hidden={page !== "schedules"}
            aria-label="Manager schedule settings"
          >
            <ManagerSchedules
              manager={manager}
              onNotify={notify}
              visible={page === "schedules"}
            />
          </div>
          <div hidden={page !== "sessions"} aria-label="Session settings">
            <section
              aria-labelledby="manager-lifecycle-heading"
              className="border-t pt-6"
            >
              <h3 id="manager-lifecycle-heading" className="mb-4 font-semibold">
                Manager session
              </h3>
              <ManagerLifecycle manager={manager} />
            </section>
          </div>
          <div
            hidden={page !== "manager"}
            aria-label="Manager profile settings"
            className="space-y-12"
          >
            <div key={manager.settings?.projectId || "loading"}>
              <ManagerIdentity manager={manager} onNotify={notify} />
              <ManagerPersonality manager={manager} onNotify={notify} />
              <ManagerProfile
                key={manager.settings?.projectId || "loading"}
                manager={manager}
                onNotify={notify}
              />
            </div>
            {manager.settings ? (
              <PromptEditor
                key={`${manager.settings.projectId}:manager`}
                role="manager"
                data={manager.settings.manager}
                manager={manager}
                onNotify={notify}
              />
            ) : (
              <p role="status" className="text-sm text-muted-foreground">
                Loading manager instructions…
              </p>
            )}
          </div>
          <div
            hidden={page !== "environment"}
            aria-label="Worker environment settings"
          >
            <WorkerEnvironment
              key={manager.settings?.projectId || "loading"}
              manager={manager}
              onNotify={notify}
            />
          </div>
          <div hidden={page !== "worker"} aria-label="Worker profile settings">
            {manager.settings ? (
              <PromptEditor
                key={`${manager.settings.projectId}:worker`}
                role="worker"
                data={manager.settings.worker}
                manager={manager}
                onNotify={notify}
              />
            ) : (
              <p role="status" className="text-sm text-muted-foreground">
                Loading worker instructions…
              </p>
            )}
          </div>
        </div>
      </div>
      {toast && (
        <SettingsToast
          key={toast.id}
          message={toast.message}
          onDismiss={() => setToast(null)}
        />
      )}
    </section>
  );
}
