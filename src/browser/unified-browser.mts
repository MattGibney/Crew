import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import type { BrowserWindow } from "electron";
import type { Agent, CallerContext, JsonObject } from "../agents/contracts.mjs";
import type { AgentToolExtension } from "../agents/session-host.mjs";
import type { ProjectAuthorizationService } from "../access/authorization.mjs";
import {
  createProjectBrowser,
  experimentURL,
} from "../desktop/project-browser.mjs";
import { pinnedBrowserCatalogue } from "./pinned-catalogue.mjs";
import { createPreviewMcpClient } from "./mcp-client.mjs";
import type { BrowserState, BrowserSelection } from "./contracts.mjs";

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid browser request.");
  return value as Record<string, unknown>;
};
const empty: BrowserState = {
  open: false,
  url: "",
  title: "Project browser",
  loading: false,
  canGoBack: false,
  canGoForward: false,
};
const shape = (
  properties: JsonObject,
  required = Object.keys(properties),
): JsonObject => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const selectionScript = `new Promise(resolve => {
  globalThis.__crewBrowserCancel?.();
  const overlay = document.createElement('div');
  overlay.setAttribute('data-crew-preview-picker','');
  overlay.style.cssText='position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(25,90,240,.035)';
  document.documentElement.appendChild(overlay);
  const cancel=()=>{overlay.remove();resolve(null);delete globalThis.__crewBrowserCancel;};
  globalThis.__crewBrowserCancel=cancel;
  overlay.addEventListener('click',event=>{
    event.preventDefault();event.stopImmediatePropagation();overlay.remove();
    const el=document.elementFromPoint(event.clientX,event.clientY);
    if(!el){cancel();return;}
    let cursor=el,parts=[];
    for(let i=0;cursor&&i<6;i++,cursor=cursor.parentElement){
      if(cursor.id){parts.unshift('#'+CSS.escape(cursor.id));break;}
      const siblings=cursor.parentElement?Array.from(cursor.parentElement.children).filter(x=>x.tagName===cursor.tagName):[cursor];
      parts.unshift(cursor.tagName.toLowerCase()+':nth-of-type('+(siblings.indexOf(cursor)+1)+')');
    }
    const r=el.getBoundingClientRect();
    delete globalThis.__crewBrowserCancel;
    resolve({url:location.href,title:document.title.slice(0,500),selector:parts.join(' > ').slice(0,2000),text:(el.innerText||el.textContent||'').slice(0,2000),rect:{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}});
  },{once:true});
  setTimeout(cancel,30000);
})`;

/** Desktop-owned browser boundary. No native credentials, prompts or agent launching.
 * Main authenticates owner IPC; agent tools additionally require current access and
 * the exact owner-selected logical session on every discovery and dispatch. */
export function createUnifiedProjectBrowser(options: {
  projectId: string;
  stateDirectory: string;
  getWindow(): BrowserWindow | undefined;
  getHostOrigin(): string;
  getAgent(id: string): Agent | null;
  publish(event: {
    type: "browser";
    projectId: string;
    state: BrowserState;
  }): void;
}) {
  let browser: ReturnType<typeof createProjectBrowser> | undefined;
  let client: Awaited<ReturnType<typeof createPreviewMcpClient>> | undefined;
  let catalogue: Awaited<ReturnType<NonNullable<typeof client>["list"]>> = [];
  let binding: CallerContext | null = null;
  let initialOrigin = "";
  let lastUrl = "";
  let selection: BrowserSelection | null = null;
  let selecting = false;
  let captureGeneration = 0;
  let error: string | null = null;
  let changing = false;
  let work = Promise.resolve();
  const subscribers = new Set<() => void>();
  const notifyTools = () => {
    for (const listener of subscribers) listener();
  };
  const validBinding = (caller: CallerContext) => {
    if (
      changing ||
      !binding ||
      caller.projectId !== options.projectId ||
      caller.agentId !== binding.agentId ||
      caller.sessionId !== binding.sessionId
    )
      return false;
    const agent = options.getAgent(caller.agentId);
    return (
      !!agent &&
      !agent.archivedAt &&
      agent.runtime.session.sessionId === caller.sessionId &&
      agent.runtime.session.desiredState === "started" &&
      agent.runtime.session.observedState === "started"
    );
  };
  const state = (): BrowserState => ({
    ...(browser?.state() ?? { ...empty, url: lastUrl }),
    recipientAgentId: binding && validBinding(binding) ? binding.agentId : null,
    selection,
    selecting,
    error: error ?? browser?.state().error ?? null,
    automation: client?.connected()
      ? "Scoped browser tools connected; browser.control permission required"
      : "Browser tools disconnected",
  });
  const publish = () =>
    options.publish({
      type: "browser",
      projectId: options.projectId,
      state: state(),
    });
  const changed = () => {
    const url = browser?.state().url;
    if (selection && url && selection.url !== url) selection = null;
    publish();
  };
  const serial = <T,>(operation: () => Promise<T>) => {
    const result = work.then(operation, operation);
    work = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  async function cancelSelection() {
    captureGeneration++;
    selecting = false;
    await browser
      ?.contents()
      ?.executeJavaScriptInIsolatedWorld(999, [
        { code: "globalThis.__crewBrowserCancel?.()" },
      ])
      .catch(() => {});
  }
  async function close() {
    changing = true;
    binding = null;
    notifyTools();
    await cancelSelection();
    // Never drop a client reference when its owned tool process has unknown exit.
    if (client) {
      await client.close();
      client = undefined;
    }
    catalogue = [];
    if (browser) {
      await browser.close();
      browser = undefined;
    }
    selection = null;
    changing = false;
    publish();
  }
  function bind(agentId: unknown) {
    binding = null;
    if (typeof agentId === "string") {
      const agent = options.getAgent(agentId);
      if (!agent || agent.archivedAt) throw Error("Choose an available agent.");
      const session = agent.runtime.session;
      if (
        session.sessionId &&
        session.desiredState === "started" &&
        session.observedState === "started"
      )
        binding = {
          projectId: options.projectId,
          agentId,
          sessionId: session.sessionId,
        };
      else
        error =
          "Preview opened for you. Start the selected agent, then explicitly give it browser control.";
    }
    notifyTools();
  }
  async function open(url: string, agentId: unknown) {
    const parsed = experimentURL(url, options.getHostOrigin());
    const window = options.getWindow();
    if (!window || window.isDestroyed())
      throw Error("Open the Crew window before its browser.");
    if (browser && parsed.origin !== initialOrigin) await close();
    if (!browser) {
      initialOrigin = parsed.origin;
      lastUrl = parsed.href;
      browser = createProjectBrowser(
        window,
        parsed.href,
        options.getHostOrigin,
        changed,
      );
      try {
        await browser.request({ action: "open" });
      } catch (cause) {
        await browser.close();
        browser = undefined;
        throw cause;
      }
      const toolsHome = join(options.stateDirectory, "browser-tools");
      await mkdir(toolsHome, { recursive: true, mode: 0o700 });
    }
    if (!client?.connected()) {
      if (client) {
        await client.close();
        client = undefined;
      }
      const toolsHome = join(options.stateDirectory, "browser-tools");
      await mkdir(toolsHome, { recursive: true, mode: 0o700 });
      client = await createPreviewMcpClient({
        onDisconnect: () => {
          publish();
          notifyTools();
        },
        endpoint: browser.endpoint()!,
        command: process.execPath,
        args: [
          fileURLToPath(
            new URL(
              "./bin/chrome-devtools-mcp.js",
              import.meta.resolve("chrome-devtools-mcp"),
            ),
          ),
        ],
        cwd: toolsHome,
        env: {
          HOME: toolsHome,
          PATH: "/usr/bin:/bin",
          TMPDIR: tmpdir(),
          ELECTRON_RUN_AS_NODE: "1",
          CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1",
        },
      });
      catalogue = await client.list();
    }
    window.once("closed", () => {
      void serial(close).catch(() => {});
    });
    bind(agentId);
    publish();
  }
  async function annotation(input: Record<string, unknown>) {
    const contents = browser?.contents();
    if (!contents || contents.isDestroyed() || contents.isLoading())
      throw Error("Wait for the preview page to finish loading.");
    if (
      typeof input.recipientAgentId !== "string" ||
      !options.getAgent(input.recipientAgentId) ||
      options.getAgent(input.recipientAgentId)?.archivedAt
    )
      throw Error("The annotation recipient is unavailable.");
    if (
      typeof input.comment !== "string" ||
      !input.comment.trim() ||
      input.comment.length > 8000
    )
      throw Error("Enter feedback of at most 8,000 characters.");
    if (input.annotationScope !== "page" && input.annotationScope !== "element")
      throw Error("Choose page or element feedback.");
    const picked = input.annotationScope === "element" ? selection : null;
    if (
      input.annotationScope === "element" &&
      (!picked || picked.url !== contents.getURL() || selecting)
    )
      throw Error("Select an element on the current page again.");
    const capturedAt = new Date().toISOString();
    const capturedUrl = contents.getURL();
    let image = await contents.capturePage();
    const viewport = image.getSize();
    if (viewport.width > 1280) image = image.resize({ width: 1280 });
    const png = image.toPNG();
    if (
      !viewport.width ||
      !viewport.height ||
      !png.length ||
      png.length > 5 * 1024 * 1024
    )
      throw Error(
        "The preview capture is empty or too large. Keep the browser visible and retry.",
      );
    if (contents.isLoading() || contents.getURL() !== capturedUrl)
      throw Error(
        "The page changed during capture. Review it and send the annotation again.",
      );
    const id = randomUUID(),
      directory = join(options.stateDirectory, "browser-artifacts");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const meta = {
      projectId: options.projectId,
      recipientAgentId: input.recipientAgentId,
      url: contents.getURL(),
      title: contents.getTitle(),
      capturedAt,
      selection: picked,
      viewport,
      imageSize: image.getSize(),
    };
    await writeFile(join(directory, id + ".png"), png, {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(join(directory, id + ".json"), JSON.stringify(meta), {
      flag: "wx",
      mode: 0o600,
    });
    const screenshotRef = "crew-browser-shot:" + id;
    return {
      ...state(),
      annotation: {
        content: [
          {
            type: "text" as const,
            text: `Browser feedback from the owner:\n${input.comment.trim()}\nPage: ${meta.title}\nURL: ${meta.url}\nCaptured: ${capturedAt}\n${picked ? `Element: ${picked.selector}\nText: ${picked.text}\nBounds: ${JSON.stringify(picked.rect)}` : "Scope: current page"}\nScreenshot reference: ${screenshotRef}. If browser tools are authorized, use browser_annotation_image with this reference to inspect this exact captured image.`,
          },
          {
            type: "data" as const,
            value: JSON.parse(
              JSON.stringify({ browserAnnotation: { ...meta, screenshotRef } }),
            ) as JsonObject,
          },
        ],
      },
    };
  }
  const service = {
    state,
    close: () => serial(close),
    request(input: unknown): Promise<BrowserState> {
      const value = object(input);
      if (value.projectId !== options.projectId)
        return Promise.reject(
          Error("Browser project identity does not match."),
        );
      if (value.action === "state") return Promise.resolve(state());
      return serial(async () => {
        error = null;
        if (value.action === "close") await close();
        else if (value.action === "open")
          await open(
            typeof value.url === "string" && value.url
              ? value.url
              : lastUrl || "http://127.0.0.1:3000",
            value.recipientAgentId,
          );
        else if (value.action === "annotation") return annotation(value);
        else if (value.action === "selectElement") {
          const contents = browser?.contents();
          if (!contents || contents.isDestroyed())
            throw Error("Open the preview page first.");
          await cancelSelection();
          selection = null;
          selecting = true;
          const generation = captureGeneration;
          void contents
            .executeJavaScriptInIsolatedWorld(999, [{ code: selectionScript }])
            .then((result: unknown) => {
              if (generation !== captureGeneration) return;
              selecting = false;
              if (result)
                selection = {
                  ...object(result),
                  capturedAt: new Date().toISOString(),
                } as unknown as BrowserSelection;
              publish();
            })
            .catch(() => {
              if (generation === captureGeneration) {
                selecting = false;
                error = "Selection ended. Select an element again.";
                publish();
              }
            });
        } else {
          if (!browser) throw Error("Open the project browser first.");
          if (value.action === "bounds" && value.visible === false)
            await browser.request({
              action: "bounds",
              bounds: { x: 0, y: 0, width: 0, height: 0 },
            });
          else if (
            value.action === "navigate" &&
            typeof value.url === "string" &&
            experimentURL(value.url, options.getHostOrigin()).origin !==
              initialOrigin
          )
            await open(value.url, binding?.agentId);
          else await browser.request(value);
        }
        publish();
        return state();
      }).catch((cause) => {
        error =
          cause instanceof Error ? cause.message : "Browser action failed.";
        publish();
        throw Error(error);
      });
    },
    tools(context: {
      authorization: Pick<ProjectAuthorizationService, "canDiscoverBrowser">;
      runAuthorized<T>(
        caller: CallerContext,
        action: "browser.control",
        operation: () => Promise<T>,
      ): Promise<T>;
    }): AgentToolExtension {
      return {
        subscribe(listener) {
          subscribers.add(listener);
          return () => subscribers.delete(listener);
        },
        async list(caller) {
          if (!(await context.authorization.canDiscoverBrowser(caller)))
            return [];
          return [
            {
              name: "browser_status",
              description:
                "Read the current owner-shared project browser target. Preview tools only control this visible page.",
              inputSchema: shape({}),
            },
            {
              name: "browser_annotation_image",
              description:
                "Inspect the exact historical screenshot reference supplied in owner browser feedback for this agent.",
              inputSchema: shape({
                screenshotRef: {
                  type: "string",
                  pattern: "^crew-browser-shot:[0-9a-f-]{36}$",
                },
              }),
            },
            ...pinnedBrowserCatalogue.map((tool) => ({
              ...tool,
              name: "browser_" + tool.name,
              description:
                tool.description ?? "Control the owner-shared preview.",
            })),
          ];
        },
        async call(caller, name, args) {
          if (!validBinding(caller))
            throw Error(
              "This browser is not shared with your current agent session. Ask the owner to bind it.",
            );
          return context.runAuthorized(caller, "browser.control", async () => {
            if (!validBinding(caller))
              throw Error("Browser binding changed before dispatch.");
            if (name === "browser_status") return state();
            if (name === "browser_annotation_image") {
              const ref = args.screenshotRef;
              if (
                typeof ref !== "string" ||
                !/^crew-browser-shot:[0-9a-f-]{36}$/.test(ref)
              )
                throw Error("Invalid screenshot reference.");
              const id = ref.slice("crew-browser-shot:".length),
                directory = join(options.stateDirectory, "browser-artifacts");
              const meta = object(
                JSON.parse(
                  await readFile(join(directory, id + ".json"), "utf8"),
                ),
              );
              if (
                meta.projectId !== caller.projectId ||
                meta.recipientAgentId !== caller.agentId
              )
                throw Error("This screenshot belongs to another recipient.");
              const file = join(directory, id + ".png"),
                stat = await lstat(file);
              if (
                !stat.isFile() ||
                stat.isSymbolicLink() ||
                stat.size > 5 * 1024 * 1024
              )
                throw Error("Screenshot unavailable.");
              return {
                crewMcpResult: {
                  content: [
                    {
                      type: "image",
                      mimeType: "image/png",
                      data: (await readFile(file)).toString("base64"),
                    },
                    { type: "text", text: JSON.stringify(meta) },
                  ],
                },
              };
            }
            if (
              !name.startsWith("browser_") ||
              !client ||
              !catalogue.some((t) => "browser_" + t.name === name)
            )
              throw Error("Unknown browser tool.");
            return { crewMcpResult: await client.call(name.slice(8), args) };
          });
        },
      };
    },
  };
  return service;
}
