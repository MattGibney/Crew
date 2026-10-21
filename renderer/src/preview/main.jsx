// This entry is injected only by scripts/ui-preview/start.mjs. Production uses manager/main.jsx.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/theme.css';
import { App } from '../manager/App.jsx';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { scenarios } from '../../../scripts/ui-preview/scenarios.mjs';

const subscribers = new Set();
let snapshot = { selectedId: 'northstar', workerLimit: 3, projects: [{ id: 'northstar', name: 'Northstar Studio', ready: true, active: true }, { id: 'atlas', name: 'Atlas Journal', ready: true, pending: 2 }, { id: 'sandbox', name: 'Design sandbox', ready: false }] };
const publish = () => subscribers.forEach(callback => callback(structuredClone(snapshot)));
let switchProject = () => {};
window.crewWorkspaces = {
  snapshot: async () => structuredClone(snapshot), subscribe: callback => { subscribers.add(callback); return () => subscribers.delete(callback); },
  select: async id => { snapshot.selectedId = id; publish(); await switchProject(); },
  rename: async ({ id, name }) => { snapshot.projects.find(project => project.id === id).name = name; publish(); },
  setWorkerLimit: async limit => { snapshot.workerLimit = limit; publish(); },
  add: async () => { const id = `preview-${snapshot.projects.length}`; snapshot.projects.push({ id, name: 'New preview project', ready: true }); publish(); },
};
// Block navigation to external resources in the design sandbox, including target=_blank links.
document.addEventListener('click', event => { const anchor = event.target.closest?.('a'); if (anchor && new URL(anchor.href).origin !== location.origin) { event.preventDefault(); } }, true);
function Preview() {
  const [name, setName] = useState(scenarios[0]), [epoch, setEpoch] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const reset = async next => { setBusy(true); setError(''); try { const response = await fetch('/__preview/scenario', { method: 'POST', body: JSON.stringify({ name: next, project: snapshot.projects.find(project => project.id === snapshot.selectedId).name }) }); const result = await response.json(); if (!response.ok) throw Error(result.error); setName(next); setEpoch(value => value + 1); } catch (error) { setError(error.message); } finally { setBusy(false); } };
  switchProject = () => reset(name);
  return <><div className="flex h-12 shrink-0 items-center gap-3 border-b bg-muted/50 px-4 text-xs" aria-label="Design preview controls"><span className="font-semibold text-primary">Design preview</span><label htmlFor="preview-scenario" className="sr-only">Preview scenario</label><NativeSelect id="preview-scenario" value={name} disabled={busy} onChange={event => void reset(event.target.value)} className="h-8 w-44">{scenarios.map(value => <option key={value}>{value}</option>)}</NativeSelect><Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => void reset(name)}>Reset scenario</Button><span className="hidden text-muted-foreground sm:inline">Fictional data · simulated calls · no real work</span>{error && <span role="alert">{error}</span>}</div><div className="preview-product"><App key={epoch} /></div></>;
}
const style = document.createElement('style'); style.textContent = '.preview-product > div { height: calc(100dvh - 3rem); }'; document.head.append(style);
const root = import.meta.hot?.data.root || createRoot(document.getElementById('root'));
if (import.meta.hot) import.meta.hot.dispose(data => { data.root = root; });
root.render(<Preview />);
