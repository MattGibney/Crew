// Transport adapter for existing lifecycle scenarios. The generated executable
// speaks app-server JSON RPC; the scenario itself begins only at turn/start.
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
export function workerAppServerFixture(source) {
 const newline=source.indexOf('\n');
 return source.slice(0,newline+1)+`import {startWorkerFixture} from ${JSON.stringify(import.meta.url)};\nawait startWorkerFixture();\n`+source.slice(newline+1);
}
export async function startWorkerFixture() {
 const send=message=>process.stdout.write(JSON.stringify(message)+'\n');
 let threadId='fixture-thread',turnId='fixture-turn',completed=false,started=false,resolveStart;
 const ready=new Promise(resolve=>resolveStart=resolve);
 const originalExit=process.exit.bind(process);
 const complete=status=>{if(completed||!started)return;completed=true;send({method:'turn/completed',params:{threadId,turn:{id:turnId,status,items:[]}}});};
 process.exit=code=>{if(code===0)complete('interrupted');originalExit(code);};
 const lines=createInterface({input:process.stdin});
 lines.on('close',()=>originalExit(0));
 lines.on('line',line=>{
  const m=JSON.parse(line);if(m.id===undefined)return;let result={};
  if(m.method==='account/read')result={account:{type:'chatgpt'}};
  if(m.method==='config/read')result={config:{sandbox_mode:'read-only',approval_policy:'on-request'}};
  if(m.method==='thread/start'||m.method==='thread/resume'){
   const raw=process.argv.find(a=>a.startsWith('mcp_servers.local_orchestration.args='));
   const binding=raw?JSON.parse(raw.slice(raw.indexOf('=')+1)):[];
   threadId=m.params?.threadId||'thread-'+createHash('sha256').update(binding[1]||process.cwd()).digest('hex').slice(0,12)+'-'+(binding[3]||'fixture');
   if(m.method==='thread/resume')process.argv.push('resume',threadId);
   result={thread:{id:threadId}};
  }
  if(m.method==='turn/start'){
   started=true;process.argv.push((m.params.input||[]).filter(i=>i.type==='text').map(i=>i.text).join('\n'));
   result={turn:{id:turnId,status:'inProgress',items:[]}};
   send({id:m.id,result});resolveStart();return;
  }
  send({id:m.id,result});
  if(m.method==='turn/interrupt'){
   if(process.listenerCount('fixtureInterrupt'))process.emit('fixtureInterrupt');
   else complete('interrupted');
  }
 });
 const log=console.log.bind(console);
 console.log=(...args)=>{
  let event;try{event=JSON.parse(args[0]);}catch{return log(...args);}
  if(event.type==='thread.started')return;
  if(event.type==='turn.completed')return complete('completed');
  if(event.type==='item.completed'){
   const old=event.item;
   const item=old.type==='command_execution'?{type:'commandExecution',command:old.command,exitCode:old.exit_code,aggregatedOutput:old.aggregated_output}:{type:'agentMessage',text:old.text};
   send({method:'item/completed',params:{threadId,turnId,item}});return;
  }
  log(...args);
 };
 await ready;
}
