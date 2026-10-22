import { createRoot } from "react-dom/client";
import "../styles/theme.css";
import { DesktopApplication } from "./DesktopApplication";
import { createProjectPresentation } from "./project-presentation";

const bridge = window.crewDesktop;
const presentation = (
  projectId: string,
  command: <T>(name: string, args: unknown) => Promise<T>,
) =>
  createProjectPresentation(projectId, command, bridge!.subscribe, (url) =>
    bridge!.request("openWebLink", url),
  );

createRoot(document.getElementById("root")!).render(
  bridge ? (
    <DesktopApplication bridge={bridge} presentation={presentation} />
  ) : (
    <main className="mx-auto max-w-lg space-y-3 p-10 text-foreground">
      <h1 className="text-xl font-semibold">Open Crew on your desktop</h1>
      <p className="text-sm text-muted-foreground">
        Project setup and owner controls use Crew’s private desktop connection.
        This page does not expose project state in a browser.
      </p>
    </main>
  ),
);
