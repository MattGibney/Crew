import { Square } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ApprovalForm } from './ApprovalForm.jsx';

export function WorkChat({ work, notice, onAnswer, onStop }) {
  const approvals = work.approvals || [], connectors = work.connectors || [], items = work.items || [], messages = work.messages || [];
  const connection = work.connectorError ? `Tool discovery: ${work.connectorError}` : connectors.length ? `MCP discovery: ${connectors.filter(server => server.status === 'connected').length} servers connected; ${connectors.filter(server => server.status !== 'connected').length} unavailable or disabled. Individual tool calls are verified below.` : 'Checking configured MCP tools…';
  return <section aria-label="Backing work chat"><Card>
    <CardHeader><CardTitle>Codex work chat</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      <p id="work-status" role="status" aria-live="polite">{approvals.length ? 'Codex needs your answer below.' : work.activeTurnId ? 'Codex is working. You can keep talking.' : `Codex: ${work.status}.`}</p>
      <p id="chat-reference" className="break-all text-sm text-muted-foreground">{work.threadId ? `Same backing chat: ${work.threadId}` : 'Preparing a saved Codex chat…'}</p>
      <p id="connectors" className="text-sm text-muted-foreground">{connection}</p>
      {notice && <Alert id="work-notice" role="alert"><AlertDescription>{notice}</AlertDescription></Alert>}
      <Button id="stop-work" type="button" variant="outline" disabled={!work.activeTurnId} onClick={() => void onStop()}><Square aria-hidden="true" />Stop manager work</Button>
      <div id="approvals" className="space-y-4">{approvals.map(request => <ApprovalForm key={request.id} request={request} workItems={items} onAnswer={onAnswer} />)}</div>
      <ul id="work-log" aria-label="Actual backend tool activity" className="space-y-1 break-words text-sm text-muted-foreground">{items.slice(-6).map((item, index) => <li key={`${item.id || index}-${item.type}`}>{item.type === 'mcpToolCall' ? 'MCP' : item.type === 'commandExecution' ? 'Command' : 'Files'}: {item.name} — {item.status}{item.exitCode != null ? ` (exit ${item.exitCode})` : ''}</li>)}</ul>
      <div id="work-result" className="space-y-3 whitespace-pre-wrap break-words text-sm">{messages.filter(message => message.phase !== 'commentary').slice(-2).map((message, index) => <p key={message.id || index}>{message.text}</p>)}</div>
    </CardContent>
  </Card></section>;
}
