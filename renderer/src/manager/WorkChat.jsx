import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronDown, Command, LoaderCircle, MessageSquare, ShieldCheck, Square, Wrench } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ApprovalForm } from './ApprovalForm.jsx';
import { Transcript } from './Transcript.jsx';
import { orderedMessages } from './conversation.js';
import { projectDraftStorage, readDraft, writeDraft } from './draft-storage.js';
import crewMark from '../../../build/crew-mark.png';

function Message({ message }) {
  const user = message.role === 'user';
  return <article aria-label={user ? 'Your message' : 'Manager message'} className={`flex gap-3 ${user ? 'justify-end' : ''}`}>
    {!user && <img src={crewMark} alt="" className="mt-1 size-6 shrink-0" />}
    <div className={`min-w-0 max-w-full ${user ? 'rounded-2xl bg-muted px-4 py-3 sm:max-w-[85%]' : 'flex-1 pt-0.5'}`}>
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">{user ? 'You' : message.phase === 'commentary' ? 'Manager · progress' : 'Manager'}</p>
      <div className={`break-words text-sm leading-7 [&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1 [&_h1]:my-3 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:my-3 [&_h2]:font-semibold [&_h3]:my-2 [&_h3]:font-medium [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3 [&_code]:text-xs [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_table]:w-full [&_th]:border-b [&_th]:p-2 [&_th]:text-left [&_td]:border-b [&_td]:p-2 ${message.phase === 'commentary' ? 'text-muted-foreground' : ''}`}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-4">{children}</a>, img: ({ alt }) => <span className="text-muted-foreground">{alt || 'Image'}</span>, table: ({ children }) => <div className="overflow-auto"><table>{children}</table></div> }}>{message.text || ''}</ReactMarkdown>
      </div>
    </div>
  </article>;
}

export function WorkChat({ manager, children }) {
  const { work, workNotice: notice, prepared, eventReady, sending } = manager;
  const approvals = work.approvals || [], connectors = work.connectors || [], items = work.items || [];
  const messages = orderedMessages(work.messages);
  const [draft, setDraftState] = useState(() => readDraft(projectDraftStorage()));
  const draftRef = useRef(draft);
  const setDraft = value => {
    const next = typeof value === 'function' ? value(draftRef.current) : value;
    draftRef.current = next;
    writeDraft(projectDraftStorage(), next);
    setDraftState(next);
  };
  const [sendError, setSendError] = useState('');
  const scrollRef = useRef(null), nearBottom = useRef(true), inputRef = useRef(null), submitLock = useRef(false);
  const [scrolledUp, setScrolledUp] = useState(false);
  const busy = Boolean(work.activeTurnId) || sending;
  const ready = manager.managerEnabled && prepared && eventReady && !busy;
  const toBottom = () => { const node = scrollRef.current; if (node) node.scrollTop = node.scrollHeight; nearBottom.current = true; setScrolledUp(false); };
  useEffect(() => { if (nearBottom.current) toBottom(); }, [work.messages, manager.transcript, work.approvals, work.items, manager.workerApprovals]);
  const submit = async event => {
    event.preventDefault();
    const submittedDraft = draft, text = submittedDraft.trim();
    if (!text || !ready || submitLock.current) return;
    submitLock.current = true; setSendError('');
    try { await manager.sendMessage(text); setDraft(current => current === submittedDraft ? '' : current); nearBottom.current = true; inputRef.current?.focus(); }
    catch (failure) { setSendError(failure.message || 'Message was not sent. Your text is kept here; try again.'); }
    finally { submitLock.current = false; }
  };
  return <div className="relative flex min-h-0 flex-1 flex-col">
    <div ref={scrollRef} onScroll={() => { const node = scrollRef.current; nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; setScrolledUp(!nearBottom.current); }} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-6 sm:px-7 lg:min-h-0" aria-label="Manager conversation">
      <div className="mx-auto max-w-3xl space-y-6">
        {(manager.projectInfo?.readiness?.ready === false || (!manager.projectInfo && manager.project.startsWith('Project configuration unavailable'))) && <Alert role="alert"><AlertDescription className="break-words">{manager.project}<p className="mt-2">Open Set up Crew in the app menu to review your project. You can still discuss setup with your manager.</p></AlertDescription></Alert>}
        {!manager.managerEnabled && <Alert><AlertDescription>Your manager is {manager.managerLifecycle.state === 'stopped' ? 'stopped' : 'unavailable while its state is checked'}. Open Settings to start or restart it. Your conversation and worker history stay here.</AlertDescription></Alert>}
        {manager.soundUnavailable && <p role="status" className="text-xs text-muted-foreground">Sound is unavailable. Click or press a key in Crew to enable future cues; requests remain visible here.</p>}
        {manager.error && <Alert variant="destructive" id="error" role="alert"><AlertDescription className="space-y-3 break-words"><p>{manager.error}</p>{!prepared && <Button type="button" variant="outline" onClick={() => void manager.retryConnection()}>Retry connection</Button>}</AlertDescription></Alert>}
        {!messages.length && !manager.transcript.length && !approvals.length && !manager.workerApprovals?.length && <div className="flex min-h-64 flex-col items-center justify-center px-2 py-10 text-center"><div className="mb-5 flex size-12 items-center justify-center rounded-2xl border bg-background"><MessageSquare className="size-5 text-primary" aria-hidden="true" /></div><h2 className="text-2xl font-semibold tracking-tight">What are we working on?</h2><p className="mt-3 max-w-sm text-sm leading-6 text-muted-foreground">Talk through an idea, review progress, or agree on a task. Your manager brings in workers when you ask.</p><div className="mt-6 flex flex-wrap justify-center gap-2">{['What is the current project status?', 'Help me plan a task'].map(text => <Button key={text} variant="outline" className="h-auto whitespace-normal py-2 text-xs" onClick={() => { setDraft(text); inputRef.current?.focus(); }}>{text}</Button>)}</div></div>}
        <div id="work-result" className="space-y-6">{messages.map(message => <Message key={message.id} message={message} />)}</div>
        {manager.transcript.length > 0 && <Transcript items={manager.transcript} />}
        {busy && <p id="work-status" role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />{approvals.length ? 'Waiting for your answer below' : sending ? 'Sending your message…' : 'Your manager is working…'}</p>}
        <div id="approvals" className="space-y-3">{approvals.map(request => <ApprovalForm key={request.id} request={request} workItems={items} onAnswer={manager.answerApproval} />)}</div>
        <div id="worker-approvals" className="space-y-3">{(manager.workerApprovals || []).map(request => {
          const task = manager.orchestration.tasks?.find(task => task.id === request.taskId);
          return <section key={request.approvalId} aria-label={`Worker approval ${task?.ticket || request.taskId}`} className="space-y-2">
            <p className="text-sm font-medium">Worker · {task?.ticket || request.taskId}</p>
            {task?.brief && <p className="line-clamp-2 text-xs text-muted-foreground">{task.brief}</p>}
            <ApprovalForm request={{ ...request, id: request.approvalId }} workItems={[]} onAnswer={(_id, response) => manager.answerWorkerApproval(request, response)} />
          </section>;
        })}</div>
        {(notice || sendError) && <Alert id="work-notice" role="alert"><AlertDescription className="break-words">{sendError || notice}</AlertDescription></Alert>}
        {items.length > 0 && <details className="rounded-lg border px-3 py-2"><summary className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground"><Wrench className="size-3.5" aria-hidden="true" />Tool activity <span className="ml-auto">{items.length}</span><ChevronDown className="size-3" /></summary><ul id="work-log" className="space-y-2 pt-3 text-xs text-muted-foreground" aria-label="Actual backend tool activity">{items.map((item, index) => <li key={item.id || index} className="flex items-start gap-2">{item.status === 'completed' ? <Check className="mt-0.5 size-3 shrink-0" /> : <Command className="mt-0.5 size-3 shrink-0" />}<span className="min-w-0 break-all">{item.name} <span className="text-foreground">· {item.status}</span>{item.exitCode != null ? ` · exit ${item.exitCode}` : ''}</span></li>)}</ul></details>}
      </div>
    </div>
    {scrolledUp && <Button variant="outline" className="absolute bottom-72 left-1/2 z-10 -translate-x-1/2 rounded-full shadow-sm" onClick={toBottom}><ArrowDown />Latest messages</Button>}
    <div className="shrink-0 space-y-3 border-t bg-background px-5 pb-4 pt-3 sm:px-7">
      <div className="mx-auto max-w-3xl space-y-3">{children}
        <form onSubmit={submit} className="rounded-xl border bg-background p-2 shadow-sm focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
          <label htmlFor="message-input" className="sr-only">Message your manager</label>
          <Textarea ref={inputRef} id="message-input" placeholder="Message your manager…" value={draft} maxLength={8000} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (ready) void submit(event); } }} className="min-h-14 max-h-40 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0" />
          <div className="flex items-center justify-between gap-2 px-1"><p className="text-[11px] text-muted-foreground">{!manager.managerEnabled ? 'Manager is stopped or unavailable. Open Settings to start it. Your draft is kept.' : !prepared ? 'Preparing your manager…' : !eventReady ? 'Waiting for connection…' : busy ? 'You can draft your next message while work continues.' : 'Enter to send · Shift Enter for a new line'}</p>{busy ? <Button id="stop-work" type="button" variant="outline" size="sm" disabled={!work.activeTurnId} onClick={() => void manager.interruptManager()}><Square className="size-3" />Stop current turn</Button> : <Button id="send-message" type="submit" size="icon" aria-label="Send message" disabled={!ready || !draft.trim()}><ArrowUp /></Button>}</div>
        </form>
        <details className="text-xs text-muted-foreground"><summary className="flex w-fit cursor-pointer items-center gap-1.5"><ShieldCheck className="size-3.5" aria-hidden="true" />Local workspace · ChatGPT subscription<ChevronDown className="size-3" /></summary><div className="space-y-2 pb-1 pt-3 leading-5"><p id="account">{manager.account}</p><p id="connectors">{work.connectorError || `${connectors.filter(server => server.status === 'connected').length} tool connections available. Individual access is verified when used.`}</p><p>Workers keep running when you close this window. Stop current turn interrupts this conversation’s current work. Use Settings to stop the manager session, or a worker’s actions to stop that worker.</p><p id="chat-reference" className="break-all">Saved conversation: {work.threadId || 'Preparing…'}</p></div></details>
      </div>
    </div>
  </div>;
}
