import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "../../components/ui/collapsible.js";
import { useState } from "react";
import type { FormEvent } from "react";
import type { ManagerProps } from "../../contracts/manager.js";
import { Button } from "@/components/ui/button";

import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import { PROFILE_PERSONALITY_MAX_LENGTH } from "../profile.js";
import { errorText } from "../api.js";

export function ManagerPersonality({
  manager,
  onNotify,
}: ManagerProps & { onNotify: (message: string) => void }) {
  const profile = manager.settings?.managerProfile;
  const [draft, setDraft] = useState<string | null>(null),
    [baseVersion, setBaseVersion] = useState<string | undefined>(undefined),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const stale = draft !== null && baseVersion !== profile?.version;
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || draft === null || stale) return;
    setSaving(true);
    setError("");
    try {
      await manager.saveManagerProfile({ personality: draft }, baseVersion);
      setDraft(null);
      onNotify(
        "Manager personality saved. Start or restart in Sessions to apply it.",
      );
    } catch (error) {
      setError(errorText(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section
      aria-labelledby="manager-personality-heading"
      className="border-t py-6"
    >
      <form
        onSubmit={save}
        className="grid items-start gap-3 sm:grid-cols-[136px_minmax(0,1fr)_auto] sm:gap-6"
      >
        <h3 id="manager-personality-heading" className="text-sm font-medium">
          Personality
        </h3>
        <div className="min-w-0">
          {draft !== null ? (
            <>
              <Label htmlFor="manager-profile-personality" className="sr-only">
                Manager personality
              </Label>
              <Textarea
                id="manager-profile-personality"
                value={draft}
                maxLength={PROFILE_PERSONALITY_MAX_LENGTH}
                disabled={saving}
                className="min-h-36 resize-y text-sm leading-6"
                placeholder="For example: calm and direct, curious about alternatives, with concise updates."
                onChange={(event) => setDraft(event.target.value)}
              />
              <Collapsible className="mt-3 text-xs leading-6 text-muted-foreground">
                <CollapsibleTrigger className="text-left cursor-pointer font-medium">
                  How personality is used
                </CollapsibleTrigger>
                <CollapsibleContent keepMounted>
                  <p className="mt-2">
                    Describe tone, communication style and preferences. Leave
                    this empty to use your manager instructions alone. Saved
                    personality is added as explicit profile preferences
                    alongside your existing instructions for typed and voice
                    conversations after an explicit Start or Restart in
                    Sessions. It does not replace your instructions, change the
                    selected audio voice or change Codex permissions.
                  </p>
                  <p className="mt-2">
                    Keep task requirements in the conversation. Don’t include
                    passwords, API keys or other secrets.
                  </p>
                </CollapsibleContent>
              </Collapsible>
            </>
          ) : (
            <p className="whitespace-pre-wrap break-words text-sm leading-6 text-muted-foreground">
              {profile?.personality ||
                "No additional personality. Your manager instructions define its style."}
            </p>
          )}
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            Applies to this project after Start or Restart in Sessions.
          </p>
          {stale && (
            <p role="alert" className="mt-2 text-xs text-destructive">
              The saved profile changed while you were editing. Your draft is
              kept; copy it before cancelling to load the latest profile.
            </p>
          )}
          {error && (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          {draft !== null ? (
            <>
              <Button
                type="button"
                variant="link"
                className="h-auto p-0 text-xs text-muted-foreground"
                disabled={saving}
                onClick={() => {
                  setDraft(null);
                  setError("");
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={
                  saving ||
                  stale ||
                  draft === (profile?.personality || "") ||
                  !manager.eventReady
                }
              >
                {saving ? "Saving…" : "Save"}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="link"
              aria-label="Update manager personality"
              className="h-auto p-0 text-sm font-semibold"
              disabled={!profile}
              onClick={() => {
                setDraft(profile?.personality || "");
                setBaseVersion(profile?.version);
                setError("");
              }}
            >
              Update
            </Button>
          )}
        </div>
      </form>
    </section>
  );
}
