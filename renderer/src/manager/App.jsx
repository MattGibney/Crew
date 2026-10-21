import { useState } from 'react';
import { AudioLines, Circle, GitBranch, MessageSquare, Layers, Radio, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useCrewManager } from './useCrewManager.js';
import { WorkerAttention } from './WorkerAttention.jsx';
import { VoiceControls } from './VoiceControls.jsx';
import {UpdateControls} from './UpdateControls.jsx';
import { Settings } from './Settings.jsx';
import { WorkChat } from './WorkChat.jsx';
import { WorkerDetail } from './WorkerDetail.jsx';
import { ManagerCallBar } from './ManagerCallBar.jsx';
import { ProjectSwitcher } from './ProjectSwitcher.jsx';
import crewMark from '../../../build/crew-mark.png';

export function App() {
  const manager = useCrewManager();
  const [pane, setPane] = useState('conversation');
  const [selectedWorker, setSelectedWorker] = useState(null);
  const [settingsReturn, setSettingsReturn] = useState('conversation');
  const openPane = next => { if (manager.voice.mode === 'push-to-talk') manager.voice.stopInput(); setPane(next); };
  const showWorker = id => { setSelectedWorker(id); openPane('detail'); };
  const selectedTask = manager.orchestration.tasks?.find(task => task.id === selectedWorker);
  const tasks = manager.orchestration.tasks || [];
  const pending = tasks.reduce((count, task) => count + (task.attention || []).filter(item => !item.ackedAt).length, 0);
  return <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background text-foreground">
    <a href={pane === 'conversation' ? '#message-input' : '#workspace-content'} className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded-md focus:bg-background focus:p-3">Skip to message</a>
    <header className="flex min-h-18 shrink-0 items-center justify-between gap-4 border-b px-5 sm:px-7">
      <div className="flex min-w-0 items-center gap-4"><div className="flex items-center gap-2.5"><img src={crewMark} alt="" width="34" height="34" className="size-8" /><span className="text-xl font-semibold tracking-tight">Crew</span></div><span className="h-6 border-l" aria-hidden="true" /><div className="min-w-0"><ProjectSwitcher fallbackName={manager.projectInfo?.name} /><p className="flex items-center gap-1.5 text-xs text-muted-foreground"><GitBranch className="size-3" aria-hidden="true" />{manager.projectInfo?.mode === 'fixture' ? 'Acceptance workspace' : 'Local workspace'}</p></div></div>
      <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground"><Button variant={pane === 'settings' ? 'secondary' : 'ghost'} aria-pressed={pane === 'settings'} onClick={() => { if (pane !== 'settings') setSettingsReturn(pane); openPane(pane === 'settings' ? settingsReturn : 'settings'); }}><Settings2 aria-hidden="true" /><span className="hidden sm:inline">Settings</span><span className="sr-only sm:hidden">Settings</span></Button><UpdateControls liveStatus={manager.updates}/><Circle className={`size-2 ${manager.eventReady ? 'fill-primary text-primary' : ''}`} aria-hidden="true" /><span className="hidden sm:inline">{manager.eventReady ? 'Controller connected' : 'Reconnecting…'}</span>{pane !== 'settings' && manager.voice.active && <Badge variant="secondary"><AudioLines className="size-3" aria-hidden="true" />Voice connected</Badge>}</div>
    </header>
    <nav aria-label="Workspace views" className={`${pane === 'settings' ? 'hidden' : 'flex'} shrink-0 gap-1 border-b px-3 py-2 sm:px-5`}><Button variant={pane === 'conversation' ? 'secondary' : 'ghost'} aria-pressed={pane === 'conversation'} className="h-8 text-xs" onClick={() => openPane('conversation')}><MessageSquare />Conversation</Button><Button variant={pane === 'workers' ? 'secondary' : 'ghost'} aria-pressed={pane === 'workers'} className="h-8 text-xs" onClick={() => openPane('workers')}><Layers />Workers {pending > 0 && <Badge>{pending}</Badge>}</Button></nav>
    <main id="workspace-content" className={`${pane === 'conversation' || pane === 'workers' ? 'grid' : 'hidden'} min-h-0 flex-1 ${pane === 'conversation' ? 'lg:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[minmax(0,1fr)_560px]' : ''}`}>
      <section aria-label="Manager workspace" className={`min-h-0 min-w-0 overflow-y-auto flex-col ${pane === 'conversation' ? 'flex' : 'hidden'}`}>
        <div className="flex items-center justify-between gap-3 px-5 py-4 sm:px-7"><div><h1 className="text-base font-semibold tracking-tight">Your manager</h1><p className="mt-0.5 text-xs text-muted-foreground">One conversation. A whole crew behind it.</p></div><Badge variant="outline" className="gap-1.5"><Radio className="size-3" aria-hidden="true" />{manager.managerLifecycle.state !== 'running' ? ({ stopped: 'Stopped', stopping: 'Stopping…', starting: 'Starting…', restarting: 'Restarting…', error: 'Needs attention' }[manager.managerLifecycle.state] || 'Connecting') : manager.work.activeTurnId ? 'Working' : manager.prepared && manager.work.managerConnected !== false ? 'Ready' : 'Connecting'}</Badge></div>
        <WorkChat manager={manager}><VoiceControls manager={manager} visible={pane === 'conversation'} /></WorkChat>
      </section>
      <aside aria-label="Project workers" className={`min-h-0 min-w-0 overflow-y-auto bg-muted/25 p-5 ${pane === 'conversation' ? 'hidden lg:block lg:border-l' : pane === 'workers' ? 'block' : 'hidden'}`}>
        <WorkerAttention compact={pane === 'conversation'} view={manager.orchestration} onSelect={showWorker} />
      </aside>
    </main>
    <div className={`${pane === 'detail' ? 'flex' : 'hidden'} min-h-0 flex-1 flex-col`}>{selectedTask ? <WorkerDetail key={selectedTask.id} task={selectedTask} manager={manager} onBack={() => openPane('conversation')} onManager={() => openPane('conversation')} /> : <section className="flex-1 p-8"><p>This worker is no longer available in this project.</p><Button onClick={() => openPane('conversation')}>Back to manager</Button></section>}</div>
    {pane !== 'conversation' && pane !== 'settings' && <ManagerCallBar manager={manager} onManager={() => openPane('conversation')} />}
    <audio id="audio" ref={manager.voice.audioRef} autoPlay className="hidden" aria-label="Manager voice playback" />
    <div className={`${pane === 'settings' ? 'flex' : 'hidden'} min-h-0 flex-1`}><Settings manager={manager} /></div>
  </div>;
}
