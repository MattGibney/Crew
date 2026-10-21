import { useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle, Play, RotateCcw, Save, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';

const shortVersion = version => version ? String(version).slice(0, 10) : 'unavailable';

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

function PromptEditor({ role, data, manager }) {
  const [draft, setDraft] = useState(null), [saving, setSaving] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('');
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
  const edit = value => { if (draft === null) setBaseVersion(data.saved.version); setDraft(value); setNotice(''); setError(''); };
  const cancel = () => { setDraft(null); setBaseVersion(null); setError(''); setNotice('Unsaved changes discarded.'); };
  const save = async () => {
    if (!dirty || saving) return;
    const submitted = text;
    setSaving(true); setError(''); setNotice('');
    try {
      const saved = await manager.savePrompt(role, submitted, baseVersion);
      if (draftRef.current === submitted) { setDraft(null); setBaseVersion(null); }
      else setBaseVersion(saved[role].saved.version);
      setNotice(draftRef.current !== submitted ? 'Submitted version saved. Your newer edits are still unsaved.' : managerRole ? 'Saved. Restart your manager explicitly to apply these instructions.' : 'Saved. New workers will use these instructions. Existing workers keep their original instructions.');
    } catch (error) { setError(error.message); }
    finally { setSaving(false); }
  };
  return <section aria-labelledby={`${role}-instructions-heading`} className="rounded-xl border bg-card p-5 sm:p-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 id={`${role}-instructions-heading`} className="font-semibold tracking-tight">{managerRole ? 'Manager instructions' : 'Worker instructions'}</h2><p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">{managerRole ? 'The full Crew behavior for this project’s manager. Saved edits wait for an explicit manager restart.' : 'The full Crew behavior for newly launched workers in this project. Running and retained workers keep their original snapshot.'}</p></div>
      <div className="flex flex-wrap gap-2"><Badge variant="outline" title={`Saved version: ${data.saved.version}`}>Saved {shortVersion(data.saved.version)}</Badge>{managerRole && <Badge variant="outline" title={`${data.activeVersion ? 'Active' : 'Last active'} version: ${data.activeVersion || data.retainedVersion || 'unavailable'}`}>{data.activeVersion ? 'Active' : 'Last active'} {shortVersion(data.activeVersion || data.retainedVersion)}</Badge>}{dirty && <Badge variant="secondary">Unsaved changes</Badge>}{managerRole && data.pendingRestart && <Badge variant="secondary">Restart pending</Badge>}</div>
    </div>
    <Label htmlFor={`${role}-prompt`} className="mt-5 mb-2 block">{managerRole ? 'Manager' : 'Worker'} prompt</Label>
    <Textarea id={`${role}-prompt`} value={text} onChange={event => edit(event.target.value)} aria-describedby={`${role}-prompt-hint`} className="min-h-80 resize-y font-mono text-xs leading-6" spellCheck={false} />
    <p id={`${role}-prompt-hint`} className="mt-2 text-xs leading-5 text-muted-foreground">Replaces Crew’s default behavior. Codex/provider rules and required runtime tool context still apply. Do not include credentials or secrets.</p>
    {stale && <Alert className="mt-3" role="alert"><AlertDescription>The saved version changed while you were editing. Your draft is preserved. Copy it before cancelling to load the latest saved instructions.</AlertDescription></Alert>}
    {error && <Alert variant="destructive" className="mt-3" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
    {notice && <p role="status" className="mt-3 flex items-start gap-2 text-xs leading-5 text-muted-foreground"><Check className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />{notice}</p>}
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
      <Button variant="ghost" disabled={saving || text === data.defaultText} onClick={() => edit(data.defaultText)}><RotateCcw aria-hidden="true" />Reset to default</Button>
      <div className="flex gap-2"><Button variant="outline" disabled={!dirty || saving} onClick={cancel}>Cancel changes</Button><Button disabled={!dirty || saving || stale || !text.trim() || !manager.eventReady} onClick={() => void save()}>{saving ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Save aria-hidden="true" />}{saving ? 'Saving…' : 'Save instructions'}</Button></div>
    </div>
  </section>;
}

export function Settings({ manager }) {
  return <section aria-label="Project settings" className="min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-7">
    <div className="mx-auto max-w-4xl space-y-6">
      <div><p className="mb-2 text-xs font-medium text-primary">{manager.settings?.projectName || manager.projectInfo?.name || 'This project'}</p><h1 className="text-2xl font-semibold tracking-tight">Settings</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Shape how your crew works. These instructions belong only to this project.</p></div>
      <section aria-labelledby="manager-lifecycle-heading" className="rounded-xl border bg-card p-5 sm:p-6"><h2 id="manager-lifecycle-heading" className="mb-4 font-semibold tracking-tight">Manager session</h2><ManagerLifecycle manager={manager} /></section>
      {manager.settingsError && <Alert variant="destructive" role="alert"><AlertDescription>{manager.settingsError}<Button className="ml-2" variant="outline" onClick={() => void manager.loadSettings().catch(() => {})}>Reload settings</Button></AlertDescription></Alert>}
      {!manager.settings ? <p role="status" className="text-sm text-muted-foreground">Loading project instructions…</p> : <>{['manager', 'worker'].map(role => <PromptEditor key={`${manager.settings.projectId}:${role}`} role={role} data={manager.settings[role]} manager={manager} />)}</>}
    </div>
  </section>;
}
