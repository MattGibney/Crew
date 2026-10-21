import type { ManagerProps } from "../../contracts/manager.js";

import { ArrowUp, Keyboard, Mic, Square } from "lucide-react";
import { Button } from "@/components/ui/button";

import { Textarea } from "@/components/ui/textarea";

import { ApprovalForm } from "../ApprovalForm.js";
import { Message } from "../Message.js";
import { VoiceControls } from "../VoiceControls.js";
import { ManagerCallBar } from "../ManagerCallBar.js";

import type { useManagerComposer } from "./useManagerComposer.js";

export function ManagerComposer({
  manager,
  composer,
}: ManagerProps & { composer: ReturnType<typeof useManagerComposer> }) {
  const { work, prepared, eventReady } = manager;
  const {
    inputMode,
    selectInput,
    draft,
    setDraft,
    inputRef,
    busy,
    ready,
    submit,
  } = composer;
  return (
    <div className="shrink-0 space-y-3 bg-background px-5 pb-4 pt-2 sm:px-7">
      <div className="mx-auto max-w-3xl">
        <form
          id="manager-composer"
          tabIndex={-1}
          aria-label="Message and voice composer"
          onSubmit={submit}
          className="overflow-hidden rounded-xl border bg-background shadow-sm focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20"
        >
          <div className="flex items-center justify-between gap-3 px-3 pt-2">
            <div
              role="tablist"
              aria-label="Input method"
              className="flex gap-1 rounded-lg bg-muted/60 p-0.5"
            >
              {["text", "voice"].map((mode) => (
                <button
                  key={mode}
                  id={`input-tab-${mode}`}
                  type="button"
                  role="tab"
                  aria-selected={inputMode === mode}
                  aria-controls={`input-panel-${mode}`}
                  tabIndex={inputMode === mode ? 0 : -1}
                  onClick={() => selectInput(mode)}
                  onKeyDown={(event) => {
                    if (
                      ["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                        event.key,
                      )
                    ) {
                      event.preventDefault();
                      const next =
                        event.key === "Home"
                          ? "text"
                          : event.key === "End"
                            ? "voice"
                            : mode === "text"
                              ? "voice"
                              : "text";
                      selectInput(next);
                      document.getElementById(`input-tab-${next}`)?.focus();
                    }
                  }}
                  className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring ${inputMode === mode ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {mode === "text" ? (
                    <Keyboard className="size-3.5" aria-hidden="true" />
                  ) : (
                    <Mic className="size-3.5" aria-hidden="true" />
                  )}
                  {mode === "text" ? "Text" : "Voice"}
                </button>
              ))}
            </div>
            {inputMode === "text" &&
              !manager.voice.allocated &&
              !manager.voice.busy && (
                <span className="text-[11px] text-muted-foreground">
                  Message your manager
                </span>
              )}
          </div>
          <div
            id="input-panel-voice"
            role="tabpanel"
            aria-labelledby="input-tab-voice"
            hidden={inputMode !== "voice"}
          >
            <VoiceControls manager={manager} embedded />
            {busy && (
              <div className="px-4 pb-3">
                <Button
                  id="stop-voice-work"
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!work.activeTurnId}
                  onClick={() => void manager.interruptManager()}
                >
                  <Square className="size-3" />
                  Stop current turn
                </Button>
              </div>
            )}
          </div>
          <div
            id="input-panel-text"
            role="tabpanel"
            aria-labelledby="input-tab-text"
            hidden={inputMode !== "text"}
            className="p-2"
          >
            <label htmlFor="message-input" className="sr-only">
              Message your manager
            </label>
            <Textarea
              ref={inputRef}
              id="message-input"
              placeholder="Message your manager…"
              value={draft}
              maxLength={8000}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  if (ready) void submit(event);
                }
              }}
              className="min-h-14 max-h-40 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
            />
            <div className="flex items-center justify-between gap-2 px-1">
              <p className="text-[11px] text-muted-foreground">
                {!manager.managerEnabled
                  ? "Manager is stopped or unavailable. Open Settings to start it. Your draft is kept."
                  : !prepared
                    ? "Preparing your manager…"
                    : !eventReady
                      ? "Waiting for connection…"
                      : busy
                        ? "You can draft your next message while work continues."
                        : "Enter to send · Shift Enter for a new line"}
              </p>
              {busy ? (
                <Button
                  id="stop-work"
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!work.activeTurnId}
                  onClick={() => void manager.interruptManager()}
                >
                  <Square className="size-3" />
                  Stop current turn
                </Button>
              ) : (
                <Button
                  id="send-message"
                  type="submit"
                  size="icon"
                  aria-label="Send message"
                  disabled={!ready || !draft.trim()}
                >
                  <ArrowUp />
                </Button>
              )}
            </div>
          </div>
          {inputMode === "text" &&
            (manager.voice.allocated || manager.voice.busy) && (
              <ManagerCallBar
                manager={manager}
                onManager={() => selectInput("voice")}
              />
            )}
        </form>
      </div>
    </div>
  );
}
