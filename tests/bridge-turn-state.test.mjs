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
async function fixture(t,{history=[],saved=false,threadDelay=0,voiceStopFails=false,exitOnEOF=false,projectScoped=false,configuredInstructions=null,timelinePages=null,timelineDelay=0,timelineError=null,writerConflict=false,conflictThreadIds=null,recoveryActive=false,turnsError=null,startupApproval=false,startupThreadNotification=true,startupResultThreadId=null}={}){
 const directory=await mkdtemp(join(tmpdir(),'crew-turn-state-')),statePath=join(directory,'manager.json'),control=join(directory,'notifications.jsonl'),calls=join(directory,'calls.jsonl'),executable=join(directory,'fake-codex.mjs');
 await writeFile(control,'');await writeFile(calls,'');if(saved)await writeFile(statePath,JSON.stringify({threadId:'manager-thread'}));
 const program=`#!${process.execPath}
import {createInterface} from 'node:readline';
import {readFileSync,appendFileSync} from 'node:fs';
const control=${JSON.stringify(control)},calls=${JSON.stringify(calls)},history=${JSON.stringify(history)};let sequence=0,seen=0;const startupPending=new Map();
process.stdin.on('end',()=>{if(${exitOnEOF})process.exit(0)});process.on('SIGTERM',()=>{appendFileSync(calls,JSON.stringify({signal:'SIGTERM'})+'\\n');process.exit(0)});
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const reply=(id,result)=>send({id,result});
const notify=(method,params)=>send({method,params:{threadId:'manager-thread',...params}});
setInterval(()=>{const lines=readFileSync(control,'utf8').split('\\n').filter(Boolean);for(const line of lines.slice(seen))send(JSON.parse(line));seen=lines.length;},10);
createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line);if(message.id===undefined)return;
 appendFileSync(calls,JSON.stringify({...message,processCwd:process.cwd(),processArgs:process.argv.slice(2)})+'\\n');const {id,method,params}=message;
 if(!method){const waiting=startupPending.get(id);if(waiting){startupPending.delete(id);send({method:'serverRequest/resolved',params:{threadId:waiting.threadId,requestId:id}});reply(waiting.clientId,{thread:{id:${JSON.stringify(startupResultThreadId)}||waiting.threadId}});}return;}
 if(method==='initialize')return reply(id,{});
 if(method==='account/read')return reply(id,{account:{type:'chatgpt',planType:'synthetic'}});
 if(method==='config/read')return reply(id,{config:{developer_instructions:${JSON.stringify(configuredInstructions)}}});
 if(method==='thread/resume'&&(${JSON.stringify(conflictThreadIds)}||(${writerConflict}?['manager-thread']:[])).includes(params.threadId))return send({id,error:{code:-32600,message:'Thread already has an active writer'}});
 if(method==='thread/read')return reply(id,{thread:{id:'manager-thread',status:{type:${JSON.stringify(recoveryActive?'active':'idle')}}}});
 if(['thread/start','thread/resume','thread/fork'].includes(method)){
  const nativeThreadId=method==='thread/fork'?(params.threadId==='forked-thread'?'reforked-thread':'forked-thread'):(params.threadId||'manager-thread');
  if(${startupApproval}){startupPending.set(id,{clientId:id,threadId:nativeThreadId});if(${startupThreadNotification})send({method:'thread/started',params:{thread:{id:nativeThreadId}}});send({id,method:'mcpServer/elicitation/request',params:{threadId:nativeThreadId,turnId:null,serverName:'fixture-connector',mode:'form',requestedSchema:{type:'object',properties:{}},_meta:{codex_approval_kind:'mcp_tool_call'},message:'Confirm fixture connector startup'}});return;}
  return setTimeout(()=>reply(id,{thread:{id:nativeThreadId}}),${threadDelay});
 }
 if(method==='thread/name/set')return reply(id,{});
 if(method==='thread/timeline/list'){let error=${JSON.stringify(timelineError)};try{error=JSON.parse(readFileSync(${JSON.stringify(join(directory,'timeline-error.json'))},'utf8'));}catch{};if(error)return send({id,error});const pages=${JSON.stringify(timelinePages)};return pages ? setTimeout(()=>reply(id,pages[Number(params.cursor||0)]),${timelineDelay}) : send({id,error:{code:-32601,message:'Method not found'}});}
 if(method==='thread/turns/list'){const error=${JSON.stringify(turnsError)};return error?send({id,error}):reply(id,{data:history});}
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
 const events=[],bridges=new Set(),create=()=>{const value=createBridge({cwd:directory,statePath,executable,...(projectScoped?{project,orchestrationDir,runtimeProjectPath}:{}),onEvent:event=>events.push(event)});bridges.add(value);return value;},bridge=create();
 // Shutdown every recreated fixture bridge before removing the state it may persist.
 t.after(async()=>{for(const value of bridges)await value.shutdown();await rm(directory,{recursive:true,force:true});});
 return {bridge,request:async(id,method,params)=>appendFile(control,JSON.stringify({id,method,params:{threadId:'manager-thread',...params}})+'\n'),create,events,directory,executable,repository,orchestrationDir,runtimeProjectPath,clearNotifications:()=>writeFile(control,''),setTimelineError:error=>writeFile(join(directory,'timeline-error.json'),JSON.stringify(error)),notify:async(method,params)=>appendFile(control,JSON.stringify({method,params:{threadId:'manager-thread',...params}})+'\n'),calls:async()=>((await readFile(calls,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line)))};
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
  const argument=calls[0].processArgs.find(arg=>arg.startsWith('mcp_servers.local_orchestration.args='));
  assert.deepEqual(JSON.parse(argument.slice(argument.indexOf('=')+1)),[join(f.directory,'orchestration-mcp.mjs'),f.orchestrationDir,'manager',f.runtimeProjectPath]);
  assert.notEqual(f.repository,f.directory);
 }
});


test('canonical mixed history pages retain exact order, identity promotion and streaming updates without flat mirror duplicates', async t => {
 const native={type:'agentMessage',id:'native',text:'Native result'};
 const f=await fixture(t,{timelinePages:[{data:[
  {type:'item',position:0,turnId:'text',item:{type:'userMessage',id:'typed',content:[{type:'text',text:'Typed question'}]}},
  {type:'realtime',position:1,item:{type:'transcriptSegment',id:'spoken',role:'user',text:'Spoken question'}},
  {type:'item',position:2,turnId:'native-turn',item:native}
 ],nextCursor:'1'}, {data:[
  {type:'realtime',position:3,item:{type:'transcriptSegment',id:'answer',role:'assistant',text:'Spoken answer'}},
  {type:'realtime',position:4,item:{type:'bemItemPromoted',id:'promotion',itemId:'native',turnId:'native-turn',presentation:{type:'wholeItem'}}}
 ],nextCursor:null}]});
 await f.bridge.ensureThread();
 assert.deepEqual(f.bridge.state().messages.map(m=>m.id),['typed','spoken','answer','native']);
 await f.notify('thread/realtime/item/started',{item:{type:'transcriptSegment',id:'live',role:'user',text:''}});
 await f.notify('thread/realtime/item/transcript/delta',{itemId:'live',delta:'Partial speech'});
 await f.notify('thread/realtime/transcript/delta',{role:'user',delta:'Partial speech'});
 await until(()=>f.bridge.state().messages.some(m=>m.id==='live'&&m.text==='Partial speech'));
 assert.equal(f.bridge.state().messages.filter(m=>m.text==='Partial speech').length,1);
 await f.notify('thread/realtime/item/completed',{item:{type:'transcriptSegment',id:'live',role:'user',text:'Final speech'}});
 await f.notify('thread/realtime/item/started',{item:{type:'transcriptSegment',id:'live',role:'user',text:''}});
 await f.notify('item/started',{turnId:'next',item:{type:'agentMessage',id:'typed-reply',text:''}});
 await f.notify('item/agentMessage/delta',{itemId:'typed-reply',delta:'Live native reply'});
 await until(()=>f.bridge.state().messages.some(m=>m.text==='Live native reply'));
 assert.equal(f.bridge.state().messages.find(m=>m.id==='live').text,'Final speech');
 assert.equal(f.bridge.state().messages.find(m=>m.id==='typed-reply').status,'streaming');
 assert.equal((await f.calls()).filter(c=>c.method==='thread/timeline/list').length,2);
 assert.equal((await f.calls()).filter(c=>c.method==='thread/turns/list').length,1);
 assert.equal((await f.calls()).filter(c=>c.method==='turn/start').length,0);
});

test('older-protocol synthetic speech persists mixed order across actual bridge recreation and retains interrupted text',async t=>{
 const f=await fixture(t);await f.bridge.ensureThread();
 await f.notify('item/completed',{turnId:'typed-turn',item:{type:'userMessage',id:'typed',content:[{type:'text',text:'Typed first'}]}});
 await f.notify('thread/realtime/transcript/delta',{role:'user',delta:'Said '});
 await f.notify('thread/realtime/transcript/done',{role:'user',text:'Said aloud'});
 await f.notify('thread/realtime/transcript/delta',{role:'assistant',delta:'Unfinished reply'});
 await f.notify('thread/realtime/closed',{reason:'interrupted'});
 await until(()=>f.bridge.state().messages.some(m=>m.text==='Unfinished reply'&&m.status==='partial'));
 const original=f.bridge.state().messages;
 await f.bridge.shutdown();await f.clearNotifications();
 const restored=f.create();t.after(()=>restored.shutdown());await restored.ensureThread();
 assert.deepEqual(restored.state().messages,original);
 await restored.shutdown();
 const calls=await f.calls();assert.equal(calls.filter(c=>c.method==='turn/start').length,0);
});

test('canonical reconnect restores active native streaming, voice close leaves it live, and absent partial speech survives recreation',async t=>{
 const f=await fixture(t,{timelinePages:[{data:[
  {type:'turnStarted',position:0,turnId:'active'},
  {type:'item',position:1,turnId:'active',item:{id:'reply',type:'agentMessage',text:'Started'}}
 ],nextCursor:null}]});
 await writeFile(join(f.directory,'manager.json.conversation.json'),JSON.stringify({threadId:'manager-thread',messages:[{id:'reply',turnId:'active',role:'assistant',text:'Started',position:1,status:'streaming'}]}));
 await f.bridge.ensureThread();
 await f.notify('item/agentMessage/delta',{itemId:'reply',delta:' continuing'});
 await f.notify('thread/realtime/item/started',{item:{type:'transcriptSegment',id:'unfinished',role:'user',text:'Interrupted words'}});
 await f.notify('thread/realtime/closed',{reason:'disconnect'});
 await until(()=>f.bridge.state().messages.some(m=>m.id==='unfinished'&&m.status==='partial'));
 assert.equal(f.bridge.state().messages.find(m=>m.id==='reply').text,'Started continuing');
 assert.equal(f.bridge.state().messages.find(m=>m.id==='reply').status,'streaming');
 await f.bridge.shutdown();await f.clearNotifications();
 const restored=f.create();t.after(()=>restored.shutdown());await restored.ensureThread();
 assert.equal(restored.state().messages.find(m=>m.id==='unfinished').text,'Interrupted words');
 assert.equal(restored.state().messages.find(m=>m.id==='unfinished').status,'partial');
 assert.equal(restored.state().messages.filter(m=>m.id==='reply').length,1);
 assert.equal(restored.state().messages.find(m=>m.id==='reply').text,'Started continuing');
 await restored.shutdown();
});

test('older timeline protocol chooses item transcript source once and ignores flat mirrors',async t=>{
 const f=await fixture(t);await f.bridge.ensureThread();
 await f.notify('thread/realtime/item/started',{item:{type:'transcriptSegment',id:'identified',role:'user',text:''}});
 await f.notify('thread/realtime/item/transcript/delta',{itemId:'identified',delta:'Hello'});
 await f.notify('thread/realtime/transcript/delta',{role:'user',delta:'Hello'});
 await f.notify('thread/realtime/transcript/done',{role:'user',text:'Hello'});
 await f.notify('thread/realtime/item/completed',{item:{type:'transcriptSegment',id:'identified',role:'user',text:'Hello'}});
 await until(()=>f.bridge.state().messages.some(m=>m.id==='identified'&&m.status==='complete'));
 assert.equal(f.bridge.state().messages.length,1);
});

test('late native user is repaired within its turn without regrouping intervening speech',async t=>{
 const f=await fixture(t);await f.bridge.ensureThread();
 await f.notify('item/completed',{turnId:'native',item:{id:'assistant-first',type:'agentMessage',text:'Reply'}});
 await f.notify('thread/realtime/transcript/done',{role:'user',text:'Intervening speech'});
 await f.notify('item/completed',{turnId:'native',item:{id:'user-late',type:'userMessage',content:[{type:'text',text:'Original request'}]}});
 await until(()=>f.bridge.state().messages.some(m=>m.id==='user-late'));
 assert.deepEqual(f.bridge.state().messages.map(m=>m.text),['Original request','Reply','Intervening speech']);
});


test('live speech during delayed canonical history stays after restored history and terminal status follows position',async t=>{
 const f=await fixture(t,{timelineDelay:100,timelinePages:[{data:[
  {type:'turnCompleted',position:20,turnId:'ended',status:'completed'},
  {type:'item',position:10,turnId:'ended',item:{id:'past',type:'agentMessage',text:'Past reply'}},
  {type:'turnStarted',position:0,turnId:'ended'}
 ],nextCursor:null}]});
 const loading=f.bridge.ensureThread();
 await until(async()=> (await f.calls()).some(call=>call.method==='thread/timeline/list'));
 await f.notify('thread/realtime/item/started',{item:{type:'transcriptSegment',id:'current',role:'user',text:'Current speech'}});
 await loading;await until(()=>f.bridge.state().messages.some(m=>m.id==='current'));
 assert.deepEqual(f.bridge.state().messages.map(m=>m.id),['past','current']);
 assert.equal(f.bridge.state().activeTurnId,null);assert.equal(f.bridge.state().status,'completed');
 await f.notify('thread/realtime/item/completed',{item:{type:'transcriptSegment',id:'current',role:'user',text:''}});
 await until(()=>f.bridge.state().messages.find(m=>m.id==='current').status==='partial');
 assert.equal(f.bridge.state().messages.find(m=>m.id==='current').text,'Current speech');
});


test('canonical partial overlay retains earlier speech before later committed messages and leaves completed commentary complete',async t=>{
 const f=await fixture(t,{timelinePages:[{data:[
  {type:'turnStarted',position:0,turnId:'active'},
  {type:'item',position:2,turnId:'active',item:{id:'commentary',type:'agentMessage',text:'Committed commentary'}},
  {type:'item',position:3,turnId:'active',item:{id:'live-reply',type:'agentMessage',text:'In progress'}}
 ],nextCursor:null}]});
 await writeFile(join(f.directory,'manager.json.conversation.json'),JSON.stringify({threadId:'manager-thread',messages:[
  {id:'speech',role:'user',source:'voice',text:'Interrupted speech',status:'partial',position:1},
  {id:'commentary',role:'assistant',turnId:'active',text:'Committed commentary',status:'complete',position:2},
  {id:'live-reply',role:'assistant',turnId:'active',text:'In progress',status:'streaming',position:3}
 ]}));
 await f.bridge.ensureThread();
 assert.deepEqual(f.bridge.state().messages.map(m=>m.id),['speech','commentary','live-reply']);
 assert.equal(f.bridge.state().messages.find(m=>m.id==='commentary').status,'complete');
 assert.equal(f.bridge.state().messages.find(m=>m.id==='live-reply').status,'streaming');
 await f.notify('item/started',{turnId:'active',item:{id:'commentary',type:'agentMessage',text:''}});
 await f.notify('item/agentMessage/delta',{itemId:'live-reply',delta:' now'});
 await until(()=>f.bridge.state().messages.some(m=>m.text==='In progress now'));
 assert.equal(f.bridge.state().messages.find(m=>m.id==='commentary').text,'Committed commentary');
});

test('bounded canonical history never supplies stale admission status and retains recent observed conversation',async t=>{
 const timelinePages=Array.from({length:21},(_,index)=>({data:[
  {type:'turnStarted',position:index*2,turnId:`old-${index}`},
  {type:'item',position:index*2+1,turnId:`old-${index}`,item:{id:`old-${index}`,type:'agentMessage',text:`Old ${index}`}}
 ],nextCursor:index<20?String(index+1):null}));
 const f=await fixture(t,{timelinePages,history:[{id:'current-active',status:'inProgress',items:[]}]});
 await writeFile(join(f.directory,'manager.json.conversation.json'),JSON.stringify({threadId:'manager-thread',messages:[
  {id:'observed-recent',role:'user',source:'voice',text:'Observed recent conversation',status:'complete',position:100}
 ]}));
 await f.bridge.ensureThread();
 assert.equal(f.bridge.state().activeTurnId,'current-active');assert.equal(canUpdate(f.bridge),false);
 assert.equal(f.bridge.state().messages.find(m=>m.id==='observed-recent').text,'Observed recent conversation');
 assert.equal((await f.calls()).filter(c=>c.method==='thread/timeline/list').length,20);
 assert.ok(f.events.some(e=>e.type==='notice'&&/bounded window/.test(e.message)));
});


test('native timeline not-supported-yet response falls back precisely, while operational errors remain visible',async t=>{
 const f=await fixture(t,{timelineError:{code:-32600,message:'thread/timeline/list is not supported yet'},history:[{id:'historical-turn',status:'completed',items:[{id:'historical-message',type:'agentMessage',text:'Retained native history'}]}]});
 await f.bridge.ensureThread();
 assert.equal(f.bridge.state().messages[0].text,'Retained native history');
 await f.notify('thread/realtime/transcript/done',{role:'user',text:'Fallback utterance'});
 await until(()=>f.bridge.state().messages.some(m=>m.text==='Fallback utterance'));
 assert.equal((await f.calls()).filter(c=>c.method==='thread/turns/list').length,1);
 const broken=await fixture(t,{timelineError:{code:-32600,message:'thread/timeline/list history storage is unavailable'}});
 await assert.rejects(broken.bridge.ensureThread(),/history storage is unavailable/);
 assert.equal((await broken.calls()).filter(c=>c.method==='thread/turns/list').length,0);
});


test('verified native writer-conflict fork preserves and rebinds only the exact source journal',async t=>{
 for(const sourceId of ['manager-thread','unrelated-thread']) {
  const f=await fixture(t,{saved:true,writerConflict:true});
  const journal=join(f.directory,'manager.json.conversation.json');
  await writeFile(journal,JSON.stringify({threadId:sourceId,messages:[{id:'saved-speech',role:'user',source:'voice',text:'Preserved speech',status:'complete',position:0}]}));
  await f.bridge.ensureThread();
  assert.equal(f.bridge.state().threadId,'forked-thread');
  assert.equal(f.bridge.state().messages.some(m=>m.id==='saved-speech'),sourceId==='manager-thread');
  await f.bridge.shutdown();
  const persisted=JSON.parse(await readFile(journal,'utf8'));
  assert.equal(persisted.threadId,'forked-thread');
  assert.equal(persisted.messages.some(m=>m.id==='saved-speech'),sourceId==='manager-thread');
  const calls=await f.calls();assert.equal(calls.filter(c=>c.method==='thread/fork').length,1);
  assert.equal(calls.filter(c=>c.method==='turn/start').length,0);
 }
 const active=await fixture(t,{saved:true,writerConflict:true,recoveryActive:true});
 const journal=join(active.directory,'manager.json.conversation.json');
 const original=JSON.stringify({threadId:'manager-thread',messages:[{id:'retained',role:'user',source:'voice',text:'Keep original',status:'complete',position:0}]});
 await writeFile(journal,original);
 await assert.rejects(active.bridge.ensureThread(),/active in another/);
 assert.equal((await active.calls()).filter(c=>c.method==='thread/fork').length,0);
 assert.equal(await readFile(journal,'utf8'),original);
 await active.bridge.shutdown();
 assert.equal(await readFile(journal,'utf8'),original);
 assert.equal(JSON.parse(await readFile(join(active.directory,'manager.json'),'utf8')).threadId,'manager-thread');
});


test('exact unmaterialized native chat hydrates on first use and reopen while preserving observed voice',async t=>{
 const turnsError={code:-32600,message:'thread manager-thread is not materialized yet; thread/turns/list is unavailable before first user message'};
 const fresh=await fixture(t,{turnsError});await fresh.bridge.ensureThread();
 assert.equal(fresh.bridge.state().managerConnected,true);assert.deepEqual(fresh.bridge.state().messages,[]);
 assert.equal((await fresh.calls()).filter(c=>c.method==='turn/start').length,0);
 await fresh.bridge.shutdown();await fresh.clearNotifications();
 const reopened=fresh.create();t.after(()=>reopened.shutdown());await reopened.ensureThread();
 assert.equal(reopened.state().managerConnected,true);await reopened.shutdown();
 const existing=await fixture(t,{saved:true,turnsError});
 await writeFile(join(existing.directory,'manager.json.conversation.json'),JSON.stringify({threadId:'manager-thread',messages:[{id:'observed-voice',role:'user',source:'voice',text:'Observed voice remains',status:'complete',position:0}]}));
 await existing.bridge.ensureThread();
 assert.equal(existing.bridge.state().messages[0].text,'Observed voice remains');
 const operational=await fixture(t,{turnsError:{code:-32600,message:'thread manager-thread history storage is unavailable'}});
 await assert.rejects(operational.bridge.ensureThread(),/history storage is unavailable/);
 const wrongThread=await fixture(t,{turnsError:{code:-32600,message:'thread different-thread is not materialized yet; thread/turns/list is unavailable before first user message'}});
 await assert.rejects(wrongThread.bridge.ensureThread(),/different-thread/);
});


test('saved native fork provenance retains source speech after failed hydration across retry and recreation',async t=>{
 for(const mode of ['retry','recreation']) {
  const timelineError={code:-32600,message:'thread/timeline/list history storage is unavailable'};
  const f=await fixture(t,{saved:true,writerConflict:true,timelineError});
  const journal=join(f.directory,'manager.json.conversation.json');
  const original=JSON.stringify({threadId:'manager-thread',messages:[{id:'retained-speech',role:'user',source:'voice',text:'Preserve across failed recovery',status:'complete',position:0}]});
  await writeFile(journal,original);
  await assert.rejects(f.bridge.ensureThread(),/history storage is unavailable/);
  assert.equal(await readFile(journal,'utf8'),original);
  const reference=JSON.parse(await readFile(join(f.directory,'manager.json'),'utf8'));
  assert.equal(reference.threadId,'forked-thread');assert.equal(reference.previousThreadId,'manager-thread');
  if(mode==='recreation') { await f.bridge.shutdown();assert.equal(await readFile(journal,'utf8'),original); }
  await f.setTimelineError(null);
  const recovered=mode==='retry'?f.bridge:f.create();t.after(()=>recovered.shutdown());
  await recovered.ensureThread();
  assert.equal(recovered.state().threadId,'forked-thread');
  assert.equal(recovered.state().messages.find(m=>m.id==='retained-speech').text,'Preserve across failed recovery');
  await recovered.shutdown();
  const persisted=JSON.parse(await readFile(journal,'utf8'));
  assert.equal(persisted.threadId,'forked-thread');assert.equal(persisted.messages[0].id,'retained-speech');
  const calls=await f.calls();assert.equal(calls.filter(c=>c.method==='thread/fork').length,1);assert.equal(calls.filter(c=>c.method==='turn/start').length,0);
 }
});


test('repeated verified native forks retain actual journal provenance after failed or successful hydration',async t=>{
 for(const failed of [true,false]) {
 const f=await fixture(t,{saved:true,conflictThreadIds:['manager-thread','forked-thread'],timelineError:failed?{code:-32600,message:'thread/timeline/list history storage is unavailable'}:null});
 const journal=join(f.directory,'manager.json.conversation.json');
 await writeFile(journal,JSON.stringify({threadId:'manager-thread',messages:[{id:'original-speech',role:'user',source:'voice',text:'Original source speech',status:'complete',position:0}]}));
 if(failed)await assert.rejects(f.bridge.ensureThread(),/history storage is unavailable/);else await f.bridge.ensureThread();
 await f.bridge.shutdown();
 await f.setTimelineError(null);
 const recovered=f.create();t.after(()=>recovered.shutdown());await recovered.ensureThread();
 assert.equal(recovered.state().threadId,'reforked-thread');
 assert.equal(recovered.state().messages[0].text,'Original source speech');
 await recovered.shutdown();
 const reference=JSON.parse(await readFile(join(f.directory,'manager.json'),'utf8'));
 assert.equal(reference.previousThreadId,'forked-thread');assert.equal(reference.journalSourceThreadId,failed?'manager-thread':'forked-thread');
 assert.equal(JSON.parse(await readFile(journal,'utf8')).threadId,'reforked-thread');
 assert.equal((await f.calls()).filter(c=>c.method==='turn/start').length,0);
 }
});

test('bridge publishes validated conversational attention only after native tool success and preserves retry identity',async t=>{
 const {bridge,notify}=await fixture(t);await bridge.startWork('remain','request-attention');
 const args={requestId:'choose-account',message:'Which account should I use?'},item={id:'attention-call',type:'mcpToolCall',server:'local_orchestration',tool:'request_attention',arguments:args,status:'inProgress',result:null};
 await notify('item/started',{turnId:'turn-1',item});await until(()=>bridge.state().items.some(value=>value.id===item.id));
 assert.equal(bridge.state().items.find(value=>value.id===item.id).attention,null);
 const completed={...item,status:'completed',result:{content:[{type:'text',text:JSON.stringify({ok:true,attention:args})}]}};
 await notify('item/completed',{turnId:'turn-1',item:completed});await until(()=>bridge.state().items.find(value=>value.id===item.id)?.attention);
 assert.deepEqual(bridge.state().items.find(value=>value.id===item.id).attention,{id:args.requestId,message:args.message});
 await notify('item/completed',{turnId:'turn-1',item:{...completed,id:'retried-attention-call'}});await until(()=>bridge.state().items.some(value=>value.id==='retried-attention-call'));
 assert.deepEqual(bridge.state().items.filter(value=>value.attention).map(value=>value.attention.id),[args.requestId,args.requestId]);
});


test('native approval identity survives replay but distinguishes reused transport IDs in a new turn',async t=>{
 const {bridge,notify,request}=await fixture(t);await bridge.startWork('remain','request-approval-identity');
 const method='item/tool/requestUserInput',params={turnId:'turn-1',questions:[{id:'q',question:'Choose scope'}]};
 await request(9000,method,params);await until(()=>bridge.state().approvals.length===1);
 const first=bridge.state().approvals[0].attentionId;
 await request(9000,method,params);
 await notify('item/completed',{turnId:'turn-1',item:{id:'approval-fence',type:'agentMessage',text:'fence'}});
 await until(()=>bridge.state().messages.some(message=>message.id==='approval-fence'));
 assert.equal(bridge.state().approvals[0].attentionId,first);
 await notify('serverRequest/resolved',{requestId:9000});await until(()=>bridge.state().approvals.length===0);
 await request(9000,method,{...params,turnId:'turn-2'});await until(()=>bridge.state().approvals.length===1);
 assert.notEqual(bridge.state().approvals[0].attentionId,first);
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

test('manager startup connector approvals remain interactive before start/resume/fork completes, including colliding native RPC IDs',async t=>{
 for(const options of [{},{startupThreadNotification:false},{saved:true},{saved:true,writerConflict:true}]){
  const f=await fixture(t,{...options,startupApproval:true});
  let settled=false;const starting=f.bridge.ensureThread().finally(()=>{settled=true;});
  await until(()=>f.bridge.state().approvals.length===1);
  const state=f.bridge.state(),request=state.approvals[0],expected=options.writerConflict?'forked-thread':'manager-thread';
  assert.equal(settled,false);assert.equal(state.managerConnected,false);assert.equal(state.threadId,expected);
  assert.equal(request.params.threadId,expected);assert.equal(request.params.turnId,null);
  assert.equal((await f.calls()).some(call=>String(call.id)===request.id&&!call.method),false,'startup request has no automatic response');
  assert.throws(()=>f.bridge.answerApproval('unknown-native-request',{action:'accept'}),/already been resolved/);
  await f.request(9000,'mcpServer/elicitation/request',{threadId:'unrelated-native-thread',turnId:null,mode:'form',requestedSchema:{type:'object',properties:{}},_meta:{codex_approval_kind:'mcp_tool_call'}});
  await until(async()=> (await f.calls()).some(call=>call.id===9000&&call.error));
  assert.equal(f.bridge.state().approvals.length,1,'unrelated native thread cannot replace startup approval');
  f.bridge.answerApproval(request.id,{action:'decline'});
  await starting;
  const response=(await f.calls()).find(call=>String(call.id)===request.id&&!call.method&&call.result);
  assert.deepEqual(response.result,{action:'decline',content:null,_meta:null});
  assert.equal(f.bridge.state().threadId,expected);assert.equal(f.bridge.state().approvals.length,0);
  assert.equal((await f.calls()).filter(call=>call.method==='turn/start').length,0);
 }
});
test('failed manager startup correlation removes only its own pending forms without answering them',async t=>{
 const f=await fixture(t,{startupApproval:true,startupResultThreadId:'different-result-thread'});
 const starting=f.bridge.ensureThread();const rejected=assert.rejects(starting,/startup correlation mismatch/);
 await until(()=>f.bridge.state().approvals.length===1);
 const first=f.bridge.state().approvals[0];
 await f.request(9100,'mcpServer/elicitation/request',{threadId:'manager-thread',turnId:null,mode:'form',requestedSchema:{type:'object',properties:{}},_meta:{codex_approval_kind:'mcp_tool_call'}});
 await until(()=>f.bridge.state().approvals.length===2);
 f.bridge.answerApproval(first.id,{action:'decline'});
 await rejected;
 assert.equal(f.bridge.state().approvals.length,0);
 assert.throws(()=>f.bridge.answerApproval(9100,{action:'accept'}),/already been resolved/);
 assert.equal((await f.calls()).some(call=>call.id===9100&&!call.method),false);
 assert.ok(f.events.some(event=>event.type==='notice'&&event.message.includes('No response was sent automatically')));
});

for (const canonical of [true, false]) test(`realtime handoff presentation is clean through ${canonical ? 'canonical' : 'fallback'} history, live completion and restart without dispatch`, async t => {
 const envelope = input => `<realtime_delegation><input>${input}</input><transcript_delta>assistant: Historical context\nuser: Prior request</transcript_delta></realtime_delegation>`;
 const item = {id:'handoff',type:'userMessage',content:[{type:'text',text:envelope('Current request')}]};
 const f = await fixture(t,{saved:true,history:[{id:'voice-turn',status:'completed',items:[item]}],...(canonical ? {timelinePages:[{data:[{type:'item',position:5,turnId:'voice-turn',item}],nextCursor:null}]} : {})});
 await writeFile(join(f.directory,'manager.json.conversation.json'),JSON.stringify({threadId:'manager-thread',messages:[{id:'old-overlay',turnId:'old-turn',role:'user',text:envelope('Saved request'),position:1,status:'complete'}]}));
 await f.bridge.ensureThread();
 assert.equal(f.bridge.state().messages.find(m=>m.id==='handoff').text,'Current request');
 if (!canonical) assert.equal(f.bridge.state().messages.find(m=>m.id==='old-overlay').text,'Saved request');
 const live = {id:'live-handoff',type:'userMessage',content:[{type:'text',text:'<realtime_delegation><input>'}]};
 await f.notify('item/started',{turnId:'live-turn',item:live});
 await until(()=>f.bridge.state().messages.some(m=>m.id==='live-handoff'));
 assert.equal(f.bridge.state().messages.find(m=>m.id==='live-handoff').text,'Voice request (transcript unavailable).');
 live.content[0].text=envelope('New live request');
 await f.notify('item/completed',{turnId:'live-turn',item:live});
 await until(()=>f.bridge.state().messages.some(m=>m.id==='live-handoff'&&m.text==='New live request'));
 assert.equal(f.bridge.state().messages.filter(m=>m.id==='live-handoff').length,1);
 assert.equal(f.bridge.state().messages.find(m=>m.id==='live-handoff').turnId,'live-turn');
 await f.bridge.shutdown();await f.clearNotifications();
 const restored=f.create();t.after(()=>restored.shutdown());await restored.ensureThread();
 assert.equal(restored.state().messages.find(m=>m.id==='handoff').text,'Current request');
 if (!canonical) assert.equal(restored.state().messages.find(m=>m.id==='live-handoff').text,'New live request');
 const calls=await f.calls();
 assert.equal(calls.filter(call=>['turn/start','thread/realtime/appendText','thread/realtime/start'].includes(call.method)).length,0);
});
