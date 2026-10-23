import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import type { Agent, CallerContext, JsonObject } from "../agents/contracts.mjs";
import type { AgentToolExtension } from "../agents/session-host.mjs";
import type { ProjectAuthorizationService } from "../access/authorization.mjs";
import type { BrowserState } from "./contracts.mjs";
import { createBrowserTab } from "./browser-tab.mjs";
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid browser request.");
  return value as Record<string, unknown>;
};
const empty: BrowserState = {
  open: false,
  url: "",
  title: "New tab",
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
/** Stable agent ownership is independent of native session IDs and owner UI focus.
 * Each tab retains its own restricted CDP facade. Tabs share a private persistent session
 * only within their stable agent; no personal browser or other agent cookies.
 */
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
  type Tab = { id: string; service: ReturnType<typeof createBrowserTab> };
  type Workspace = { tabs: Map<string, Tab>; active: string | null };
  const workspaces = new Map<string, Workspace>();
  let selected: string | null = null;
  let queue = Promise.resolve();
  const subscribers = new Set<() => void>();
  let bounds: Record<string, unknown> | null = null;
  const serial = <T,>(operation: () => Promise<T>) => {
    const result = queue.then(operation, operation);
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  function workspace(id: string) {
    const agent = options.getAgent(id);
    if (!agent || agent.archivedAt) throw Error("Choose an available agent.");
    let value = workspaces.get(id);
    if (!value) {
      value = { tabs: new Map(), active: null };
      workspaces.set(id, value);
    }
    return value;
  }
  function stateFor(id: string | null): BrowserState {
    const ws = id ? workspaces.get(id) : undefined;
    const tab = ws?.active ? ws.tabs.get(ws.active) : undefined;
    return {
      ...(tab?.service.state() ?? empty),
      ownerAgentId: id,
      recipientAgentId: id,
      activeTabId: tab?.id ?? null,
      tabs: [...(ws?.tabs.values() ?? [])].map((t) => {
        const value = t.service.state();
        return {
          id: t.id,
          title: value.url ? value.title : "New tab",
          url: value.url,
          loading: value.loading,
        };
      }),
    };
  }
  const state = () => stateFor(selected);
  const publish = () =>
    options.publish({
      type: "browser",
      projectId: options.projectId,
      state: state(),
    });
  const notify = () => {
    for (const listener of subscribers) listener();
  };
  async function hide(tab: Tab | undefined) {
    if (tab)
      await tab.service
        .request({
          projectId: options.projectId,
          action: "bounds",
          visible: false,
        })
        .catch(() => {});
  }
  async function selectAgent(id: string) {
    workspace(id);
    if (selected !== id) {
      const prior = selected ? workspaces.get(selected) : undefined;
      await hide(prior?.active ? prior.tabs.get(prior.active) : undefined);
      selected = id;
      const ws = workspace(id),
        tab = ws.active ? ws.tabs.get(ws.active) : undefined;
      if (tab?.service.state().open && bounds)
        await tab.service.request({
          ...bounds,
          projectId: options.projectId,
          action: "bounds",
        });
    }
  }
  async function selectTab(id: string, tabId: string) {
    const ws = workspace(id),
      tab = ws.tabs.get(tabId);
    if (!tab) throw Error("This tab does not belong to this agent.");
    await hide(ws.active ? ws.tabs.get(ws.active) : undefined);
    ws.active = tab.id;
    if (selected === id && bounds && tab.service.state().open)
      await tab.service.request({
        ...bounds,
        projectId: options.projectId,
        action: "bounds",
      });
  }
  async function newTab(id: string, url?: string) {
    const ws = workspace(id),
      tabId = randomUUID();
    const tab: Tab = {
      id: tabId,
      service: createBrowserTab({
        ...options,
        ownerAgentId: id,
        tabId,
        publish: () => publish(),
      }),
    };
    ws.tabs.set(tabId, tab);
    try {
      if (url)
        await tab.service.request({
          projectId: options.projectId,
          action: "open",
          url,
          recipientAgentId: id,
        });
      await selectTab(id, tabId);
    } catch (cause) {
      ws.tabs.delete(tabId);
      await tab.service.close();
      throw cause;
    }
    notify();
    return tab;
  }
  async function closeTab(id: string, tabId: string) {
    const ws = workspaces.get(id),
      tab = ws?.tabs.get(tabId);
    if (!ws || !tab) throw Error("This tab does not belong to this agent.");
    await tab.service.close();
    ws.tabs.delete(tabId);
    if (ws.active === tabId) {
      ws.active = null;
      const next = ws.tabs.keys().next().value;
      if (next) {
        ws.active = next;
        const tab = ws.tabs.get(next)!;
        if (selected === id && bounds && tab.service.state().open)
          await tab.service.request({
            ...bounds,
            projectId: options.projectId,
            action: "bounds",
          });
      }
    }
    notify();
  }
  async function closeAgent(id: string) {
    const ws = workspaces.get(id);
    if (!ws) return;
    for (const tab of [...ws.tabs.values()]) await closeTab(id, tab.id);
  }
  function currentCaller(caller: CallerContext) {
    const agent = options.getAgent(caller.agentId);
    if (
      caller.projectId !== options.projectId ||
      !agent ||
      agent.archivedAt ||
      agent.runtime.session.sessionId !== caller.sessionId ||
      agent.runtime.session.desiredState !== "started" ||
      agent.runtime.session.observedState !== "started"
    )
      throw Error("Browser control requires the exact current agent session.");
  }
  return {
    state,
    close: () =>
      serial(async () => {
        for (const id of workspaces.keys()) await closeAgent(id);
        publish();
      }),
    request(input: unknown): Promise<BrowserState> {
      const value = object(input);
      if (value.projectId !== options.projectId)
        return Promise.reject(
          Error("Browser project identity does not match."),
        );
      if (value.action === "state") return Promise.resolve(state());
      return serial(async () => {
        const id =
          typeof value.agentId === "string"
            ? value.agentId
            : value.action === "open" &&
                typeof value.recipientAgentId === "string"
              ? value.recipientAgentId
              : selected;
        if (
          value.action === "bounds" &&
          (!id ||
            id !== selected ||
            (value.tabId && value.tabId !== workspaces.get(id)?.active))
        )
          return state();
        if (!id) throw Error("Choose the agent whose browser to open.");
        if (value.action === "select_agent") await selectAgent(id);
        else {
          if (selected !== id) await selectAgent(id);
          const ws = workspace(id);
          if (value.action === "close") await closeAgent(id);
          else if (value.action === "new_tab")
            await newTab(
              id,
              typeof value.url === "string" && value.url
                ? value.url
                : undefined,
            );
          else if (value.action === "select_tab")
            await selectTab(id, String(value.tabId));
          else if (value.action === "close_tab")
            await closeTab(id, String(value.tabId ?? ws.active));
          else {
            let tab = ws.active ? ws.tabs.get(ws.active) : undefined;
            if (value.tabId && value.tabId !== ws.active)
              throw Error("Select this agent's tab before controlling it.");
            if (value.action === "bounds") bounds = value;
            if (!tab && value.action === "open") tab = await newTab(id);
            if (!tab) {
              if (value.action === "bounds") return state();
              throw Error("Open an agent browser tab first.");
            }
            if (value.action === "bounds" && !tab.service.state().open)
              return state();
            if (value.action === "open" && !value.url) {
              publish();
              return state();
            }
            const action =
              value.action === "navigate" && !tab.service.state().open
                ? "open"
                : value.action;
            const result = await tab.service.request({
              ...value,
              action,
              recipientAgentId:
                value.action === "annotation" ? value.recipientAgentId : id,
            });
            publish();
            return {
              ...state(),
              ...(result.annotation ? { annotation: result.annotation } : {}),
            };
          }
        }
        publish();
        return state();
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
      // Schema discovery is independent of whether a page has been opened.
      const schema = createBrowserTab({
        ...options,
        ownerAgentId: "",
        tabId: "",
        publish: () => {},
      }).tools(context);
      return {
        subscribe(listener) {
          subscribers.add(listener);
          return () => subscribers.delete(listener);
        },
        async list(caller) {
          if (!(await context.authorization.canDiscoverBrowser(caller)))
            return [];
          return [
            ...(await schema.list(caller)),
            {
              name: "browser_tabs",
              description:
                "List only your own browser tabs and active tab. Browser list_pages describes only the active tab's scoped CDP target.",
              inputSchema: shape({}),
            },
            {
              name: "browser_new_tab",
              description:
                "Create and select your own tab; URL must be an explicit local preview URL. Omit URL for a blank tab.",
              inputSchema: shape({ url: { type: "string" } }, []),
            },
            {
              name: "browser_select_tab",
              description:
                "Select one of your own tabs using its stable tab ID.",
              inputSchema: shape({ tabId: { type: "string" } }),
            },
            {
              name: "browser_close_tab",
              description:
                "Close one of your own tabs using its stable tab ID.",
              inputSchema: shape({ tabId: { type: "string" } }),
            },
          ];
        },
        call(caller, name, args) {
          return serial(() =>
            context.runAuthorized(caller, "browser.control", async () => {
              currentCaller(caller);
              const ws = workspace(caller.agentId);
              if (name === "browser_tabs" || name === "browser_status")
                return stateFor(caller.agentId);
              if (name === "browser_new_tab") {
                if (args.url !== undefined && typeof args.url !== "string")
                  throw Error("Invalid tab URL.");
                await newTab(caller.agentId, args.url as string | undefined);
              } else if (name === "browser_select_tab")
                await selectTab(caller.agentId, String(args.tabId));
              else if (name === "browser_close_tab")
                await closeTab(caller.agentId, String(args.tabId));
              else {
                const tab = ws.active ? ws.tabs.get(ws.active) : undefined;
                if (!tab)
                  throw Error(
                    "Create your own browser tab first with browser_new_tab.",
                  );
                if (
                  name === "browser_navigate_page" &&
                  typeof args.url === "string"
                ) {
                  await tab.service.request({
                    projectId: options.projectId,
                    action: tab.service.state().open ? "navigate" : "open",
                    url: args.url,
                    recipientAgentId: caller.agentId,
                  });
                  publish();
                  return stateFor(caller.agentId);
                }
                return tab.service
                  .tools({
                    ...context,
                    runAuthorized: async (_caller, _action, operation) =>
                      operation(),
                  })
                  .call(caller, name, args);
              }
              publish();
              return stateFor(caller.agentId);
            }),
          );
        },
      };
    },
  };
}
