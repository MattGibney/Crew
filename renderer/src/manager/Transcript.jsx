import { AudioLines } from 'lucide-react';
export function Transcript({ items }) {
  return <section aria-label="Voice transcript" className="space-y-4 rounded-xl border bg-muted/20 p-4"><h2 className="flex items-center gap-2 text-xs font-medium text-muted-foreground"><AudioLines className="size-3.5" aria-hidden="true" />This call · voice transcript</h2><div id="transcript" className="space-y-4 whitespace-pre-wrap break-words text-sm leading-6">{items.map(item => <div key={item.id} data-part="true"><p className="mb-1 text-xs font-medium text-muted-foreground">{item.role === 'user' ? 'You' : 'Manager'}</p><p>{item.text}</p></div>)}</div></section>;
}
