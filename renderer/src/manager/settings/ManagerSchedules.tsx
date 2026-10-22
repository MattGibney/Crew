import { useEffect, useState } from "react";
import type { ManagerProps, ManagerSchedule } from "../../contracts/manager.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { errorText } from "../api.js";
const stamp = (at?: number) => (at ? new Date(at).toLocaleString() : "Not yet");
export function ManagerSchedules({
  manager,
  onNotify,
  visible,
}: {
  manager: ManagerProps["manager"];
  onNotify: (message: string) => void;
  visible: boolean;
}) {
  const saved = manager.settings?.managerSchedules;
  const [draft, setDraft] = useState<ManagerSchedule[] | null>(null),
    [revision, setRevision] = useState<string | null>(null),
    [editing, setEditing] = useState<string | null>(null),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(
      () => void manager.loadSettings().catch(() => {}),
      10000,
    );
    return () => clearInterval(timer);
  }, [visible, manager.loadSettings]);
  const entries = draft ?? saved?.schedules ?? [];
  const stale = draft !== null && revision !== saved?.revision;
  const update = (id: string, patch: Partial<ManagerSchedule>) => {
    setRevision(revision ?? saved?.revision ?? null);
    setDraft(entries.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };
  const add = () => {
    setRevision(revision ?? saved?.revision ?? null);
    const id = crypto.randomUUID();
    setDraft([
      ...entries,
      {
        id,
        name: "New schedule",
        instruction: "",
        enabled: false,
        timing: { kind: "interval", minutes: 10 },
      },
    ]);
    setEditing(id);
  };
  const save = async () => {
    if (!draft || !revision || saving || stale) return;
    setSaving(true);
    setError("");
    try {
      await manager.saveManagerSchedules(draft, revision);
      setDraft(null);
      setRevision(null);
      onNotify("Manager schedules saved.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="space-y-6">
      <p className="text-sm leading-6 text-muted-foreground">
        Schedules run only while the manager is running and available. Calls,
        active work and restart preparation defer them. Missed times do not
        build a queue. Routine scheduled activity stays out of your
        conversation; meaningful questions and findings appear through
        attention.
      </p>
      {!saved && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading manager schedules…
        </p>
      )}
      {entries.map((schedule) => (
        <section
          key={schedule.id}
          className="border-t py-5"
          aria-label={schedule.name}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="font-medium">{schedule.name}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {schedule.enabled ? "Enabled" : "Disabled"} ·{" "}
                {schedule.timing.kind === "interval"
                  ? `Every ${schedule.timing.minutes} minutes`
                  : `Daily at ${schedule.timing.time} (${schedule.timing.timeZone})`}
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() =>
                setEditing(editing === schedule.id ? null : schedule.id)
              }
            >
              {editing === schedule.id ? "Close" : "Edit"}
            </Button>
          </div>
          <div className="mt-3 text-xs leading-6 text-muted-foreground">
            <p>
              Last submitted: {stamp(schedule.run?.lastAt)} · Next check:{" "}
              {schedule.enabled ? stamp(schedule.run?.nextAt) : "Disabled"}
            </p>
            <p>Status: {schedule.run?.status || "Waiting"}</p>
            {schedule.run?.error && (
              <p role="alert" className="text-destructive">
                {schedule.run.error}
              </p>
            )}
          </div>
          {editing === schedule.id && (
            <div className="mt-5 space-y-4">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id={`enabled-${schedule.id}`}
                  checked={schedule.enabled}
                  onChange={(event) =>
                    update(schedule.id, { enabled: event.target.checked })
                  }
                />
                <Label htmlFor={`enabled-${schedule.id}`}>Enabled</Label>
              </div>
              <div className="space-y-2">
                <Label htmlFor={`name-${schedule.id}`}>Name</Label>
                <Input
                  id={`name-${schedule.id}`}
                  maxLength={80}
                  value={schedule.name}
                  onChange={(e) =>
                    update(schedule.id, { name: e.target.value })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`instruction-${schedule.id}`}>
                  Instruction
                </Label>
                <Textarea
                  id={`instruction-${schedule.id}`}
                  maxLength={16000}
                  rows={5}
                  value={schedule.instruction}
                  onChange={(e) =>
                    update(schedule.id, { instruction: e.target.value })
                  }
                />
                {schedule.builtin && (
                  <p className="text-xs text-muted-foreground">
                    This built-in review runs only when saved explicit
                    commitments have new or due evidence. Other schedules run
                    your instruction at each eligible time.
                  </p>
                )}
              </div>
              <fieldset className="space-y-3">
                <legend className="mb-2 text-sm font-medium">When</legend>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name={`timing-${schedule.id}`}
                      checked={schedule.timing.kind === "interval"}
                      onChange={() =>
                        update(schedule.id, {
                          timing: { kind: "interval", minutes: 10 },
                        })
                      }
                    />
                    Interval
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name={`timing-${schedule.id}`}
                      checked={schedule.timing.kind === "daily"}
                      onChange={() =>
                        update(schedule.id, {
                          timing: {
                            kind: "daily",
                            time: "09:00",
                            timeZone:
                              Intl.DateTimeFormat().resolvedOptions().timeZone,
                          },
                        })
                      }
                    />
                    Daily
                  </label>
                </div>
                {schedule.timing.kind === "interval" ? (
                  <div className="space-y-2">
                    <Label htmlFor={`minutes-${schedule.id}`}>
                      Interval in minutes
                    </Label>
                    <Input
                      id={`minutes-${schedule.id}`}
                      type="number"
                      min={1}
                      max={10080}
                      value={schedule.timing.minutes}
                      onChange={(e) =>
                        update(schedule.id, {
                          timing: {
                            kind: "interval",
                            minutes: Number(e.target.value),
                          },
                        })
                      }
                    />
                  </div>
                ) : (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor={`time-${schedule.id}`}>Local time</Label>
                      <Input
                        id={`time-${schedule.id}`}
                        type="time"
                        value={schedule.timing.time}
                        onChange={(e) =>
                          update(schedule.id, {
                            timing: {
                              ...(schedule.timing as {
                                kind: "daily";
                                time: string;
                                timeZone: string;
                              }),
                              time: e.target.value,
                            },
                          })
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor={`zone-${schedule.id}`}>Time zone</Label>
                      <Input
                        id={`zone-${schedule.id}`}
                        value={schedule.timing.timeZone}
                        placeholder="Europe/London"
                        onChange={(e) =>
                          update(schedule.id, {
                            timing: {
                              ...(schedule.timing as {
                                kind: "daily";
                                time: string;
                                timeZone: string;
                              }),
                              timeZone: e.target.value,
                            },
                          })
                        }
                      />
                    </div>
                  </div>
                )}
              </fieldset>
              <Button
                variant="outline"
                disabled={saving}
                onClick={() => {
                  setRevision(revision ?? saved?.revision ?? null);
                  setDraft(entries.filter((s) => s.id !== schedule.id));
                  setEditing(null);
                }}
              >
                Delete schedule
              </Button>
            </div>
          )}
        </section>
      ))}
      {stale && (
        <p role="alert" className="text-sm text-destructive">
          Schedules changed elsewhere. Cancel your edits and reload before
          saving.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={!saved || saving || entries.length >= 30}
          onClick={add}
        >
          Add schedule
        </Button>
        <Button
          disabled={!draft || saving || stale}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save schedules"}
        </Button>
        {draft && (
          <Button
            variant="ghost"
            disabled={saving}
            onClick={() => {
              setDraft(null);
              setRevision(null);
              setError("");
            }}
          >
            Cancel edits
          </Button>
        )}
      </div>
    </div>
  );
}
