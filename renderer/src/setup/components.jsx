import { createContext, useContext } from 'react';
import { AlertCircle, CheckCircle2, CircleHelp, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardHeader, CardContent, CardDescription } from '@/components/ui/card';
import { readableDetail } from './model.js';

export const BusyContext = createContext(false);
export function SetupButton({ allowDuringBusy = false, disabled, variant = 'outline', children, ...props }) {
  const busy = useContext(BusyContext);
  return <Button type="button" variant={variant} disabled={disabled || (busy && !allowDuringBusy)} {...props}>{children}</Button>;
}
export function Select({ disabled, children, ...props }) {
  const busy = useContext(BusyContext);
  return <NativeSelect className="w-full" disabled={disabled || busy} {...props}>{children}</NativeSelect>;
}
export function Field({ id, label, value, onChange, hint, multiline = false, ...props }) {
  const busy = useContext(BusyContext);
  const Control = multiline ? Textarea : Input;
  return <div className="space-y-2"><Label htmlFor={id}>{label}</Label><Control id={id} value={value ?? ''} onChange={event => onChange(event.target.value)} disabled={busy} aria-describedby={hint ? `${id}-hint` : undefined} className={multiline ? 'min-h-32' : undefined} {...props} />{hint && <Hint id={`${id}-hint`}>{hint}</Hint>}</div>;
}
export function Hint({ children, className = '', ...props }) {
  return <p className={`text-sm leading-relaxed text-muted-foreground ${className}`} {...props}>{children}</p>;
}
export function Actions({ children, ...props }) { return <div className="flex flex-wrap items-center gap-2" {...props}>{children}</div>; }
export function Panel({ title, description, children, id, ...props }) {
  return <Card id={id} {...props}><CardHeader><h2 className="text-xl font-semibold tracking-tight">{title}</h2>{description && <CardDescription className="leading-relaxed">{description}</CardDescription>}</CardHeader><CardContent className="space-y-6">{children}</CardContent></Card>;
}
export function Status({ name, value = { status: 'unknown', detail: 'Not checked.' } }) {
  const status = value?.status || 'unknown';
  const verified = ['verified', 'configured', 'granted', 'running'].includes(status);
  const failed = ['unavailable', 'invalid', 'denied', 'blocked', 'failed'].includes(status);
  const Icon = verified ? CheckCircle2 : failed ? AlertCircle : status === 'checking' ? LoaderCircle : CircleHelp;
  return <div className="status flex gap-3 rounded-lg border border-border bg-muted/30 p-3" data-status={status}><Icon aria-hidden="true" className={`mt-0.5 size-4 shrink-0 ${failed ? 'text-destructive' : 'text-muted-foreground'}`} /><div className="min-w-0 flex-1 space-y-1"><div className="flex flex-wrap items-center justify-between gap-2"><strong className="font-medium">{name}</strong><Badge variant={failed ? 'destructive' : 'secondary'}>{status}</Badge></div><p className="break-words text-sm leading-relaxed text-muted-foreground">{readableDetail(value?.detail)}</p></div></div>;
}
export function CheckList({ snapshot, entries, id }) {
  return <div id={id} className="space-y-2">{entries.map(([key, name]) => <Status key={key} name={name} value={snapshot?.checks?.[key]} />)}</div>;
}
export function ToolsCheck({ snapshot }) {
  const tools = snapshot?.checks?.tools;
  const authLabels = { unsupported: 'No standard auth status reported', notLoggedIn: 'Sign-in not reported', bearerToken: 'Authentication managed by Codex', oAuth: 'Authentication managed by Codex' };
  return <div id="tools-result" className="space-y-2"><Status name="Connected tools" value={tools} />{tools?.linear && <Status name="Linear read tools" value={tools.linear} />}{tools?.servers?.length > 0 && <details className="space-y-3 rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm font-medium">Inspect {tools.servers.length} connected-tool entries</summary><div className="space-y-2 pt-3">{tools.servers.map((server, index) => <Status key={`${server.name}-${index}`} name={server.name} value={{ status: server.tools.length ? 'advertised' : server.status, detail: `${authLabels[server.auth] || server.auth}; ${server.tools.length} tools advertised. Access is not yet verified.` }} />)}</div></details>}</div>;
}
