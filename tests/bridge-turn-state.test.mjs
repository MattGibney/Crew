// A real child JSON-RPC peer exercises bridge ordering; no Codex/network/mic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,appendFile,readFile,rm,chmod,mkdir,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createBridge} from '../codex-bridge.mjs';
import {updateActivity} from '../update-activity.mjs';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate){const deadline=Date.now()+4000;while(Date.now()<deadline){if(await predicate())return;await delay(10);}throw new Error('Synthetic protocol condition did not arrive.');}
async function fixture(t,{history=[],saved=false,threadDelay=0,voiceStopFails=false,exitOnEOF=false,projectScoped=false,configuredInstructions=null}={}){
 const directory=await mkdtemp(join(tmpdir(),'crew-turn-state-')),statePath=join(directory,'manager.json'),control=join(directory,'notifications.jsonl'),calls=join(directory,'calls.jsonl'),executable=join(directory,'fake-codex.mjs');
 await writeFile(control,'');await writeFile(calls,'');if(saved)await writeFile(statePath,JSON.stringify({threadId:'manager-thread'}));
 const program=`#!${process.execPath}
import {createInterface} from 'node:readline';
import {readFileSync,appendFileSync} from 'node:fs';
const control=${JSON.stringify(control)},calls=${JSON.stringify(calls)},history=${JSON.stringify(history)};let sequence=0,seen=0;
process.stdin.on('end',()=>{if(${exitOnEOF})process.exit(0)});process.on('SIGTERM',()=>{appendFileSync(calls,JSON.stringify({signal:'SIGTERM'})+'\\n');process.exit(0)});
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const reply=(id,result)=>send({id,result});
const notify=(method,params)=>send({method,params:{threadId:'manager-thread',...params}});
setInterval(()=>{const lines=readFileSync(control,'utf8').split('\\n').filter(Boolean);for(const line of lines.slice(seen))send(JSON.parse(line));seen=lines.length;},10);
createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line);if(message.id===undefined)return;
 appendFileSync(calls,JSON.stringify({...message,processCwd:process.cwd(),processArgs:process.argv.slice(2)})+'\\n');const {id,method,params}=message;
 if(method==='initialize')return reply(id,{});
 if(method==='account/read')return reply(id,{account:{type:'chatgpt',planType:'synthetic'}});
 if(method==='config/read')return reply(id,{config:{developer_instructions:${JSON.stringify(configuredInstructions)}}});
 if(method==='thread/start'||method==='thread/resume')return setTimeout(()=>reply(id,{thread:{id:'manager-thread'}}),${threadDelay});
 if(method==='thread/name/set')return reply(id,{});
 if(method==='thread/turns/list')return reply(id,{data:history});
 if(method==='mcpServerStatus/list')return reply(id,{data:[]});
 if(method==='thread/realtime/listVoices')return reply(id,{voices:{v3:['cove'],defaultV1:'cove'}});
 if(method==='thread/realtime/start'){notify('thread/realtime/started',{});notify('thread/realtime/sdp',{sdp:'v=0 fixture'});return reply(id,{});}
 if(method==='thread/realtime/stop'&&${voiceStopFails})return send({id,error:{message:'fixture stop unavailable'}});
 if(method==='turn/start'){
  const turn={id:'turn-'+(++sequence),status:'inProgress',items:[]},text=params.input[0].text;
  if(text==='rpc-first')return reply(id,{turn});
  notify('turn/started',{turn});
  if(text==='completion-first'){notify('turn/completed',{turn:{...turn,status:'completed'}});return reply(id,{turn});}
  reply(id,{turn});
  if(text==='complete')setTimeout(()=>notify('turn/completed',{turn:{...turn,status:'completed'}}),15);
  return;
 }
 if(method==='turn/interrupt'){notify('turn/completed',{turn:{id:params.turnId,status:'interrupted',items:[]}});return reply(id,{});}
 return reply(id,{});
});
`;
 await writeFile(executable,program,{mode:0o700});await chmod(executable,0o700);
 const repository=join(directory,'project-repository'),orchestrationDir=join(directory,'orchestration'),runtimeProjectPath=join(directory,'runtime.json');if(projectScoped)await mkdir(repository);
 const project=projectScoped?{id:'scoped-project',name:'Scoped',repositories:[{id:'app',path:repository}]}:undefined;
 const events=[],bridge=createBridge({cwd:directory,statePath,executable,...(projectScoped?{project,orchestrationDir,runtimeProjectPath}:{}),onEvent:event=>events.push(event)});
 t.after(async()=>{await bridge.shutdown();await rm(directory,{recursive:true,force:true});});
 return {bridge,events,directory,repository,orchestrationDir,runtimeProjectPath,notify:async(method,params)=>appendFile(control,JSON.stringify({method,params:{threadId:'manager-thread',...params}})+'\n'),calls:async()=>((await readFile(calls,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line)))};
}
const canUpdate=bridge=>updateActivity({work:bridge.state(),view:{tasks:[]}}).safe;

test('actual turn/start → completed leaves native terminal state positively idle for updates',async t=>{
 const {bridge,events,calls}=await fixture(t);await bridge.startWork('complete','request-complete');await until(()=>bridge.state().status==='completed');
 assert.equal(bridge.state().activeTurnId,null);assert.equal(bridge.state().workStarting,false);assert.equal(canUpdate(bridge),true);
 assert.equal((await calls()).filter(call=>call.method==='turn/start').length,1);
 assert.equal(events.filter(event=>event.type==='work-state').at(-1).state.workStarting,false);
});
test('late completion and duplicate started notification cannot erase or mislabel a newer active turn',async t=>{
 const {bridge,notify}=await fixture(t);await bridge.startWork('complete','request-first');await until(()=>bridge.state().status==='completed');
 await bridge.startWork('remain','request-second');await until(()=>bridge.state().activeTurnId==='turn-2');
 await notify('turn/completed',{turn:{id:'turn-1',status:'completed',items:[]}});await notify('turn/started',{turn:{id:'turn-1',status:'inProgress'}});
 // A following item supplies an ordered protocol fence after both stale events.
 await notify('item/completed',{turnId:'turn-2',item:{id:'fence',type:'agentMessage',text:'still running'}});await until(()=>bridge.state().messages.some(message=>message.id==='fence'));
 assert.equal(bridge.state().activeTurnId,'turn-2');assert.equal(bridge.state().status,'working');assert.equal(canUpdate(bridge),false);
});
test('turn/start response closes pre-notification idle gap without needing turn/started',async t=>{
 const {bridge}=await fixture(t);await bridge.startWork('rpc-first','request-rpc-first');
 assert.equal(bridge.state().activeTurnId,'turn-1');assert.equal(bridge.state().status,'working');assert.equal(bridge.state().workStarting,false);assert.equal(canUpdate(bridge),false);
});
test('completion preceding turn/start RPC response cannot resurrect that finished turn',async t=>{
 const {bridge,events}=await fixture(t);await bridge.startWork('completion-first','request-fast');
 assert.equal(bridge.state().status,'completed');assert.equal(bridge.state().activeTurnId,null);assert.equal(bridge.state().workStarting,false);assert.equal(canUpdate(bridge),true);
 assert.equal(events.filter(event=>event.type==='work-state').at(-1).state.workStarting,false);
});
test('resuming a saved in-progress native turn refuses a new turn rather than starting replacement work',async t=>{
 const {bridge,calls}=await fixture(t,{saved:true,history:[{id:'existing-live-turn',status:'inProgress',items:[]}]});
 await assert.rejects(bridge.startWork('remain','request-resume'),/already working/);
 assert.equal(bridge.state().activeTurnId,'existing-live-turn');assert.equal(bridge.state().workStarting,false);assert.equal(canUpdate(bridge),false);
 assert.equal((await calls()).filter(call=>call.method==='turn/start').length,0);assert.equal((await calls()).filter(call=>call.method==='thread/fork').length,0);
});
test('pending thread initialization is busy and duplicate request IDs still launch once',async t=>{
 const {bridge,calls}=await fixture(t,{threadDelay:50});const first=bridge.startWork('rpc-first','request-dedup'),duplicate=bridge.startWork('rpc-first','request-dedup');
 assert.equal(bridge.state().workStarting,true);assert.equal(canUpdate(bridge),false);
 await Promise.all([first,duplicate]);assert.equal((await calls()).filter(call=>call.method==='turn/start').length,1);assert.equal(bridge.state().activeTurnId,'turn-1');
});
test('interrupted native terminal state becomes idle only after matching completion',async t=>{
 const {bridge}=await fixture(t);await bridge.startWork('remain','request-interrupt');assert.equal(canUpdate(bridge),false);
 await bridge.interrupt();await until(()=>bridge.state().status==='interrupted');
 assert.equal(bridge.state().activeTurnId,null);assert.equal(bridge.state().workStarting,false);assert.equal(canUpdate(bridge),true);
});

test('update interruption cannot target a newer manager turn',async t=>{
 const {bridge,calls}=await fixture(t);await bridge.startWork('remain','correlated-manager');await assert.rejects(bridge.interrupt({expectedTurnId:'old-turn'}),/turn changed/);assert.equal((await calls()).filter(call=>call.method==='turn/interrupt').length,0);assert.equal(bridge.state().activeTurnId,'turn-1');await bridge.interrupt({expectedTurnId:'turn-1'});await until(()=>bridge.state().status==='interrupted');assert.equal((await calls()).filter(call=>call.method==='turn/interrupt').length,1);
});

test('cooperative update voice stop failure preserves the manager process and stays visibly active',async t=>{
 const {bridge,calls}=await fixture(t,{voiceStopFails:true});await bridge.startWork('remain','voice-stop-manager');await bridge.startVoice('v=0 synthetic','cove');assert.equal(bridge.state().voiceActive,true);await assert.rejects(bridge.stopVoice({cooperative:true}),/shutdown could not be confirmed/);assert.equal(bridge.state().voiceActive,true);assert.equal(bridge.state().activeTurnId,'turn-1');await bridge.interrupt({expectedTurnId:'turn-1'});await until(()=>bridge.state().status==='interrupted');assert.equal((await calls()).filter(c=>c.method==='turn/interrupt').length,1);
});

test('update manager runtime shutdown waits for natural EOF exit and never escalates if it remains live',async t=>{
 const natural=await fixture(t,{exitOnEOF:true});await natural.bridge.startWork('complete','natural-shutdown');await until(()=>natural.bridge.state().status==='completed');await natural.bridge.shutdown({cooperative:true});assert.equal((await natural.calls()).filter(c=>c.signal).length,0);
 const refuses=await fixture(t);await refuses.bridge.startWork('complete','pending-shutdown');await until(()=>refuses.bridge.state().status==='completed');await assert.rejects(refuses.bridge.shutdown({cooperative:true}),/still pending.*No force signal/);assert.equal((await refuses.calls()).filter(c=>c.signal).length,0);assert.equal(refuses.bridge.state().status,'completed');
});

test('project repository scopes child and thread configuration while orchestration executable stays app-owned',async t=>{
 for(const saved of [false,true]){
  const f=await fixture(t,{saved,projectScoped:true});await f.bridge.startWork('complete',saved?'scoped-resume':'scoped-start');await until(()=>f.bridge.state().status==='completed');
  const awaitedRepository=await realpath(f.repository);
  const calls=await f.calls(),thread=calls.find(call=>call.method===(saved?'thread/resume':'thread/start'));
  assert.equal(thread.params.cwd,f.repository);assert.ok(calls.every(call=>call.processCwd===awaitedRepository));
  for(const key of ['sandbox','approvalPolicy','approvalsReviewer'])assert.equal(Object.hasOwn(thread.params,key),false);
  assert.equal(calls[0].processArgs.some(arg=>/ignore-user-config|shell_environment_policy/.test(arg)),false);
  const argument=calls[0].processArgs.find(arg=>arg.startsWith('mcp_servers.local_orchestration.args='));
  assert.deepEqual(JSON.parse(argument.slice(argument.indexOf('=')+1)),[join(f.directory,'orchestration-mcp.mjs'),f.orchestrationDir,'manager',f.runtimeProjectPath]);
  assert.notEqual(f.repository,f.directory);
 }
});


test('manager start and resume retain project-resolved developer instructions before Crew runtime',async t=>{
 const configuredInstructions='Configured development instructions must survive Crew.';
 for(const saved of [false,true]){
  const f=await fixture(t,{saved,projectScoped:true,configuredInstructions});
  await f.bridge.startWork('complete',saved?'configured-resume':'configured-start');
  await until(()=>f.bridge.state().status==='completed');
  const calls=await f.calls(),read=calls.find(call=>call.method==='config/read'),thread=calls.find(call=>call.method===(saved?'thread/resume':'thread/start'));
  assert.equal(read.params.cwd,f.repository);assert.equal(read.params.includeLayers,false);
  assert.ok(calls.indexOf(read)<calls.indexOf(thread));
  assert.ok(thread.params.developerInstructions.startsWith(configuredInstructions+'\n\n'));
  assert.match(thread.params.developerInstructions,/Crew runtime context/);
  assert.equal(thread.params.developerInstructions.split(configuredInstructions).length,2);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(f.directory,'manager.json'),'utf8'))),['threadId']);
 }
});
