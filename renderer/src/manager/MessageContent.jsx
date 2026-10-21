import { copyText } from './clipboard.js';
import { Children, isValidElement, useEffect, useRef, useState } from 'react';
import { Check, Copy, ImageOff } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function CodeBlock({ children }) {
  const code = Children.toArray(children).find(isValidElement);
  const text = String(code?.props.children ?? '');
  const language = /language-([^\s]+)/.exec(code?.props.className || '')?.[1];
  const [status, setStatus] = useState('');
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try { await copyText(text); setStatus('Copied'); }
    catch { setStatus('Could not copy'); }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus(''), 2000);
  };
  return <div className="my-4 min-w-0 overflow-hidden rounded-xl border bg-muted/40" data-slot="message-code-block">
    <div className="flex items-center justify-between gap-3 border-b px-3 py-2 text-xs text-muted-foreground">
      <span className="truncate font-mono">{language || 'Code'}</span>
      <div className="flex shrink-0 items-center gap-2"><span role="status" className="text-xs">{status}</span><Button type="button" variant="ghost" size="sm" aria-label={status === 'Copied' ? 'Code copied' : 'Copy code'} className="h-6 text-xs" onClick={() => void copy()}>{status === 'Copied' ? <Check /> : <Copy />}Copy</Button></div>
    </div>
    <pre className="m-0 max-w-full overflow-x-auto p-4 text-xs leading-6" tabIndex={0} aria-label={`${language || 'Plain text'} code block`}><code className={code?.props.className}>{text}</code></pre>
  </div>;
}

export function MessageImage({ src, alt, title }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) return <span className="my-3 flex items-center gap-2 rounded-lg border border-dashed p-4 text-xs text-muted-foreground" role="img" aria-label={alt ? `Image unavailable: ${alt}` : 'Image unavailable'}><ImageOff className="size-4 shrink-0" aria-hidden="true" /><span>Image unavailable{alt ? ` · ${alt}` : ''}</span></span>;
  return <img src={src} alt={alt || ''} title={title} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="my-4 block h-auto max-h-96 max-w-full rounded-xl border bg-muted/20 object-contain" />;
}
