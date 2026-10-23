import type { ManagerProps } from "../../contracts/manager.js";

import { ArrowUp, Keyboard, Mic, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { VoiceControls } from "../VoiceControls.js";
import { ManagerCallBar } from "../ManagerCallBar.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
    <Tabs
      value={inputMode}
      onValueChange={(value) => selectInput(String(value))}
      className="shrink-0 space-y-3 bg-background px-5 pb-4 pt-2 sm:px-7"
    >
      <div className="mx-auto w-full max-w-3xl">
        <form
          id="manager-composer"
          tabIndex={-1}
          aria-label="Message and voice composer"
          onSubmit={submit}
          className="overflow-hidden rounded-xl border bg-background shadow-sm focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20"
        >
          <div className="flex items-center justify-between gap-3 px-3 pt-2">
            <TabsList aria-label="Input method">
              <TabsTrigger value="text">
                <Keyboard className="size-3.5" aria-hidden="true" />
                Text
              </TabsTrigger>
              <TabsTrigger value="voice">
                <Mic className="size-3.5" aria-hidden="true" />
                Voice
              </TabsTrigger>
            </TabsList>
            {inputMode === "text" &&
              !manager.voice.allocated &&
              !manager.voice.busy && (
                <span className="text-[11px] text-muted-foreground">
                  Message your manager
                </span>
              )}
          </div>
          <TabsContent value="voice" keepMounted>
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
          </TabsContent>
          <TabsContent value="text" keepMounted className="p-2">
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
                        ? "Send another message to guide the current work."
                        : "Enter to send · Shift Enter for a new line"}
              </p>
              {work.activeTurnId && (
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
              )}
              <Button
                id="send-message"
                type="submit"
                size="icon"
                aria-label="Send message"
                disabled={!ready || !draft.trim()}
              >
                <ArrowUp />
              </Button>
            </div>
          </TabsContent>
          {inputMode === "text" &&
            (manager.voice.allocated || manager.voice.busy) && (
              <ManagerCallBar
                manager={manager}
                onManager={() => selectInput("voice")}
              />
            )}
        </form>
      </div>
    </Tabs>
  );
}
