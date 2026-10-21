import { ArrowUpRight, CheckSquare2, FileText, HelpCircle, NotebookPen, Scale } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

function TicketLink({ url }) {
  let safe = false;
  try { const parsed = new URL(url); safe = ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password; } catch { /* Invalid saved links stay literal. */ }
  return safe ? <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1 break-all text-primary underline underline-offset-4">Ticket<ArrowUpRight className="size-3 shrink-0" aria-hidden="true" /></a> : <span className="break-all">Ticket link unavailable</span>;
}

function ScratchpadSection({ title, icon: Icon, items, empty }) {
  return <section aria-label={title} className="border-t py-6">
    <h2 className="flex items-center gap-2 text-sm font-semibold"><Icon className="size-4 text-muted-foreground" aria-hidden="true" />{title}</h2>
    {items.length ? <ul className="mt-4 space-y-3 pl-5 text-sm leading-6 marker:text-muted-foreground list-disc">{items.map((item, index) => <li key={index} className="whitespace-pre-wrap break-words">{item}</li>)}</ul> : <p className="mt-3 text-sm text-muted-foreground">{empty}</p>}
  </section>;
}

export function ManagerScratchpad({ scratchpad, scratchpadReadError, eventReady, tasks = [], onSelectWorker }) {
  const commitments = scratchpad?.commitments || [];
  const updated = scratchpad?.updatedAt && new Date(scratchpad.updatedAt);
  const hasUpdated = updated && Number.isFinite(updated.getTime());
  return <section id="scratchpad-content" tabIndex={-1} aria-label="Manager scratchpad" className="min-h-0 flex-1 overflow-y-auto px-5 py-7 sm:px-8">
    <div className="mx-auto max-w-4xl">
      <div className="mb-7 flex flex-wrap items-start justify-between gap-3">
        <div><h1 className="flex items-center gap-2.5 text-xl font-semibold tracking-tight"><NotebookPen className="size-5 text-primary" aria-hidden="true" />Manager scratchpad</h1><p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">Saved commitments and working notes for this project. Ask your manager in the conversation to make a correction.</p></div>
        <Badge variant="outline">Read only</Badge>
      </div>
      <p className="mb-6 text-xs text-muted-foreground">{hasUpdated ? <>Last updated <time dateTime={updated.toISOString()}>{updated.toLocaleString()}</time></> : scratchpad ? 'No changes saved yet' : 'Last updated unavailable'}</p>
      {scratchpadReadError && <p role="alert" className="mb-5 rounded-lg border border-destructive/30 p-3 text-sm leading-6 text-destructive">Could not read the saved scratchpad. {scratchpadReadError} Saved notes may be out of date. Ask your manager to review the preserved scratchpad before making changes.</p>}
      {!eventReady && <p role="status" className="mb-5 rounded-lg border p-3 text-sm text-muted-foreground">Reconnecting to this project. Saved notes may be out of date.</p>}
      {!scratchpad ? <div className="rounded-lg border p-5"><h2 className="text-sm font-semibold">Scratchpad unavailable</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">This project's saved scratchpad has not been received. It will appear when the controller provides it.</p></div> : <>
        <section aria-label="Commitments" className="border-t py-6">
          <h2 className="flex items-center gap-2 text-sm font-semibold"><CheckSquare2 className="size-4 text-muted-foreground" aria-hidden="true" />Commitments <span className="font-normal text-muted-foreground">{commitments.length}</span></h2>
          {commitments.length ? <ul className="mt-2 divide-y">{commitments.map(item => {
            const references = item.references || {};
            const worker = tasks.find(task => task.id === references.taskId);
            return <li key={item.id} className="py-4">
              <div className="flex flex-wrap items-start justify-between gap-2"><h3 className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm font-medium leading-6">{item.title}</h3><Badge variant="secondary" className="capitalize">{item.status ? item.status.replaceAll('_', ' ') : 'Status unavailable'}</Badge></div>
              <dl className="mt-3 space-y-2 text-sm leading-6"><div><dt className="inline text-muted-foreground">Outcome: </dt><dd className="inline whitespace-pre-wrap break-words">{item.outcome || 'Not recorded yet'}</dd></div><div><dt className="inline text-muted-foreground">Next action: </dt><dd className="inline whitespace-pre-wrap break-words">{item.nextAction || 'Not recorded'}</dd></div></dl>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
                {references.taskId && (worker ? <Button variant="link" className="h-auto p-0 text-xs" onClick={() => onSelectWorker(worker.id)}>Worker {references.taskId}<ArrowUpRight className="size-3" aria-hidden="true" /></Button> : <span className="break-all">Task {references.taskId} · worker unavailable</span>)}
                {references.runId && <span className="break-all">Run {references.runId}</span>}
                {references.ticketUrl && <TicketLink url={references.ticketUrl} />}
                {!references.taskId && !references.runId && !references.ticketUrl && <span>No linked work recorded</span>}
              </div>
            </li>;
          })}</ul> : <p className="mt-3 text-sm leading-6 text-muted-foreground">No commitments saved yet. Explicit requests and your manager's promises appear here as they are recorded.</p>}
        </section>
        <ScratchpadSection title="Notes" icon={FileText} items={scratchpad.notes || []} empty="No general notes saved." />
        <ScratchpadSection title="Decisions" icon={Scale} items={scratchpad.decisions || []} empty="No decisions saved." />
        <ScratchpadSection title="Open questions" icon={HelpCircle} items={scratchpad.questions || []} empty="No open questions saved." />
      </>}
    </div>
  </section>;
}
