// A real child JSON-RPC peer exercises bridge ordering; no Codex/network/mic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,appendFile,readFile,rm,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createBridge} from '../codex-bridge.mjs';
import {updateActivity} from '../update-activity.mjs';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate){const deadline=Date.now()+4000;while(Date.now()<deadline){if(await predicate())return;await delay(10);}throw new Error('Synthetic protocol condition did not arrive.');}
async function fixture(t,{history=[],saved=false,threadDelay=0}={}){
 const directory=await mkdtemp(join(tmpdir(),'crew-turn-state-')),statePath=join(directory,'manager.json'),control=join(directory,'notifications.jsonl'),calls=join(directory,'calls.jsonl'),executable=join(directory,'fake-codex.mjs');
 await writeFile(control,'');await writeFile(calls,'');if(saved)await writeFile(statePath,JSON.stringify({threadId:'manager-thread'}));
 const program=`#!${process.execPath}
import {createInterface} from 'node:readline';
import {readFileSync,appendFileSync} from 'node:fs';
const control=${JSON.stringify(control)},calls=${JSON.stringify(calls)},history=${JSON.stringify(history)};let sequence=0,seen=0;
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const reply=(id,result)=>send({id,result});
const notify=(method,params)=>send({method,params:{threadId:'manager-thread',...params}});
setInterval(()=>{const lines=readFileSync(control,'utf8').split('\\n').filter(Boolean);for(const line of lines.slice(seen))send(JSON.parse(line));seen=lines.length;},10);
createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line);if(message.id===undefined)return;
 appendFileSync(calls,JSON.stringify(message)+'\\n');const {id,method,params}=message;
 if(method==='initialize')return reply(id,{});
 if(method==='account/read')return reply(id,{account:{type:'chatgpt',planType:'synthetic'}});
 if(method==='thread/start'||method==='thread/resume')return setTimeout(()=>reply(id,{thread:{id:'manager-thread'}}),${threadDelay});
 if(method==='thread/name/set')return reply(id,{});
 if(method==='thread/turns/list')return reply(id,{data:history});
 if(method==='mcpServerStatus/list')return reply(id,{data:[]});
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
 const events=[],bridge=createBridge({cwd:directory,statePath,executable,onEvent:event=>events.push(event)});
 t.after(async()=>{await bridge.shutdown();await rm(directory,{recursive:true,force:true});});
 return {bridge,events,request:async(id,method,params)=>appendFile(control,JSON.stringify({id,method,params:{threadId:'manager-thread',...params}})+'\n'),notify:async(method,params)=>appendFile(control,JSON.stringify({method,params:{threadId:'manager-thread',...params}})+'\n'),calls:async()=>((await readFile(calls,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line)))};
}
const canUpdate=bridge=>updateActivity({work:bridge.state(),view:{tasks:[]}}).safe;

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
