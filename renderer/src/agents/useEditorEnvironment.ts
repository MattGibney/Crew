import { useCallback, useEffect, useRef, useState } from "react";
import { decodeAgentTemplateSnapshot } from "./AgentEnvironmentTemplate";
import type { AgentTemplateSnapshotView } from "../../../src/application/agent-template-contracts.mjs";

type Command = <T>(name: string, input: unknown) => Promise<T>;
type State = {
  snapshot: AgentTemplateSnapshotView | null;
  selected: string | null;
  changed: boolean;
  loading: boolean;
  loaded: boolean;
  error: string;
};
const empty: State = {
  snapshot: null,
  selected: null,
  changed: false,
  loading: true,
  loaded: false,
  error: "",
};

export function useEditorEnvironment(
  command: Command,
  editorId: string | null,
  agentId: string | null,
) {
  const [state, setState] = useState<State>(empty);
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    const request = ++sequence.current;
    if (!editorId) return;
    setState((current) => ({ ...current, loading: true, error: "" }));
    try {
      const snapshot = decodeAgentTemplateSnapshot(
        await command("environments.templates.snapshot", {}),
      );
      if (request !== sequence.current) return;
      const assignment = snapshot.assignments.find(
        (row) => row.agentId === agentId,
      );
      setState((current) => ({
        ...current,
        snapshot,
        selected: current.changed
          ? current.selected
          : (assignment?.templateId ?? null),
        loading: false,
        loaded: true,
        error: "",
      }));
    } catch {
      if (request === sequence.current)
        setState((current) => ({
          ...current,
          loading: false,
          error:
            "Environment templates could not be loaded. Your other edits are retained.",
        }));
    }
  }, [command, editorId, agentId]);
  useEffect(() => {
    setState(empty);
    void reload();
    return () => {
      sequence.current++;
    };
  }, [reload]);
  const save = async (savedAgentId: string) => {
    if (!state.changed) return;
    if (!state.loaded || !state.snapshot)
      throw new Error("Environment templates are unavailable.");
    const assignment = state.snapshot.assignments.find(
      (row) => row.agentId === savedAgentId,
    );
    const template = state.snapshot.templates.find(
      (row) => row.id === state.selected,
    );
    if (state.selected && !template)
      throw new Error(
        "The selected environment template is unavailable. Reopen the agent and choose again.",
      );
    await command("environments.templates.assign", {
      agentId: savedAgentId,
      expectedRevision: assignment?.revision ?? null,
      templateId: template?.id ?? null,
      templateRevision: template?.revision ?? null,
    });
  };
  return {
    templates: state.snapshot?.templates ?? [],
    templateId: state.selected,
    loading: state.loading,
    loaded: state.loaded,
    error: state.error,
    select: (selected: string | null) =>
      setState((current) => ({ ...current, selected, changed: true })),
    reload: () => {
      void reload();
    },
    save,
  };
}
export type EditorEnvironment = ReturnType<typeof useEditorEnvironment>;
