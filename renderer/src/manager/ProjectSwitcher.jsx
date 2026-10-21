import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Plus, FolderOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';

export function ProjectSwitcher({ fallbackName }) {
  const bridge = window.crewWorkspaces;
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const menu = useRef(null);
  const selected = snapshot?.projects.find(project => project.id === snapshot.selectedId);

  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    // Subscribe first so changes during the initial request cannot be missed.
    let changed = false;
    const unsubscribe = bridge.subscribe(value => { changed = true; if (alive) setSnapshot(value); });
    bridge.snapshot().then(value => { if (alive && !changed) setSnapshot(value); }).catch(reason => { if (alive) setError(reason.message); });
    return () => { alive = false; unsubscribe(); };
  }, [bridge]);

  useEffect(() => {
    const dismiss = event => {
      if (menu.current && !menu.current.contains(event.target)) menu.current.open = false;
    };
    const escape = event => {
      if (event.key === 'Escape' && menu.current?.open) {
        menu.current.open = false;
        menu.current.querySelector('summary')?.focus();
      }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape); };
  }, []);

  async function run(operation, after) {
    setWorking(true); setError('');
    try { await operation(); after?.(); }
    catch (reason) { setError(reason.message || 'Unable to update your projects.'); }
    finally { setWorking(false); }
  }

  if (!bridge) return <p className="truncate text-sm font-medium" id="instance-project">{fallbackName || 'Your project'}</p>;
  return <details ref={menu} className="group relative min-w-0">
    <summary id="instance-project" aria-label={`Project: ${selected?.name || fallbackName || 'Your project'}. Manage projects`} className="flex cursor-pointer list-none items-center gap-1 rounded-md py-1 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
      <span className="max-w-[28vw] truncate sm:max-w-64">{selected?.name || fallbackName || 'Your project'}</span><ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
    </summary>
    <div role="region" aria-label="Manage projects" className="fixed left-4 top-20 z-50 max-h-[calc(100dvh-6rem)] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg sm:absolute sm:left-0 sm:top-full sm:mt-2">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold"><FolderOpen className="size-4 text-primary" aria-hidden="true" />Your projects</div>
      <label htmlFor="workspace-select" className="mb-1.5 block text-xs font-medium">Current project</label>
      <NativeSelect className="w-full" id="workspace-select" value={snapshot?.selectedId || ''} disabled={working || !snapshot} onChange={event => {
        const nextId = event.target.value;
        if (nextId !== snapshot.selectedId) run(() => bridge.select(nextId), () => { menu.current.open = false; });
      }}>
        {!snapshot && <option value="">Loading projects…</option>}
        {snapshot?.projects.map(project => <option key={project.id} value={project.id}>{project.name}{project.pending ? ` · ${project.pending} need attention` : project.error || project.ready === false ? ' · Needs setup' : project.active ? ' · Working' : ''}</option>)}
      </NativeSelect>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Work continues in other projects. Switching disconnects voice; connect again when you’re ready.</p>
      <Button variant="outline" className="mt-3 w-full" disabled={working || !snapshot} onClick={() => run(() => bridge.add(), () => { menu.current.open = false; })}><Plus aria-hidden="true" />Add project</Button>
      {error && <p role="alert" className="mt-3 text-xs text-destructive">{error}</p>}
      {working && <p role="status" className="mt-3 text-xs text-muted-foreground">Saving…</p>}
    </div>
  </details>;
}
