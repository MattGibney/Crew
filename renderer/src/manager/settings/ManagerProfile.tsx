import type { ManagerProps } from "../../contracts/manager.js";
import { errorText } from "../api.js";
import { useState } from "react";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";

import { Label } from "@/components/ui/label";

import { NativeSelect } from "@/components/ui/native-select";

import type { NotifyProps } from "./WorkspaceSettings.js";
export function ManagerProfile({
  manager,
  onNotify,
}: ManagerProps & NotifyProps) {
  const profile = manager.settings?.managerProfile;
  const [draft, setDraft] = useState<string | null>(null),
    [editing, setEditing] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const value = draft ?? profile?.voice ?? "";
  const unavailable =
    value && !manager.catalog?.voices.some((item) => item.id === value);
  const voiceName =
    manager.catalog?.voices.find((item) => item.id === profile?.voice)?.name ||
    (profile?.voice
      ? `${profile.voice} · unavailable`
      : `Codex default${manager.catalog?.defaultVoice ? ` · ${manager.catalog?.voices.find((item) => item.id === manager.catalog?.defaultVoice)?.name || manager.catalog.defaultVoice}` : ""}`);
  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await manager.saveManagerProfile(value || null, profile!.version);
      setDraft(null);
      setEditing(false);
      onNotify("Manager voice saved for the next call.");
    } catch (error) {
      setError(errorText(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section
      aria-labelledby="manager-profile-heading"
      className="border-y py-6"
    >
      <div className="grid items-start gap-3 sm:grid-cols-[136px_minmax(0,1fr)_auto] sm:gap-6">
        <div>
          <h3 id="manager-profile-heading" className="text-sm font-medium">
            Voice
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            For the next manager call.
          </p>
        </div>
        <div className="min-w-0">
          {editing ? (
            <>
              <Label htmlFor="manager-profile-voice" className="sr-only">
                Voice
              </Label>
              <NativeSelect
                id="manager-profile-voice"
                className="w-full"
                disabled={
                  !profile || !manager.catalog || manager.voiceLoading || saving
                }
                value={value}
                onChange={(event) => setDraft(event.target.value)}
              >
                <option value="">
                  Codex default
                  {manager.catalog?.defaultVoice
                    ? ` · ${manager.catalog?.voices.find((item) => item.id === manager.catalog?.defaultVoice)?.name || manager.catalog.defaultVoice}`
                    : ""}
                </option>
                {unavailable && (
                  <option value={value}>{value} · unavailable</option>
                )}
                {manager.catalog?.voices.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </NativeSelect>
            </>
          ) : (
            <p className="text-sm leading-6 text-muted-foreground">
              {manager.voiceLoading ? "Loading voices…" : voiceName}
            </p>
          )}
          {manager.voiceNotice && (
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {manager.voiceNotice}
            </p>
          )}
          {!manager.catalog && !manager.voiceLoading && (
            <Button
              variant="link"
              size="sm"
              className="mt-2 h-auto p-0"
              onClick={() => void manager.loadVoices()}
            >
              Reload voices
            </Button>
          )}
          {error && (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          {editing ? (
            <>
              <Button
                variant="link"
                className="h-auto p-0 text-xs text-muted-foreground"
                disabled={saving}
                onClick={() => {
                  setEditing(false);
                  setDraft(null);
                  setError("");
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={
                  !profile ||
                  !manager.catalog ||
                  saving ||
                  value === (profile.voice || "") ||
                  Boolean(unavailable) ||
                  !manager.eventReady
                }
                onClick={() => void save()}
              >
                {saving ? "Saving…" : "Save"}
              </Button>
            </>
          ) : (
            <Button
              variant="link"
              aria-label="Update manager voice"
              className="h-auto p-0 text-sm font-semibold"
              onClick={() => setEditing(true)}
            >
              Update
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
