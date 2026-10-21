import { useState } from 'react';
import { AudioLines, Circle, GitBranch, MessageSquare, Layers, Radio } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useCrewManager } from './useCrewManager.js';
import { WorkerAttention } from './WorkerAttention.jsx';
import { VoiceControls } from './VoiceControls.jsx';
import {UpdateControls} from './UpdateControls.jsx';
import { WorkChat } from './WorkChat.jsx';
import { ProjectSwitcher } from './ProjectSwitcher.jsx';
import crewMark from '../../../build/crew-mark.png';

export function App() {
  const manager = useCrewManager();
  const [pane, setPane] = useState('conversation');
  const tasks = manager.orchestration.tasks || [];
  const pending = tasks.reduce((count, task) => count + (task.attention || []).filter(item => !item.ackedAt).length, 0);
  const busy = manager.sending || Boolean(manager.work.activeTurnId);
  return <div className="flex min-h-dvh flex-col bg-background text-foreground lg:h-dvh lg:overflow-hidden">
    <a href="#message-input" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded-md focus:bg-background focus:p-3">Skip to message</a>
    <header className="flex min-h-18 shrink-0 items-center justify-between gap-4 border-b px-5 sm:px-7">
      <div className="flex min-w-0 items-center gap-4"><div className="flex items-center gap-2.5"><img src={crewMark} alt="" width="34" height="34" className="size-8" /><span className="text-xl font-semibold tracking-tight">Crew</span></div><span className="h-6 border-l" aria-hidden="true" /><div className="min-w-0"><ProjectSwitcher fallbackName={manager.projectInfo?.name} /><p className="flex items-center gap-1.5 text-xs text-muted-foreground"><GitBranch className="size-3" aria-hidden="true" />{manager.projectInfo?.mode === 'fixture' ? 'Acceptance workspace' : 'Local workspace'}</p></div></div>
      <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground"><UpdateControls liveStatus={manager.updates}/><Circle className={`size-2 ${manager.eventReady ? 'fill-primary text-primary' : ''}`} aria-hidden="true" /><span className="hidden sm:inline">{manager.eventReady ? 'Controller connected' : 'Reconnecting…'}</span>{manager.voice.active && <Badge variant="secondary"><AudioLines className="size-3" aria-hidden="true" />Voice connected</Badge>}</div>
    </header>
    <nav aria-label="Workspace views" className="flex gap-1 border-b p-2 lg:hidden"><Button variant={pane === 'conversation' ? 'secondary' : 'ghost'} aria-pressed={pane === 'conversation'} className="flex-1" onClick={() => setPane('conversation')}><MessageSquare />Conversation</Button><Button variant={pane === 'workers' ? 'secondary' : 'ghost'} aria-pressed={pane === 'workers'} className="flex-1" onClick={() => setPane('workers')}><Layers />Workers {pending > 0 && <Badge>{pending}</Badge>}</Button></nav>
    <main className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_370px] xl:grid-cols-[minmax(0,1fr)_410px]">
      <section aria-label="Manager workspace" className={`min-h-0 min-w-0 flex-col ${pane === 'conversation' ? 'flex' : 'hidden'} lg:flex`}>
        <div className="flex items-center justify-between gap-3 px-5 py-4 sm:px-7"><div><h1 className="text-base font-semibold tracking-tight">Your manager</h1><p className="mt-0.5 text-xs text-muted-foreground">One conversation. A whole crew behind it.</p></div><Badge variant="outline" className="gap-1.5"><Radio className="size-3" aria-hidden="true" />{manager.work.activeTurnId ? 'Working' : manager.prepared ? 'Ready' : 'Connecting'}</Badge></div>
        <WorkChat manager={manager}><VoiceControls manager={manager} /></WorkChat>
      </section>
      <aside aria-label="Project workers" className={`min-h-0 min-w-0 overflow-y-auto bg-muted/25 p-5 lg:border-l ${pane === 'workers' ? 'block' : 'hidden'} lg:block`}>
        <WorkerAttention view={manager.orchestration} onReview={async (...args) => { await manager.reviewAttention(...args); setPane('conversation'); }} onAction={async (...args) => { await manager.workerAction(...args); setPane('conversation'); }} disabled={busy || !manager.prepared || !manager.eventReady} />
      </aside>
    </main>
  </div>;
}
