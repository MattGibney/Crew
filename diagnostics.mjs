// Bounded, best-effort redaction for project command diagnostics. Never write raw output.
export const DIAGNOSTIC_LIMIT=8192;
const LINE_LIMIT=16384;
export function sanitizeDiagnosticLine(value){
 let text=String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'');
 // Environment/JSON credential assignments are omitted for the remainder of the line.
 text=text.replace(/((?:["']?[\w.-]*(?:password|passwd|secret|token|api[_-]?key|credential|authorization|private[_-]?key|access[_-]?key)[\w.-]*["']?)\s*[:=]\s*).*/ig,'$1[redacted]');
 text=text.replace(/(^|\s)((?:export\s+)?[A-Z_][A-Z0-9_]{1,80}\s*=\s*).*/g,'$1$2[redacted]');
 text=text.replace(/((?:["']?_?auth["']?)\s*[:=]\s*).*/ig,'$1[redacted]');
 text=text.replace(/\bBearer\s+\S+/ig,'Bearer [redacted]').replace(/\b(?:sk-[A-Za-z0-9_-]+|(?:AKIA|ASIA)[A-Z0-9]{16})\b/g,'[redacted]');
 text=text.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g,'[redacted JWT]');
 text=text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/ig,raw=>{try{const url=new URL(raw);url.username='';url.password='';url.search='';url.hash='';return url.toString();}catch{return '[redacted URL]';}});
 // Long opaque strings can be unlabeled credentials. Suppress rather than guess their origin.
 return text.replace(/[A-Za-z0-9_~+/=-]{32,}/g,'[redacted opaque value]');
}
export function createDiagnosticsRecorder(){
 const pending=new Map(),discarding=new Set(),privateBlock=new Set(),tails={stdout:'',stderr:''};let truncated=false;
 const streamLimit=DIAGNOSTIC_LIMIT/2;
 function retain(channel,line){
  if(/-----BEGIN .*PRIVATE KEY-----/.test(line)){privateBlock.add(channel);line='[private key block omitted]';}
  else if(privateBlock.has(channel)){if(/-----END .*PRIVATE KEY-----/.test(line))privateBlock.delete(channel);return;}
  const safe=`[${channel}] ${sanitizeDiagnosticLine(line)}\n`;
  tails[channel]+=safe;while(Buffer.byteLength(tails[channel],'utf8')>streamLimit){truncated=true;const cut=tails[channel].indexOf('\n');tails[channel]=cut<0||cut===tails[channel].length-1?'[diagnostic line omitted: size limit]\n':tails[channel].slice(cut+1);}
 }
 return{
  push(channel,chunk){
   channel=channel==='stderr'?'stderr':'stdout';
   const input=String(chunk),pieces=input.split('\n');let current=pending.get(channel)||'';
   for(let i=0;i<pieces.length;i++){
    if(!discarding.has(channel)){current+=pieces[i];if(current.length>LINE_LIMIT){current='';discarding.add(channel);truncated=true;}}
    if(i<pieces.length-1){if(discarding.has(channel)){retain(channel,'[output line omitted: size limit]');discarding.delete(channel);}else retain(channel,current);current='';}
   }pending.set(channel,current);
  },
  snapshot(){return{text:tails.stdout+tails.stderr,sanitized:true,complete:false,truncated,limit:DIAGNOSTIC_LIMIT,perStreamLimit:streamLimit,notice:'Independent stdout/stderr tails with best-effort redaction; inter-stream chronology is not preserved; not a complete output or confidentiality guarantee.'};},
  finish(){for(const [channel,line]of pending){if(discarding.has(channel))retain(channel,'[output line omitted: size limit]');else if(line)retain(channel,line);}pending.clear();discarding.clear();return this.snapshot();}
 };
}
