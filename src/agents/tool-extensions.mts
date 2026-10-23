import type { AgentToolExtension } from "./session-host.mjs";
/** Compose independent capability domains without granting access or starting work. */
export function combineAgentToolExtensions(
  extensions: AgentToolExtension[],
): AgentToolExtension {
  return {
    async list(caller) {
      return (
        await Promise.all(extensions.map((extension) => extension.list(caller)))
      ).flat();
    },
    async call(caller, name, args) {
      for (const extension of extensions) {
        if ((await extension.list(caller)).some((tool) => tool.name === name))
          return extension.call(caller, name, args);
      }
      throw Error("This tool is not available to the current agent session.");
    },
    subscribe(listener) {
      const stops = extensions.map((extension) =>
        extension.subscribe?.(listener),
      );
      return () => {
        for (const stop of stops) stop?.();
      };
    },
  };
}
