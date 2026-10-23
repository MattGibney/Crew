// Loaded only by scripts/ui-preview/start.mjs; never a production Vite entry.
import { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RotateCcw } from "lucide-react";
import "../styles/theme.css";
import { Button } from "@/components/ui/button";
import { DesktopApplication } from "../agents/DesktopApplication";
import { createProjectPresentation } from "../agents/project-presentation";
import { createPreviewBridge } from "./bridge";
import "./preview.css";

const initial =
  new URLSearchParams(location.search).get("project") === "empty"
    ? "empty"
    : "full";
const preview = createPreviewBridge(initial);
window.crewDesktop = preview.bridge;
// These are preview-only safety rails, in addition to the server's media/network policy.
if (navigator.mediaDevices)
  Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
    configurable: true,
    value: async () => {
      throw new Error("Microphone and camera are disabled in UI preview.");
    },
  });
window.open = () => null;
document.addEventListener(
  "click",
  (event) => {
    const target =
      event.target instanceof Element ? event.target.closest("a") : null;
    if (
      target &&
      new URL(target.href, location.href).origin !== location.origin
    )
      event.preventDefault();
  },
  true,
);
const presentation = (
  projectId: string,
  command: <T>(name: string, args: unknown) => Promise<T>,
) =>
  createProjectPresentation(
    projectId,
    command,
    preview.bridge.subscribe,
    async () => {
      throw new Error("External links are disabled in this sample preview.");
    },
  );

function Preview() {
  const [epoch, setEpoch] = useState(0);
  const [active, setActive] = useState<"empty" | "full">(initial);
  useEffect(
    () =>
      preview.bridge.subscribe((value) => {
        const event = value as {
          type?: string;
          snapshot?: {
            selectedId?: string | null;
            projects?: { id: string; name: string }[];
          };
        };
        if (event.type === "application" && event.snapshot) {
          const name = event.snapshot.projects?.find(
            (project) => project.id === event.snapshot!.selectedId,
          )?.name;
          setActive(name?.toLowerCase().includes("empty") ? "empty" : "full");
        }
      }),
    [],
  );
  const select = (kind: "empty" | "full") => {
    preview.select(kind);
    setActive(kind);
    const url = new URL(location.href);
    url.searchParams.set("project", kind);
    history.replaceState(null, "", url);
  };
  return (
    <div className="crew-preview flex h-dvh min-h-0 flex-col bg-background text-foreground">
      <header
        aria-label="UI preview controls"
        className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/40 px-4 py-2 text-xs"
      >
        <span className="mr-2 font-semibold text-primary">UI preview</span>
        <Button
          size="sm"
          variant={active === "full" ? "secondary" : "ghost"}
          aria-pressed={active === "full"}
          onClick={() => select("full")}
        >
          Populated project
        </Button>
        <Button
          size="sm"
          variant={active === "empty" ? "secondary" : "ghost"}
          aria-pressed={active === "empty"}
          onClick={() => select("empty")}
        >
          Empty project
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            preview.reset();
            setEpoch((value) => value + 1);
          }}
        >
          <RotateCcw aria-hidden="true" />
          Reset sample data
        </Button>
        <span className="ml-auto text-muted-foreground">
          Sample data · local changes only · no live agents
        </span>
      </header>
      <div className="preview-product min-h-0 flex-1">
        <DesktopApplication
          key={epoch}
          bridge={preview.bridge}
          presentation={presentation}
          renderBrowserPage={(state) => (
            <div className="h-full overflow-auto bg-background p-8 text-foreground sm:p-12">
              <div className="mx-auto max-w-3xl space-y-8">
                <div className="flex items-center justify-between border-b pb-4">
                  <strong>Set1 Studio</strong>
                  <span className="text-xs text-muted-foreground">
                    Sample website · {state.title || "Project preview"}
                  </span>
                </div>
                <div className="space-y-3">
                  <p className="text-xs font-medium uppercase tracking-wider text-primary">
                    Your business, working together
                  </p>
                  <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
                    A clearer view of your next move.
                  </h1>
                  <p className="max-w-xl leading-7 text-muted-foreground">
                    Bring your team, customer insights and delivery plans into
                    one shared place. This fictional page lets you review the
                    agent browser’s layout without loading an external website.
                  </p>
                </div>
                <div className="grid gap-4 sm:grid-cols-3">
                  {[
                    "Plan the work",
                    "Keep everyone aligned",
                    "See what changes",
                  ].map((title, index) => (
                    <div key={title} className="rounded-xl border p-5">
                      <span className="text-xs text-primary">0{index + 1}</span>
                      <h2 className="mt-3 font-medium">{title}</h2>
                      <p className="mt-2 text-sm leading-6 text-muted-foreground">
                        Representative page content for design feedback and
                        annotation.
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        />
      </div>
    </div>
  );
}
const hot = import.meta.hot;
const root =
  (hot?.data.root as Root | undefined) ??
  createRoot(document.getElementById("root")!);
if (hot)
  hot.dispose((data) => {
    data.root = root;
  });
root.render(<Preview />);
