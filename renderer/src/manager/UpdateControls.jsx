import {useEffect,useRef,useState} from 'react';
import {ArrowDownToLine,Check,Download,LoaderCircle,RefreshCw,X} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Badge} from '@/components/ui/badge';
import {api,errorText} from './api.js';

export function UpdateControls({liveStatus}){
 const [status,setStatus]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[open,setOpen]=useState(false);
 const busyRef=useRef(false),panel=useRef(null);
 useEffect(()=>{if(liveStatus)setStatus(liveStatus);},[liveStatus]);
 const request=async(action='status')=>{
  if(busyRef.current)return;busyRef.current=true;setBusy(true);setError('');
  try{setStatus(await api('updates',{action}));}catch(cause){setError(errorText(cause));}finally{busyRef.current=false;setBusy(false);}
 };
 useEffect(()=>{void request();},[]);
 useEffect(()=>{if(!open)return;void request();const timer=setInterval(()=>void request(),10000);const close=event=>{if(event.key==='Escape')setOpen(false);};window.addEventListener('keydown',close);return()=>{clearInterval(timer);window.removeEventListener('keydown',close);};},[open]);
 const phase=status?.phase,available=['available','downloading','downloaded'].includes(phase);
 const messages={idle:'Check for a newer Crew release.',checking:'Checking GitHub Releases…',current:'Crew is up to date.',available:`Crew ${status?.availableVersion} is available.`,downloading:`Downloading${status?.downloadPercent==null?'…':` ${Math.round(status.downloadPercent)}%…`}`,downloaded:`Crew ${status?.availableVersion} is ready to install.`,installing:'Restarting Crew to install the update…',error:'The update could not be retrieved.',unavailable:'Updates are managed by the installed desktop app.'};
 return <div className="relative" ref={panel}>
  <Button id="updates-button" type="button" variant="ghost" size="sm" aria-label={available?'Crew update available':'Crew updates'} aria-expanded={open} aria-controls="updates-panel" onClick={()=>setOpen(value=>!value)}><ArrowDownToLine aria-hidden="true"/><span className="hidden sm:inline">Updates</span>{available&&<span className="size-1.5 rounded-full bg-primary" aria-label="Update available"/>}</Button>
  {open&&<section id="updates-panel" aria-label="Crew updates" className="absolute right-0 top-full z-50 mt-2 w-[min(340px,calc(100vw-2rem))] space-y-4 rounded-xl border bg-popover p-4 text-sm text-popover-foreground shadow-lg">
   <div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2"><h2 className="font-semibold">Crew updates</h2>{status?.currentVersion&&<Badge variant="secondary">{status.currentVersion}</Badge>}</div><Button type="button" variant="ghost" size="icon-sm" aria-label="Close updates" onClick={()=>setOpen(false)}><X aria-hidden="true"/></Button></div>
   <p role="status" aria-live="polite" className="leading-relaxed">{messages[phase]||'Loading update status…'}</p>
   {(error||status?.error)&&<p role="alert" className="break-words text-destructive">{error||status.error}</p>}
   {phase==='downloading'&&status?.downloadPercent!=null&&<progress aria-label="Update download" value={status.downloadPercent} max="100" className="h-2 w-full accent-primary"/>}
   {phase==='downloaded'&&status.installBlocked&&<div className="space-y-1 text-xs leading-relaxed text-muted-foreground">{status.reasons?.map(reason=><p key={reason}>{reason}</p>)}</div>}
   {phase==='downloaded'&&status.notices?.length>0&&<div className="space-y-1 text-xs leading-relaxed text-muted-foreground">{status.notices.map(notice=><p key={notice}>{notice}</p>)}</div>}
   <div className="flex flex-wrap gap-2">
    {status?.supported&&<Button type="button" variant="outline" size="sm" disabled={busy||['checking','downloading','installing'].includes(phase)} onClick={()=>void request('check')}>{busy?<LoaderCircle className="animate-spin" aria-hidden="true"/>:<RefreshCw aria-hidden="true"/>}Check for updates</Button>}
    {phase==='available'&&<Button type="button" size="sm" disabled={busy} onClick={()=>void request('download')}><Download aria-hidden="true"/>Download update</Button>}
    {phase==='downloaded'&&<Button id="restart-update" type="button" size="sm" disabled={busy||status.installBlocked} onClick={()=>void request('restart')}><Check aria-hidden="true"/>Restart to update</Button>}
    {(phase==='downloaded'&&status.installBlocked)&&<Button type="button" variant="ghost" size="sm" disabled={busy} onClick={()=>void request()}>Refresh readiness</Button>}
   </div>
   <p className="text-xs leading-relaxed text-muted-foreground">Updates never restart Crew while a conversation, worker or project environment is active. Your local settings and work history stay on this Mac.</p>
   <a href="https://github.com/MattGibney/crew/releases/latest" target="_blank" rel="noopener noreferrer" className="inline-block text-xs text-primary underline underline-offset-4">View releases on GitHub</a>
  </section>}
 </div>;
}
