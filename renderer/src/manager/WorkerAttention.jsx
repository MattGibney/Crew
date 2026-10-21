import { useEffect, useState } from 'react';
import { ArrowUpRight, Check, ChevronDown, Clock3, FolderGit2, GitBranch, Hand, LoaderCircle, Pause, Play, Square, Trash2, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatElapsed, groupWorkers, pendingAttention, pendingLifecycle, workerActions, workerStatus, workerTiming } from './worker-model.js';

const ACTIONS = { pause: { label: 'Pause', Icon: Pause }, stop: { label: 'Stop', Icon: Square }, resume: { label: 'Resume', Icon: Play }, dispose: { label: 'Remove worktree', Icon: Trash2 } };
function AttentionItem({ taskId, item, onReview, disabled }) {
  const [reviewing, setReviewing] = useState(false), [error, setError] = useState('');
  const title = item.kind === 'question' ? 'Your answer is needed' : item.kind === 'completion' ? 'Result ready to review' : 'Review with your manager';
  return <div className="rounded-lg border border-border bg-muted/50 p-3">
    <p className="mb-1 flex items-center gap-2 text-xs font-semibold"><Hand className="size-3.5 shrink-0 text-primary" aria-hidden="true" />{title}</p>
    <p className="line-clamp-4 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">{item.message}</p>
    <Button type="button" size="sm" variant="outline" className="mt-3 w-full bg-background" disabled={disabled || reviewing} onClick={async () => { setReviewing(true); setError(''); try { await onReview(taskId, item.id); } catch (failure) { setError(failure.message || 'Could not request a review. Try again.'); } finally { setReviewing(false); } }}>{reviewing ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <ArrowUpRight aria-hidden="true" />}Review with manager</Button>
    {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
  </div>;
}
function WorkerCard({ task, onReview, onAction, disabled, now }) {
  const [busy, setBusy] = useState(false), [confirmRemove, setConfirmRemove] = useState(false), [error, setError] = useState(''), [requested, setRequested] = useState('');
  const attention = pendingAttention(task), pending = pendingLifecycle(task), timing = workerTiming(task, now);
  const title = task.brief?.trim().split('\n')[0] || 'Worker task';
  const progress = task.failure || task.result?.message || task.progress || (task.status === 'launching' ? 'Preparing the project environment.' : task.status === 'queued' ? 'Waiting for an available worker slot.' : 'Waiting for the next progress report.');
  const actions = workerActions(task), retained = task.worktree && task.status !== 'disposed';
  const recentAction = task.lifecycleRequests?.at(-1);
  useEffect(() => { setRequested(''); setConfirmRemove(false); }, [task.runId, task.status, recentAction?.status]);
  useEffect(() => { if (!disabled) setRequested(''); }, [disabled]);
  async function act(action) {
    setBusy(true); setError('');
    try { await onAction(task, action); setRequested(`${ACTIONS[action].label} requested through your manager.`); setConfirmRemove(false); }
    catch (failure) { setError(failure.message || 'The request could not be sent. Try again.'); }
    finally { setBusy(false); }
  }
  const working = ['running', 'launching', 'verifying', 'resume_queued', 'stopping', 'pausing'].includes(task.status);
  return <article data-worker-id={task.id} className="min-w-0 rounded-xl border border-border bg-card p-4 shadow-xs" aria-label={`${task.ticket || 'Unticketed'} worker: ${title}`}>
    <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
      <span className="text-xs font-semibold text-muted-foreground">{task.ticket || 'Ticket unavailable'}</span>
      <Badge variant={attention.length ? 'outline' : 'secondary'} className="gap-1.5 text-[10px] font-medium">
        {working ? <LoaderCircle className={`size-3 ${timing.live === true ? 'motion-safe:animate-spin' : ''}`} aria-hidden="true" /> : task.status === 'completed' ? <Check className="size-3" aria-hidden="true" /> : attention.length ? <Hand className="size-3" aria-hidden="true" /> : null}{workerStatus(task)}
      </Badge>
    </div>
    <h3 className="line-clamp-2 break-words text-sm font-semibold leading-snug" title={title}>{title}</h3>
    <p className="mt-2 line-clamp-3 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">{progress}</p>
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      <span className="inline-flex items-center gap-1.5"><span className={`size-1.5 rounded-full ${timing.live === true ? 'bg-primary' : 'bg-muted-foreground/40'}`} />{timing.live === true ? 'Process live' : timing.live === false ? 'Process not live' : 'Liveness unverified'}</span>
      {timing.elapsed !== null && <span className="inline-flex items-center gap-1.5" title="Elapsed wall time for this execution, not compute time"><Clock3 className="size-3" aria-hidden="true" />{formatElapsed(timing.elapsed)} elapsed</span>}
    </div>
    {attention.length > 0 && <div className="mt-3 space-y-2">{attention.map(item => <AttentionItem key={item.id} taskId={task.id} item={item} onReview={onReview} disabled={disabled} />)}</div>}
    {pending && <p role="status" className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-3 motion-safe:animate-spin" aria-hidden="true" />{ACTIONS[pending.action]?.label || 'Lifecycle change'} {pending.status === 'pending' ? 'queued' : 'in progress'}</p>}
    {recentAction?.status === 'failed' && <p className="mt-3 text-xs text-destructive">{recentAction.error || 'The last lifecycle action could not complete.'}</p>}
    {onAction && actions.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">{actions.map(action => { const { Icon, label } = ACTIONS[action]; return <Button key={action} type="button" variant="outline" size="sm" className="h-7 px-2 text-[11px]" disabled={disabled || busy || Boolean(requested)} onClick={() => action === 'dispose' ? setConfirmRemove(true) : void act(action)} aria-label={`${label} worker ${task.ticket} ${task.id}`}><Icon className="size-3" aria-hidden="true" />{label}</Button>; })}</div>}
    {confirmRemove && <div className="mt-3 rounded-lg border border-border bg-muted/50 p-3 text-xs"><p>Ask your manager to remove this worker’s environment and worktree? Dirty or unresolved work is protected. Task history is kept.</p><div className="mt-3 flex gap-2"><Button type="button" size="sm" variant="destructive" disabled={disabled || busy} onClick={() => void act('dispose')}>Remove safely</Button><Button type="button" size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>Cancel</Button></div></div>}
    {requested && <p role="status" className="mt-2 text-xs text-muted-foreground">{requested}</p>}
    {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
    <details className="group mt-3 border-t border-border pt-3">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-sm text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><GitBranch className="size-3" aria-hidden="true" />{retained ? 'Retained worktree' : task.status === 'disposed' ? 'Worktree removed' : 'Task details'}<ChevronDown className="ml-auto size-3 transition-transform group-open:rotate-180" aria-hidden="true" /></summary>
      <dl className="mt-3 space-y-2 text-[11px] leading-relaxed text-muted-foreground">
        <div><dt className="font-medium text-foreground">Task ID</dt><dd className="break-all select-text">{task.id}</dd></div>
        <div><dt className="font-medium text-foreground">Project / repository</dt><dd className="break-all">{task.projectId || 'Not recorded'} / {task.repositoryId || 'Not recorded'}</dd></div>
        <div><dt className="font-medium text-foreground">Worktree</dt><dd className="break-all select-text">{task.worktree || 'Not created yet'}</dd></div>
        {task.environment && <div><dt className="font-medium text-foreground">Project environment</dt><dd>{task.environment.status || 'Status unavailable'}{task.environment.urls?.web && <span className="mt-1 block break-all select-text">{task.environment.urls.web}</span>}</dd></div>}
        <div><dt className="font-medium text-foreground">Linear ticket</dt><dd>{task.ticket || 'Reference unavailable'} · title and status not available in this local record. Worker status above is separate.</dd></div>
        <div><dt className="font-medium text-foreground">Agreed task</dt><dd className="whitespace-pre-wrap break-words">{task.brief}</dd></div>
        <div><dt className="font-medium text-foreground">Latest report</dt><dd className="whitespace-pre-wrap break-words">{progress}</dd></div>
        {timing.observedAt && <div><dt className="font-medium text-foreground">Process last checked</dt><dd><time dateTime={timing.observedAt}>{new Date(timing.observedAt).toLocaleString()}</time></dd></div>}
      </dl>
    </details>
  </article>;
}
export function WorkerAttention({ view, onReview, onAction, disabled = false, onRetry }) {
  const tasks = view.tasks || [], pending = tasks.flatMap(pendingAttention), groups = groupWorkers(tasks);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return <section aria-label="Workers and worktrees" className="min-w-0 space-y-4">
    <div className="flex items-start justify-between gap-3"><div><h2 id="attention-title" className="text-sm font-semibold">Workers <span className="ml-1 text-muted-foreground">{tasks.length}</span></h2><p className="mt-1 text-xs text-muted-foreground">{groups.retained ? `${groups.retained} retained worktree${groups.retained === 1 ? '' : 's'}` : 'Work continues when you close this window.'}</p></div>{pending.length > 0 && <Badge variant="outline" className="shrink-0 gap-1.5"><Hand className="size-3 text-primary" aria-hidden="true" />{pending.length} to review</Badge>}</div>
    {view.error && <div role="alert" className="rounded-lg border border-destructive/30 p-3 text-xs"><p className="flex items-center gap-2 font-medium text-destructive"><TriangleAlert className="size-4" aria-hidden="true" />Controller needs attention</p><p className="mt-1 break-words text-muted-foreground">{view.error}</p>{onRetry && <Button className="mt-2" type="button" size="sm" variant="outline" onClick={onRetry}>Retry</Button>}</div>}
    {view.loading && <div role="status" className="flex items-center gap-2 rounded-xl border border-border p-4 text-xs text-muted-foreground"><LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />Loading workers…</div>}
    {!view.loading && !tasks.length && <div className="rounded-xl border border-dashed border-border bg-muted/20 px-5 py-9 text-center"><div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-xl border border-border bg-background"><FolderGit2 className="size-5 text-muted-foreground" aria-hidden="true" /></div><h3 className="text-sm font-medium">A workspace for every task</h3><p className="mx-auto mt-2 max-w-60 text-xs leading-relaxed text-muted-foreground">Agree a task with your manager to start a worker. Its progress and questions appear here.</p></div>}
    <div id="worker-state" className="space-y-3">{groups.active.map(task => <WorkerCard key={task.id} task={task} now={now} onReview={onReview} onAction={onAction} disabled={disabled} />)}</div>
    {groups.history.length > 0 && <details className="group/history rounded-xl border border-border"><summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl p-3 text-xs font-medium outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring">History <span className="text-muted-foreground">{groups.history.length}</span><ChevronDown className="ml-auto size-3.5 transition-transform group-open/history:rotate-180" aria-hidden="true" /></summary><div className="space-y-3 px-3 pb-3">{groups.history.map(task => <WorkerCard key={task.id} task={task} now={now} onReview={onReview} onAction={onAction} disabled={disabled} />)}</div></details>}
    {tasks.length > 0 && <p id="controller-status" className="text-[11px] leading-relaxed text-muted-foreground">Review questions and results with your manager. Worker controls apply only to the selected task.</p>}
  </section>;
}
