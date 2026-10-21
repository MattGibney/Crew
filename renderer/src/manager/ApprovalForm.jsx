import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { connectorVerificationURL } from './state.js';

export function ApprovalForm({ request, workItems, onAnswer }) {
  const fieldPrefix = useId();
  const [answers, setAnswers] = useState({}), [others, setOthers] = useState({}), [sending, setSending] = useState(false);
  const params = request.params || {};
  const submit = async response => { if (sending) return; setSending(true); try { await onAnswer(request.id, response); } finally { setSending(false); } };
  const choice = (label, response) => <Button key={label} type="button" variant="outline" disabled={sending} onClick={() => void submit(response)}>{label}</Button>;
  const userInput = request.method === 'item/tool/requestUserInput';
  const elicitation = request.method === 'mcpServer/elicitation/request';
  const emptyApproval = params.mode === 'form' && params._meta?.codex_approval_kind === 'mcp_tool_call' && Object.keys(params.requestedSchema?.properties || {}).length === 0;
  const verificationURL = params.mode === 'url' ? connectorVerificationURL(params.url) : null;
  const changes = workItems.find(item => item.id === params.itemId)?.changes;
  const preview = params.command ? `${params.command}\nWorking directory: ${params.cwd || ''}` : JSON.stringify(changes || params.permissions || params.networkApprovalContext || params, null, 2);
  return <form className="approval space-y-3 rounded-lg border border-border bg-muted/30 p-4" data-id={request.id} onSubmit={event => {
    event.preventDefault();
    if (userInput) void submit({ answers: Object.fromEntries((params.questions || []).map(question => [question.id, others[question.id] || answers[question.id] || ''])) });
  }}>
    <strong>Codex needs your input</strong>
    <p className="text-sm text-muted-foreground">{params.reason || params.message || 'Review this request before proceeding.'}</p>
    {userInput ? <>
      {(params.questions || []).map(question => {
        const id = `${fieldPrefix}-${question.id}`;
        return <div key={question.id} className="space-y-2">
          <Label htmlFor={id}>{question.question}</Label>
          {question.options?.length ? <NativeSelect id={id} className="w-full" required={!question.isOther} value={answers[question.id] || ''} onChange={event => setAnswers(previous => ({ ...previous, [question.id]: event.target.value }))}>
            <option value="">Choose an answer</option>
            {question.options.map(option => <option key={option.label} value={option.label}>{option.label}{option.description ? ` — ${option.description}` : ''}</option>)}
          </NativeSelect> : <Input id={id} type={question.isSecret ? 'password' : 'text'} required={!question.isOther} value={answers[question.id] || ''} onChange={event => setAnswers(previous => ({ ...previous, [question.id]: event.target.value }))} />}
          {question.isOther && <><Label htmlFor={`${id}-other`} className="text-muted-foreground">Or enter another answer</Label><Input id={`${id}-other`} type={question.isSecret ? 'password' : 'text'} value={others[question.id] || ''} onChange={event => setOthers(previous => ({ ...previous, [question.id]: event.target.value }))} /></>}
        </div>;
      })}
      <Button type="submit" disabled={sending}>Send answer</Button>
    </> : elicitation ? <>
      {emptyApproval ? <><pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">{JSON.stringify(params._meta.tool_params, null, 2)}</pre><div className="flex flex-wrap gap-2">{choice('Allow once', { action: 'accept' })}{choice('Decline', { action: 'decline' })}</div></>
        : verificationURL ? <><a className="block underline underline-offset-4" href={verificationURL} target="_blank" rel="noopener noreferrer">Open connector verification</a>{choice('I completed verification', { action: 'accept' })}</>
          : <p className="text-sm text-muted-foreground">This connector requested a form this client cannot render. Cancel it and use the normal Codex client for that flow.</p>}
      <div>{choice('Cancel connector request', { action: 'cancel' })}</div>
    </> : <>
      <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">{preview}</pre>
      <div className="flex flex-wrap gap-2">
        {(!params.availableDecisions || params.availableDecisions.includes('accept')) && choice('Allow once', { decision: 'accept' })}
        {(!params.availableDecisions || params.availableDecisions.includes('decline')) ? choice('Decline', { decision: 'decline' }) : params.availableDecisions.includes('cancel') ? choice('Cancel', { decision: 'cancel' }) : null}
      </div>
    </>}
  </form>;
}
