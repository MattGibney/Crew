import { useEffect, useRef, useState } from 'react';
import { Archive, Check, ChevronDown, CircleHelp, LoaderCircle, Play, RotateCcw, Save, Square, Radio, UserRound, Users, SlidersHorizontal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { ManagerAvatar } from './ManagerAvatar.jsx';
import { managerDisplayName, readProfilePicture, PROFILE_NAME_MAX_LENGTH, PROFILE_PERSONALITY_MAX_LENGTH } from './profile.js';
import { Alert, AlertDescription } from '@/components/ui/alert';

import { archiveTime } from '../../../worker-archive.mjs';
import { archivedWorkers } from './worker-model.js';
import { api } from './api.js';

function ArchivedWorkers({ manager }) {
  const [confirmation, setConfirmation] = useState(null);
  const [busy, setBusy] = useState(null), [error, setError] = useState('');
  const retry = useRef(null);
  const projectId = manager.settings?.projectId || manager.projectInfo?.id;
  const tasks = archivedWorkers(manager.orchestration.tasks || [], projectId, manager.projectInfo?.mode);
  const act = async (task, action, selection) => {
    const request = selection || (retry.current?.taskId === task.id && retry.current?.action === action && retry.current?.expectedRevision === task.revision ? retry.current : { taskId: task.id, action, expectedRevision: task.revision, operationId: `archive-${crypto.randomUUID()}` });
    retry.current = request; setBusy(task.id); setError('');
    try { await api('archived-worker-action', request); retry.current = null; setConfirmation(null); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(null); }
  };
  return <section aria-label="Archived worker list" className="border-t">
    {(error || manager.orchestration.error) && <p role="alert" className="py-4 text-sm text-destructive">{error || manager.orchestration.error}</p>}
    {tasks.length ? <div className="overflow-x-auto"><table className="w-full text-left text-sm">
      <thead><tr className="border-b text-xs text-muted-foreground"><th scope="col" className="py-3 pr-4 font-medium">Worker</th><th scope="col" className="py-3 pr-4 font-medium">Status</th><th scope="col" className="py-3 pr-4 font-medium">Archived</th><th scope="col" className="py-3 text-right font-medium">Actions</th></tr></thead>
      <tbody>{tasks.map(task => { const at = archiveTime(task); return <tr key={task.id} data-archived-worker-id={task.id} className="border-b align-top">
        <td className="py-4 pr-4"><p className="text-xs text-muted-foreground">{task.ticket || task.id}</p><p className="mt-1 font-medium">{task.brief?.trim().split('\n')[0] || 'Worker task'}</p></td>
        <td className="py-4 pr-4 text-muted-foreground">Archived</td>
        <td className="py-4 pr-4 text-xs text-muted-foreground">{at ? <time dateTime={at}>{new Date(at).toLocaleString()}</time> : 'Time unavailable'}</td>
        <td className="py-4 text-right"><div className="flex justify-end gap-2"><Button variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => void act(task, 'restore')}>Restore</Button><Button variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => { setError(''); setConfirmation({ taskId: task.id, action: 'delete', expectedRevision: task.revision, operationId: `archive-${crypto.randomUUID()}` }); }}>Delete permanently</Button></div>
          {confirmation?.taskId === task.id && <div className="mt-3 max-w-sm rounded-lg border p-3 text-left text-xs"><p>Permanently delete this worker’s saved Crew history, results, notes and execution evidence? This cannot be undone.</p><div className="mt-3 flex gap-2"><Button variant="destructive" size="sm" disabled={Boolean(busy)} onClick={() => void act(task, 'delete', confirmation)}>{busy === task.id ? 'Deleting…' : 'Delete permanently'}</Button><Button variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => setConfirmation(null)}>Cancel</Button></div></div>}
        </td>
      </tr>; })}</tbody>
    </table></div> : <p className="py-8 text-sm text-muted-foreground">{projectId ? 'No archived workers for this project.' : 'Loading project archive…'}</p>}
  </section>;
}

function SettingsToast({ message, onDismiss }) {
  const [paused, setPaused] = useState(false);
  const dismissRef = useRef(onDismiss); dismissRef.current = onDismiss;
  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(() => dismissRef.current(), 5000);
    return () => clearTimeout(timer);
  }, [paused]);
  return <div role="region" aria-label="Notifications" className="fixed bottom-5 right-5 z-50 flex w-[min(24rem,calc(100vw-2.5rem))] items-start gap-3 rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg" onPointerEnter={() => setPaused(true)} onPointerLeave={() => setPaused(false)} onFocusCapture={() => setPaused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false); }}>
    <div role="status" aria-live="polite" aria-atomic="true" className="flex min-w-0 flex-1 items-start gap-2.5"><Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" /><p className="text-sm leading-5">{message}</p></div>
    <Button type="button" variant="ghost" size="icon-sm" className="-mr-1 -mt-1 shrink-0" aria-label="Dismiss notification" onClick={onDismiss}><X aria-hidden="true" /></Button>
  </div>;
}

function useWorkspaceSettings() {
  const bridge = window.crewWorkspaces;
  const [snapshot, setSnapshot] = useState(null), [error, setError] = useState('');
  useEffect(() => {
    if (!bridge) return;
    let alive = true, changed = false;
    const unsubscribe = bridge.subscribe(value => { changed = true; if (alive) setSnapshot(value); });
    bridge.snapshot().then(value => { if (alive && !changed) setSnapshot(value); }).catch(error => { if (alive) setError(error.message); });
    return () => { alive = false; unsubscribe(); };
  }, [bridge]);
  return { bridge, snapshot, setSnapshot, error };
}

function ProjectGeneral({ workspace, onNotify }) {
  const { bridge, snapshot } = workspace;
  const selected = snapshot?.projects.find(project => project.id === snapshot.selectedId);
  const [draft, setDraft] = useState(null), [editing, setEditing] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const value = draft ?? selected?.name ?? '';
  const save = async event => {
    event.preventDefault();
    const name = value.trim();
    if (!selected || !name || saving) return;
    setSaving(true); setError('');
    try { await bridge.rename({ id: selected.id, name }); setDraft(null); setEditing(false); onNotify('Project name saved.'); }
    catch (error) { setError(error.message || 'Could not save the project name.'); }
    finally { setSaving(false); }
  };
  return <section aria-labelledby="project-name-heading" className="border-y py-6">
    <form onSubmit={save} className="grid items-start gap-3 sm:grid-cols-[136px_minmax(0,1fr)_auto] sm:gap-6">
      <h3 id="project-name-heading" className="text-sm font-medium">Project name</h3>
      <div className="min-w-0">{editing ? <><Label htmlFor="settings-project-name" className="sr-only">Project name</Label><Input id="settings-project-name" maxLength={100} required value={value} disabled={saving} onChange={event => setDraft(event.target.value)} /></> : <p className="break-words text-sm leading-6 text-muted-foreground">{selected?.name || (!bridge ? 'Available in the Crew desktop app' : 'Loading…')}</p>}<p className="mt-2 text-xs leading-5 text-muted-foreground">The name shown in Crew. Renaming keeps your project folder, conversation and work unchanged.</p>{(error || workspace.error) && <p role="alert" className="mt-2 text-xs text-destructive">{error || workspace.error}</p>}</div>
      <div className="flex items-center gap-3">{editing ? <><Button type="button" variant="link" className="h-auto p-0 text-xs text-muted-foreground" disabled={saving} onClick={() => { setDraft(null); setEditing(false); setError(''); }}>Cancel</Button><Button type="submit" size="sm" disabled={saving || !value.trim() || value.trim() === selected?.name}>{saving ? 'Saving…' : 'Save'}</Button></> : <Button type="button" variant="link" aria-label="Update project name" className="h-auto p-0 text-sm font-semibold" disabled={!selected} onClick={() => setEditing(true)}>Update</Button>}</div>
    </form>
  </section>;
}

function GlobalSettings({ workspace, onNotify }) {
  const { bridge, snapshot, setSnapshot } = workspace;
  const [draft, setDraft] = useState(null), [editing, setEditing] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const save = async event => {
    event.preventDefault();
    const value = Number(draft ?? snapshot?.workerLimit);
    if (!Number.isInteger(value) || value < 1 || value > 64) { setError('Choose a whole number from 1 to 64.'); return; }
    setSaving(true); setError('');
    try { await bridge.setWorkerLimit(value); setSnapshot(await bridge.snapshot()); setDraft(null); setEditing(false); onNotify('Shared worker limit saved for all projects.'); }
    catch (error) { setError(error.message || 'Could not save the shared worker limit.'); }
    finally { setSaving(false); }
  };
  return <section aria-labelledby="global-capacity-heading" className="border-y py-6">
    <form onSubmit={save} className="grid items-start gap-3 sm:grid-cols-[136px_minmax(0,1fr)_auto] sm:gap-6">
      <div><h3 id="global-capacity-heading" className="text-sm font-medium">Worker limit</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">Shared across all projects.</p></div>
      <div className="min-w-0">{editing ? <><Label htmlFor="global-worker-limit" className="sr-only">Workers across all projects</Label><Input id="global-worker-limit" type="number" min={1} max={64} step={1} required value={draft ?? snapshot?.workerLimit ?? ''} disabled={saving || !snapshot} onChange={event => setDraft(event.target.value)} /></> : <p className="text-sm leading-6 text-muted-foreground">{!bridge ? 'Available in the Crew desktop app' : snapshot ? snapshot.workerLimit == null ? 'Unavailable' : `${snapshot.workerLimit} concurrent workers` : 'Loading…'}</p>}<p className="mt-2 text-xs leading-5 text-muted-foreground">One shared limit for this Mac. Running workers continue; waiting work starts as capacity becomes available.</p>{error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}</div>
      <div className="flex items-center gap-3">{editing ? <><Button type="button" variant="link" className="h-auto p-0 text-xs text-muted-foreground" disabled={saving} onClick={() => { setDraft(null); setEditing(false); setError(''); }}>Cancel</Button><Button type="submit" size="sm" disabled={saving || !snapshot || draft === null || Number(draft) === snapshot.workerLimit}>{saving ? 'Saving…' : 'Save'}</Button></> : <Button type="button" variant="link" aria-label="Update shared worker limit" className="h-auto p-0 text-sm font-semibold" disabled={!bridge || !snapshot} onClick={() => setEditing(true)}>Update</Button>}</div>
    </form>
  </section>;
}

function ManagerIdentity({ manager, onNotify }) {
  const profile = manager.settings?.managerProfile;
  const [draft, setDraft] = useState(null), [baseVersion, setBaseVersion] = useState(null), [saving, setSaving] = useState(false), [reading, setReading] = useState(false), [error, setError] = useState('');
  const selection = useRef(0);
  useEffect(() => () => { selection.current++; }, []);
  const edit = () => { setDraft({ name: profile?.name || '', picture: profile?.picture || null }); setBaseVersion(profile?.version); setError(''); };
  const cancel = () => { selection.current++; setReading(false); setDraft(null); setError(''); };
  const stale = draft && baseVersion !== profile?.version;
  const choosePicture = async event => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    const request = ++selection.current; setReading(true); setError('');
    try { const picture = await readProfilePicture(file); if (request === selection.current) setDraft(current => current && { ...current, picture }); }
    catch (error) { if (request === selection.current) setError(error.message); }
    finally { if (request === selection.current) setReading(false); }
  };
  const save = async event => {
    event.preventDefault();
    if (!draft || saving || reading || stale) return;
    setSaving(true); setError('');
    try { await manager.saveManagerProfile(draft, baseVersion); setDraft(null); onNotify('Manager name and picture saved.'); }
    catch (error) { setError(error.message); }
    finally { setSaving(false); }
  };
  return <section aria-labelledby="manager-identity-heading" className="border-t py-6">
    <form onSubmit={save} className="grid items-start gap-3 sm:grid-cols-[136px_minmax(0,1fr)_auto] sm:gap-6">
      <h3 id="manager-identity-heading" className="text-sm font-medium">Name and picture</h3>
      <div className="min-w-0">
        {draft ? <div className="space-y-4"><div><Label htmlFor="manager-profile-name" className="sr-only">Manager name</Label><Input id="manager-profile-name" value={draft.name} maxLength={PROFILE_NAME_MAX_LENGTH} placeholder="Manager" disabled={saving} onChange={event => setDraft({ ...draft, name: event.target.value })} /><p className="mt-2 text-xs text-muted-foreground">Leave the name empty to use Manager.</p></div><div className="flex flex-wrap items-center gap-3"><ManagerAvatar profile={draft} className="size-12" /><Label htmlFor="manager-profile-picture" className="cursor-pointer text-xs text-primary">Choose picture</Label><input id="manager-profile-picture" type="file" accept="image/png,image/jpeg,image/webp" className="max-w-full text-xs" aria-label="Manager picture" disabled={saving || reading} onChange={event => void choosePicture(event)} />{draft.picture && <Button type="button" variant="link" size="sm" disabled={saving} onClick={() => { selection.current++; setReading(false); setDraft({ ...draft, picture: null }); }}>Remove picture</Button>}</div><p className="text-xs leading-5 text-muted-foreground">PNG, JPEG or WebP, up to 512 KB and 2048 × 2048 pixels. The picture stays in this project on this Mac.</p>{reading && <p role="status" className="text-xs text-muted-foreground">Checking picture…</p>}</div> : <div className="flex items-center gap-3"><ManagerAvatar profile={profile} className="size-10" /><p className="min-w-0 break-words text-sm leading-6">{managerDisplayName(profile)} <span className="text-xs text-muted-foreground">· AI manager</span></p></div>}
        <p className="mt-3 text-xs leading-5 text-muted-foreground">Name and picture update here and in your conversation immediately. Start or restart the manager in Sessions to apply the name to its instructions and default greeting. The audio voice stays unchanged.</p>
        {stale && <p role="alert" className="mt-2 text-xs text-destructive">The saved profile changed while you were editing. Your draft is kept; copy your name before cancelling to load the latest profile.</p>}
        {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
      </div>
      <div className="flex items-center gap-3">{draft ? <><Button type="button" variant="link" className="h-auto p-0 text-xs text-muted-foreground" disabled={saving} onClick={cancel}>Cancel</Button><Button type="submit" size="sm" disabled={saving || reading || stale || !manager.eventReady}>{saving ? 'Saving…' : 'Save'}</Button></> : <Button type="button" variant="link" aria-label="Update manager name and picture" className="h-auto p-0 text-sm font-semibold" disabled={!profile} onClick={edit}>Update</Button>}</div>
    </form>
  </section>;
}

function ManagerPersonality({ manager, onNotify }) {
  const profile = manager.settings?.managerProfile;
  const [draft, setDraft] = useState(null), [baseVersion, setBaseVersion] = useState(null), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const stale = draft !== null && baseVersion !== profile?.version;
  const save = async event => {
    event.preventDefault(); if (saving || draft === null || stale) return;
    setSaving(true); setError('');
    try { await manager.saveManagerProfile({ personality: draft }, baseVersion); setDraft(null); onNotify('Manager personality saved. Start or restart in Sessions to apply it.'); }
    catch (error) { setError(error.message); }
    finally { setSaving(false); }
  };
  return <section aria-labelledby="manager-personality-heading" className="border-t py-6"><form onSubmit={save} className="grid items-start gap-3 sm:grid-cols-[136px_minmax(0,1fr)_auto] sm:gap-6">
    <h3 id="manager-personality-heading" className="text-sm font-medium">Personality</h3>
    <div className="min-w-0">{draft !== null ? <><Label htmlFor="manager-profile-personality" className="sr-only">Manager personality</Label><Textarea id="manager-profile-personality" value={draft} maxLength={PROFILE_PERSONALITY_MAX_LENGTH} disabled={saving} className="min-h-36 resize-y text-sm leading-6" placeholder="For example: calm and direct, curious about alternatives, with concise updates." onChange={event => setDraft(event.target.value)} /><details className="mt-3 text-xs leading-6 text-muted-foreground"><summary className="cursor-pointer font-medium">How personality is used</summary><p className="mt-2">Describe tone, communication style and preferences. Leave this empty to use your manager instructions alone. Saved personality is added as explicit profile preferences alongside your existing instructions for typed and voice conversations after an explicit Start or Restart in Sessions. It does not replace your instructions, change the selected audio voice or change Codex permissions.</p><p className="mt-2">Keep task requirements in the conversation. Don’t include passwords, API keys or other secrets.</p></details></> : <p className="whitespace-pre-wrap break-words text-sm leading-6 text-muted-foreground">{profile?.personality || 'No additional personality. Your manager instructions define its style.'}</p>}
    <p className="mt-3 text-xs leading-5 text-muted-foreground">Applies to this project after Start or Restart in Sessions.</p>
    {stale && <p role="alert" className="mt-2 text-xs text-destructive">The saved profile changed while you were editing. Your draft is kept; copy it before cancelling to load the latest profile.</p>}{error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}</div>
    <div className="flex items-center gap-3">{draft !== null ? <><Button type="button" variant="link" className="h-auto p-0 text-xs text-muted-foreground" disabled={saving} onClick={() => { setDraft(null); setError(''); }}>Cancel</Button><Button type="submit" size="sm" disabled={saving || stale || draft === (profile?.personality || '') || !manager.eventReady}>{saving ? 'Saving…' : 'Save'}</Button></> : <Button type="button" variant="link" aria-label="Update manager personality" className="h-auto p-0 text-sm font-semibold" disabled={!profile} onClick={() => { setDraft(profile.personality || ''); setBaseVersion(profile.version); setError(''); }}>Update</Button>}</div>
  </form></section>;
}

function ManagerProfile({ manager, onNotify }) {
  const profile = manager.settings?.managerProfile;
  const [draft, setDraft] = useState(null), [editing, setEditing] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const value = draft ?? profile?.voice ?? '';
  const unavailable = value && !manager.catalog?.voices.some(item => item.id === value);
  const voiceName = manager.catalog?.voices.find(item => item.id === profile?.voice)?.name || (profile?.voice ? `${profile.voice} · unavailable` : `Codex default${manager.catalog?.defaultVoice ? ` · ${manager.catalog.voices.find(item => item.id === manager.catalog.defaultVoice)?.name || manager.catalog.defaultVoice}` : ''}`);
  const save = async () => { setSaving(true); setError(''); try { await manager.saveManagerProfile(value || null, profile.version); setDraft(null); setEditing(false); onNotify('Manager voice saved for the next call.'); } catch (error) { setError(error.message); } finally { setSaving(false); } };
  return <section aria-labelledby="manager-profile-heading" className="border-y py-6">
    <div className="grid items-start gap-3 sm:grid-cols-[136px_minmax(0,1fr)_auto] sm:gap-6">
      <div><h3 id="manager-profile-heading" className="text-sm font-medium">Voice</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">For the next manager call.</p></div>
      <div className="min-w-0">{editing ? <><Label htmlFor="manager-profile-voice" className="sr-only">Voice</Label><NativeSelect id="manager-profile-voice" className="w-full" disabled={!profile || !manager.catalog || manager.voiceLoading || saving} value={value} onChange={event => setDraft(event.target.value)}><option value="">Codex default{manager.catalog?.defaultVoice ? ` · ${manager.catalog.voices.find(item => item.id === manager.catalog.defaultVoice)?.name || manager.catalog.defaultVoice}` : ''}</option>{unavailable && <option value={value}>{value} · unavailable</option>}{manager.catalog?.voices.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</NativeSelect></> : <p className="text-sm leading-6 text-muted-foreground">{manager.voiceLoading ? 'Loading voices…' : voiceName}</p>}
      {manager.voiceNotice && <p className="mt-2 text-xs leading-5 text-muted-foreground">{manager.voiceNotice}</p>}{!manager.catalog && !manager.voiceLoading && <Button variant="link" size="sm" className="mt-2 h-auto p-0" onClick={() => void manager.loadVoices()}>Reload voices</Button>}{error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}</div>
      <div className="flex items-center gap-3">{editing ? <><Button variant="link" className="h-auto p-0 text-xs text-muted-foreground" disabled={saving} onClick={() => { setEditing(false); setDraft(null); setError(''); }}>Cancel</Button><Button size="sm" disabled={!profile || !manager.catalog || saving || value === (profile.voice || '') || Boolean(unavailable) || !manager.eventReady} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</Button></> : <Button variant="link" aria-label="Update manager voice" className="h-auto p-0 text-sm font-semibold" onClick={() => setEditing(true)}>Update</Button>}</div>
    </div>
  </section>;
}

export function ManagerLifecycle({ manager }) {
  const { state, error, activeVersion } = manager.managerLifecycle;
  const [failure, setFailure] = useState('');
  const transitioning = ['loading', 'starting', 'stopping', 'restarting'].includes(state);
  const act = async action => { setFailure(''); try { await manager.changeManagerLifecycle(action); } catch (error) { setFailure(error.message); } };
  const names = { loading: 'Checking manager…', running: activeVersion ? 'Running' : 'Not connected', stopped: 'Stopped', starting: 'Starting…', stopping: 'Stopping…', restarting: 'Restarting…', error: 'Needs attention' };
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2"><Badge variant={state === 'running' ? 'secondary' : 'outline'}>{transitioning && <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />}{names[state] || state}</Badge></div>
      <div className="flex flex-wrap gap-2">
        <Button id="start-manager" variant="outline" disabled={transitioning || state === 'running' || !manager.eventReady} onClick={() => void act('start')}><Play aria-hidden="true" />Start manager</Button>
        <Button id="stop-manager" variant="outline" disabled={transitioning || state === 'stopped' || !manager.eventReady} onClick={() => void act('stop')}><Square aria-hidden="true" />Stop manager</Button>
        <Button id="restart-manager" disabled={transitioning || !manager.eventReady} onClick={() => void act('restart')}><RotateCcw aria-hidden="true" />Restart manager</Button>
      </div>
    </div>
    <p className="text-xs leading-5 text-muted-foreground">Stop ends manager work and voice. Your saved conversation, project tasks and independent workers are preserved. Start never connects voice or starts a task.</p>
    {transitioning && <p role="status" className="text-xs text-muted-foreground">{state === 'stopping' || state === 'restarting' ? 'Releasing voice and waiting for manager work to stop…' : 'Waiting for the controller to confirm the manager state…'}</p>}
    {(failure || error) && <Alert variant="destructive" role="alert"><AlertDescription>{failure || error}</AlertDescription></Alert>}
  </div>;
}

function PromptEditor({ role, data, manager, onNotify }) {
  const [draft, setDraft] = useState(null), [editing, setEditing] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const [baseVersion, setBaseVersion] = useState(null);
  const text = draft ?? data.saved.text;
  const draftRef = useRef(text); draftRef.current = text;
  const dirty = draft !== null && draft !== data.saved.text;
  const stale = dirty && baseVersion !== data.saved.version;
  const managerRole = role === 'manager';
  useEffect(() => {
    if (!dirty) return;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const edit = value => { if (draft === null) setBaseVersion(data.saved.version); setDraft(value); setError(''); };
  const cancel = () => { setEditing(false); setDraft(null); setBaseVersion(null); setError(''); onNotify('Unsaved changes discarded.'); };
  const save = async () => {
    if (!dirty || saving) return;
    const submitted = text;
    setSaving(true); setError('');
    try {
      const saved = await manager.savePrompt(role, submitted, baseVersion);
      if (draftRef.current === submitted) { setDraft(null); setBaseVersion(null); setEditing(false); }
      else setBaseVersion(saved[role].saved.version);
      onNotify(draftRef.current !== submitted ? 'Instructions saved. Your newer edits are still unsaved.' : managerRole ? 'Instructions saved.' : 'Worker instructions saved for new workers.');
    } catch (error) { setError(error.message); }
    finally { setSaving(false); }
  };
  return <section aria-labelledby={`${role}-instructions-heading`} className="pt-2">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 id={`${role}-instructions-heading`} className="font-semibold tracking-tight">{managerRole ? 'Manager instructions' : 'Worker instructions'}</h2><p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">{managerRole ? 'Set how your manager communicates, plans work and helps you make decisions.' : 'Set how workers approach agreed tasks and report their findings.'}</p></div>
      <div className="flex items-center gap-3">{dirty && <Badge variant="secondary">Unsaved changes</Badge>}{!editing && <Button variant="link" className="h-auto p-0 text-sm font-semibold" aria-label={`Update ${role} instructions`} onClick={() => setEditing(true)}>Update</Button>}</div>
    </div>
    {managerRole && data.pendingRestart && <Alert role="status" className="mt-4"><AlertDescription>{manager.managerLifecycle.state === 'stopped' ? 'Start' : 'Restart'} your manager in Sessions to apply the saved manager instructions and profile.</AlertDescription></Alert>}
    {editing ? <><Label htmlFor={`${role}-prompt`} className="sr-only">{managerRole ? 'Manager' : 'Worker'} prompt</Label>
    <Textarea id={`${role}-prompt`} value={text} onChange={event => edit(event.target.value)} aria-describedby={`${role}-prompt-hint`} className="mt-6 min-h-64 resize-y font-mono text-xs leading-6" spellCheck={false} /></> : <div className="mt-6 border-y py-6"><p className="line-clamp-5 whitespace-pre-wrap text-sm leading-7 text-muted-foreground">{data.saved.text}</p></div>}
    {editing && <p id={`${role}-prompt-hint`} className="mt-2 text-xs leading-5 text-muted-foreground">Applies only to this project. Don’t include passwords, API keys or other secrets.</p>}
    <details className="group mt-5">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-2 rounded text-xs font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"><CircleHelp className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />What to include and how it’s used<ChevronDown className="ml-auto size-3.5 shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" /></summary>
      <div className="mt-4 space-y-4 border-l-2 pl-4 text-xs leading-6 text-muted-foreground">
        <div><h3 className="font-medium text-foreground">What to include</h3><ul className="mt-1 list-disc space-y-1 pl-4">{(managerRole ? [
          'Project context, priorities and any terminology your manager should understand.',
          'Your preferred tone, level of detail and format for updates.',
          'How to plan work, explain trade-offs and raise decisions that need your input.',
        ] : [
          'Project conventions and quality standards to follow during agreed tasks.',
          'How to check changes and record findings, decisions and limitations.',
          'When to raise a question or blocker with the manager.',
        ]).map(item => <li key={item}>{item}</li>)}</ul><p className="mt-2">Keep these instructions reusable. Put individual tasks and changing requirements in the manager conversation.</p></div>
        <div><h3 className="font-medium text-foreground">Example</h3><blockquote className="mt-2 border-l-2 border-primary/30 pl-3 text-foreground">{managerRole ? 'Keep updates concise and use plain language. Explain the options before recommending a direction. Ask me about unclear priorities, and distinguish verified results from assumptions.' : 'Follow the project’s existing conventions. Check the agreed behaviour, record what was verified and describe any remaining limitations. Raise unclear requirements with the manager before changing scope.'}</blockquote></div>
        <div><h3 className="font-medium text-foreground">How it’s used</h3><p className="mt-1">{managerRole ? 'This text replaces Crew’s default manager instructions for this project and guides both typed and voice conversations. An optional manager name and personality above supplement this text; they never rewrite it. Clear the name and personality to use these instructions alone. Save your edits, then explicitly start or restart the manager in Sessions to apply them. Worker instructions are configured separately.' : 'This text replaces Crew’s default worker instructions for this project. Saved changes apply to newly launched workers; existing workers keep the instructions they started with.'}</p><p className="mt-2">Crew still supplies project and task context. These instructions don’t change Codex permissions or approval requirements.</p></div>
      </div>
    </details>
    {stale && <Alert className="mt-3" role="alert"><AlertDescription>The saved version changed while you were editing. Your draft is preserved. Copy it before cancelling to load the latest saved instructions.</AlertDescription></Alert>}
    {error && <Alert variant="destructive" className="mt-3" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}

    {editing && <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
      <Button variant="ghost" disabled={saving || text === data.defaultText} onClick={() => edit(data.defaultText)}><RotateCcw aria-hidden="true" />Reset to default</Button>
      <div className="flex gap-2"><Button variant="outline" disabled={saving} onClick={cancel}>Cancel changes</Button><Button disabled={!dirty || saving || stale || !text.trim() || !manager.eventReady} onClick={() => void save()}>{saving ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Save aria-hidden="true" />}{saving ? 'Saving…' : 'Save instructions'}</Button></div>
    </div>}
  </section>;
}

export function Settings({ manager }) {
  const [page, setPage] = useState('sessions');
  const workspace = useWorkspaceSettings();
  const selectedProject = workspace.snapshot?.projects.find(project => project.id === workspace.snapshot.selectedId);
  const [toast, setToast] = useState(null);
  const notify = message => setToast({ id: crypto.randomUUID(), message });
  const content = useRef(null);
  useEffect(() => { if (content.current) content.current.scrollTop = 0; }, [page]);
  const pages = [
    { id: 'global', label: 'General', icon: SlidersHorizontal, description: 'Preferences shared across every project on this Mac.' },
    { id: 'project', label: 'General', icon: SlidersHorizontal, description: 'Manage the details for this project.' },
    { id: 'archive', label: 'Archived workers', icon: Archive, description: 'Past workers whose teardown is complete. Restore a worker or permanently delete its saved Crew history.' },
    { id: 'sessions', label: 'Sessions', icon: Radio, description: 'Manage the live manager session for this project.' },
    { id: 'manager', label: 'Manager profile', icon: UserRound, description: 'Customize your AI manager’s name, picture, personality, voice and instructions.' },
    { id: 'worker', label: 'Worker profile', icon: Users, description: 'Set the instructions for newly launched workers.' },
  ];
  const current = pages.find(item => item.id === page);
  return <section ref={content} aria-label="Settings" className="min-h-0 flex-1 overflow-y-auto px-5 py-10 sm:px-10">
    <div className="mx-auto grid max-w-6xl items-start gap-8 md:grid-cols-[192px_minmax(0,1fr)] md:gap-12 lg:grid-cols-[224px_minmax(0,1fr)] lg:gap-16">
    <aside className="self-start md:sticky md:top-0">
      <h1 className="mb-3 px-3 text-sm font-semibold tracking-tight">Settings</h1>
      <nav aria-label="Settings pages" className="space-y-6">{[
        { label: 'Global settings', items: pages.filter(item => item.id === 'global') },
        { label: 'Project settings', items: pages.filter(item => item.id !== 'global') },
      ].map(group => <div key={group.label}><h2 className="mb-2 px-3 text-[11px] font-medium text-muted-foreground">{group.label}</h2><div className="flex flex-wrap gap-2 md:flex-col">{group.items.map(({ id, label, icon: Icon }) => <Button key={id} type="button" variant="ghost" aria-label={id === 'global' ? 'Global general settings' : id === 'project' ? 'Project general settings' : label} aria-current={page === id ? 'page' : undefined} className={`h-11 justify-start gap-3 rounded-lg px-3 text-sm md:w-full ${page === id ? 'bg-muted/60 font-semibold text-primary' : 'font-medium text-muted-foreground hover:text-foreground'}`} onClick={() => setPage(id)}><Icon className={`size-5 ${page === id ? 'text-primary' : 'text-muted-foreground/70'}`} aria-hidden="true" />{label}</Button>)}</div></div>)}</nav>
    </aside>
    <div className="min-w-0 space-y-8">
        <div><p className="mb-2 text-xs font-medium text-primary">{page === 'global' ? 'All projects · This Mac' : selectedProject?.name || manager.settings?.projectName || manager.projectInfo?.name || 'This project'}</p><h2 className="text-2xl font-semibold tracking-tight">{current.label}</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">{current.description}</p></div>
        <div hidden={page !== 'global'} aria-label="Global settings"><GlobalSettings workspace={workspace} onNotify={notify} /></div>
        <div hidden={page !== 'project'} aria-label="Project general settings"><ProjectGeneral key={selectedProject?.id || 'loading'} workspace={workspace} onNotify={notify} /></div>
        {page !== 'global' && manager.settingsError && <Alert variant="destructive" role="alert"><AlertDescription>{manager.settingsError}<Button className="ml-2" variant="outline" onClick={() => void manager.loadSettings().catch(() => {})}>Reload settings</Button></AlertDescription></Alert>}
        {page === 'archive' && <ArchivedWorkers key={manager.settings?.projectId || manager.projectInfo?.id || 'loading'} manager={manager} />}
        <div hidden={page !== 'sessions'} aria-label="Session settings"><section aria-labelledby="manager-lifecycle-heading" className="border-t pt-6"><h3 id="manager-lifecycle-heading" className="mb-4 font-semibold">Manager session</h3><ManagerLifecycle manager={manager} /></section></div>
        <div hidden={page !== 'manager'} aria-label="Manager profile settings" className="space-y-12"><div key={manager.settings?.projectId || 'loading'}><ManagerIdentity manager={manager} onNotify={notify} /><ManagerPersonality manager={manager} onNotify={notify} /><ManagerProfile key={manager.settings?.projectId || 'loading'} manager={manager} onNotify={notify} /></div>{manager.settings ? <PromptEditor key={`${manager.settings.projectId}:manager`} role="manager" data={manager.settings.manager} manager={manager} onNotify={notify} /> : <p role="status" className="text-sm text-muted-foreground">Loading manager instructions…</p>}</div>
        <div hidden={page !== 'worker'} aria-label="Worker profile settings">{manager.settings ? <PromptEditor key={`${manager.settings.projectId}:worker`} role="worker" data={manager.settings.worker} manager={manager} onNotify={notify} /> : <p role="status" className="text-sm text-muted-foreground">Loading worker instructions…</p>}</div>
    </div>
    </div>
    {toast && <SettingsToast key={toast.id} message={toast.message} onDismiss={() => setToast(null)} />}
  </section>;
}
