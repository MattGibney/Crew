import { useEffect, useRef, useState } from "react";
import {
  projectDraftStorage,
  readDraft,
  writeDraft,
} from "../draft-storage.js";
import { errorText } from "../api.js";
import type { Manager } from "../../contracts/manager.js";

export function useManagerComposer(manager: Manager) {
  const { work, prepared, eventReady, sending } = manager;
  const [inputMode, setInputMode] = useState("voice");
  const selectInput = (next: string) => {
    setInputMode(next);
  };
  const [draft, setDraftState] = useState(() =>
    readDraft(projectDraftStorage()),
  );
  const draftRef = useRef(draft);
  const setDraft = (value: string | ((current: string) => string)) => {
    const next = typeof value === "function" ? value(draftRef.current) : value;
    draftRef.current = next;
    writeDraft(projectDraftStorage(), next);
    setDraftState(next);
  };
  const [sendError, setSendError] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null),
    submitLock = useRef(false);
  useEffect(() => {
    const input = inputRef.current;
    if (inputMode !== "text" || !input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(160, Math.max(56, input.scrollHeight))}px`;
  }, [draft, inputMode]);
  const busy = Boolean(work.activeTurnId) || sending;
  const ready = manager.managerEnabled && prepared && eventReady && !sending;
  const submit = async (event: { preventDefault(): void }) => {
    event.preventDefault();
    const submittedDraft = draft,
      text = submittedDraft.trim();
    if (inputMode !== "text" || !text || !ready || submitLock.current) return;
    submitLock.current = true;
    setSendError("");
    try {
      await manager.sendMessage(text);
      setDraft((current) => (current === submittedDraft ? "" : current));
      inputRef.current?.focus();
    } catch (failure) {
      setSendError(
        errorText(failure) ||
          "Message was not sent. Your text is kept here; try again.",
      );
    } finally {
      submitLock.current = false;
    }
  };
  const selectDraft = (text: string) => {
    setDraft(text);
    selectInput("text");
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  return {
    inputMode,
    selectInput,
    draft,
    setDraft,
    sendError,
    inputRef,
    busy,
    ready,
    submit,
    selectDraft,
  };
}
