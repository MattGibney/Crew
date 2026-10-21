import { useEffect, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
export function Transcript({ items }) {
  const scrollRef = useRef(null);
  useEffect(() => { const node = scrollRef.current; if (node) node.scrollTop = node.scrollHeight; }, [items]);
  return <section aria-label="Conversation transcript"><Card>
    <CardHeader><CardTitle>Conversation</CardTitle></CardHeader>
    <CardContent><div id="transcript" ref={scrollRef} className="min-h-24 max-h-72 space-y-3 overflow-auto whitespace-pre-wrap break-words text-sm">
      {!items.length ? <p className="text-muted-foreground">Your transcript will appear here during the session.</p> : items.map(item => <p key={item.id} data-part="true"><strong>{item.role === 'user' ? 'You' : 'Codex'}: </strong>{item.text}</p>)}
    </div></CardContent>
  </Card></section>;
}
