import { useState } from 'react';
import { Hand } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { visibleWorkers } from './state.js';

function AttentionItem({ taskId, item, onReview }) {
  const [reviewing, setReviewing] = useState(false);
  return <div className="space-y-2">
    <p className="text-sm whitespace-pre-wrap break-words">{item.message}</p>
    <Button type="button" variant="outline" disabled={reviewing} onClick={async () => { setReviewing(true); try { await onReview(taskId, item.id); } finally { setReviewing(false); } }}>Review with manager</Button>
  </div>;
}
function WorkerState({ task, onReview }) {
  const brief = task.brief.length > 220 ? `${task.brief.slice(0, 220).trimEnd()}…` : task.brief;
  const progress = task.result?.message || task.failure || task.progress || (task.status === 'launching' && task.environment?.kind === 'project-execution' ? 'Running this project’s existing setup before work starts.' : brief);
  const end = task.execution?.endedAt ? Date.parse(task.execution.endedAt) : task.execution?.live ? Date.now() : Date.parse(task.updatedAt);
  const seconds = task.execution?.startedAt ? Math.max(0, Math.floor((end - Date.parse(task.execution.startedAt)) / 1000)) : 0;
  return <article className="space-y-3" aria-label={`${task.ticket} worker`}>
    <div className="flex flex-wrap items-center gap-2"><p className="min-w-0 break-all font-medium">{task.ticket} · {task.id}</p><Badge variant="secondary">{task.status}</Badge></div>
    <p className="text-sm whitespace-pre-wrap break-words text-muted-foreground">{progress}</p>
    {task.execution?.startedAt && task.harnessStarted === true && <p className="text-sm text-muted-foreground">{task.execution.live ? 'Execution live' : 'Execution ended'} · this run {seconds}s{task.environment?.status ? ` · environment ${task.environment.status}` : ''}</p>}
    {task.environment?.kind === 'project-execution' && <div className="space-y-1 text-sm text-muted-foreground">
      <p className="break-all">Project environment {task.environment.id} · {task.environment.status}</p>
      {task.environment.urls?.web && task.environment.status === 'ready' && <p className="break-all">Worker application: {task.environment.urls.web}</p>}
    </div>}
    {(task.attention || []).filter(item => !item.ackedAt).map(item => <AttentionItem key={item.id} taskId={task.id} item={item} onReview={onReview} />)}
  </article>;
}
export function WorkerAttention({ view, onReview }) {
  const tasks = view.tasks || [], pending = tasks.flatMap(task => (task.attention || []).filter(item => !item.ackedAt));
  return <section aria-label="Worker attention"><Card>
    <CardHeader>
      <CardTitle id="attention-title" className="flex items-center gap-2">{pending.length > 0 && <Hand className="size-4 shrink-0" aria-hidden="true" />}{pending.length ? `${pending.length} item${pending.length === 1 ? ' needs' : 's need'} your attention` : 'No pending worker attention'}</CardTitle>
      <CardDescription>The local controller and workers continue when voice or this window closes. You talk only to the manager. Reconnect voice or choose Review when you are ready; nothing starts your microphone automatically.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      <p id="controller-status" role="status" className="text-sm text-muted-foreground">{view.error ? `Controller needs attention: ${view.error}` : view.loading ? 'Loading local controller…' : `Local controller running independently of voice.${view.maxConcurrent ? ` Up to ${view.maxConcurrent} workers run at once.` : ''}`}</p>
      <div id="worker-state" className="space-y-4">{visibleWorkers(tasks).map((task, index) => <div key={task.id}>{index > 0 && <Separator className="mb-4" />}<WorkerState task={task} onReview={onReview} /></div>)}</div>
    </CardContent>
  </Card></section>;
}
