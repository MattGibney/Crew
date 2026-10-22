import { useState, useRef, useEffect } from "react";
import type { ChangeEvent, FormEvent } from "react";
import type { ManagerProps } from "../../contracts/manager.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { ManagerAvatar } from "../ManagerAvatar.js";
import {
  managerDisplayName,
  readProfilePicture,
  PROFILE_NAME_MAX_LENGTH,
} from "../profile.js";
import { errorText } from "../api.js";

export function ManagerIdentity({
  manager,
  onNotify,
}: ManagerProps & { onNotify: (message: string) => void }) {
  const profile = manager.settings?.managerProfile;
  const [draft, setDraft] = useState<{
      name: string;
      picture: string | null;
    } | null>(null),
    [baseVersion, setBaseVersion] = useState<string | undefined>(undefined),
    [saving, setSaving] = useState(false),
    [reading, setReading] = useState(false),
    [error, setError] = useState("");
  const selection = useRef(0);
  useEffect(
    () => () => {
      selection.current++;
    },
    [],
  );
  const edit = () => {
    setDraft({ name: profile?.name || "", picture: profile?.picture || null });
    setBaseVersion(profile?.version);
    setError("");
  };
  const cancel = () => {
    selection.current++;
    setReading(false);
    setDraft(null);
    setError("");
  };
  const stale = draft !== null && baseVersion !== profile?.version;
  const choosePicture = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const request = ++selection.current;
    setReading(true);
    setError("");
    try {
      const picture = await readProfilePicture(file);
      if (request === selection.current)
        setDraft((current) => current && { ...current, picture });
    } catch (error) {
      if (request === selection.current) setError(errorText(error));
    } finally {
      if (request === selection.current) setReading(false);
    }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft || saving || reading || stale) return;
    setSaving(true);
    setError("");
    try {
      await manager.saveManagerProfile(draft, baseVersion);
      setDraft(null);
      onNotify("Manager name and picture saved.");
    } catch (error) {
      setError(errorText(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section
      aria-labelledby="manager-identity-heading"
      className="border-t py-6"
    >
      <form
        onSubmit={save}
        className="grid items-start gap-3 sm:grid-cols-[136px_minmax(0,1fr)_auto] sm:gap-6"
      >
        <h3 id="manager-identity-heading" className="text-sm font-medium">
          Name and picture
        </h3>
        <div className="min-w-0">
          {draft ? (
            <div className="space-y-4">
              <div>
                <Label htmlFor="manager-profile-name" className="sr-only">
                  Manager name
                </Label>
                <Input
                  id="manager-profile-name"
                  value={draft.name}
                  maxLength={PROFILE_NAME_MAX_LENGTH}
                  placeholder="Manager"
                  disabled={saving}
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value })
                  }
                />
                <p className="mt-2 text-xs text-muted-foreground">
                  Leave the name empty to use Manager.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <ManagerAvatar profile={draft} className="size-12" />
                <Label
                  htmlFor="manager-profile-picture"
                  className="cursor-pointer text-xs text-primary"
                >
                  Choose picture
                </Label>
                <input
                  id="manager-profile-picture"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="max-w-full text-xs"
                  aria-label="Manager picture"
                  disabled={saving || reading}
                  onChange={(event) => void choosePicture(event)}
                />
                {draft.picture && (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    disabled={saving}
                    onClick={() => {
                      selection.current++;
                      setReading(false);
                      setDraft({ ...draft, picture: null });
                    }}
                  >
                    Remove picture
                  </Button>
                )}
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                PNG, JPEG or WebP, up to 512 KB and 2048 × 2048 pixels. The
                picture stays in this project on this Mac.
              </p>
              {reading && (
                <p role="status" className="text-xs text-muted-foreground">
                  Checking picture…
                </p>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <ManagerAvatar profile={profile} className="size-10" />
              <p className="min-w-0 break-words text-sm leading-6">
                {managerDisplayName(profile)}{" "}
                <span className="text-xs text-muted-foreground">
                  · AI manager
                </span>
              </p>
            </div>
          )}
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            Name and picture update here and in your conversation immediately.
            Start or restart the manager in Sessions to apply the name to its
            instructions and default greeting. The audio voice stays unchanged.
          </p>
          {stale && (
            <p role="alert" className="mt-2 text-xs text-destructive">
              The saved profile changed while you were editing. Your draft is
              kept; copy your name before cancelling to load the latest profile.
            </p>
          )}
          {error && (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          {draft ? (
            <>
              <Button
                type="button"
                variant="link"
                className="h-auto p-0 text-xs text-muted-foreground"
                disabled={saving}
                onClick={cancel}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={saving || reading || stale || !manager.eventReady}
              >
                {saving ? "Saving…" : "Save"}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="link"
              aria-label="Update manager name and picture"
              className="h-auto p-0 text-sm font-semibold"
              disabled={!profile}
              onClick={edit}
            >
              Update
            </Button>
          )}
        </div>
      </form>
    </section>
  );
}
