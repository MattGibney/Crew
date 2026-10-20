import test from 'node:test';import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';import {once} from 'node:events';
import {OwnedProcessTree,snapshotProcesses} from '../process-ownership.mjs';
const live=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
test('owned descendants in separate process groups terminate while unrelated process survives',async()=>{
 const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 const script=`const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log(child.pid);setInterval(()=>{},1000);`;
 const root=spawn(process.execPath,['-e',script],{stdio:['ignore','pipe','ignore']});let childPid;
 try{
  const [data]=await once(root.stdout,'data');childPid=Number(String(data).trim());assert.ok(childPid>1);
  const owner=new OwnedProcessTree(root.pid);const tracked=await owner.capture();assert.ok(tracked.some(r=>r.pid===childPid));assert.ok(!tracked.some(r=>r.pid===unrelated.pid));
  const result=await owner.stop({graceMs:100});assert.equal(result.confirmed,true);assert.deepEqual(result.remaining,[]);
  assert.equal(live(unrelated.pid),true);assert.equal((await snapshotProcesses()).get(childPid)?.state?.includes('Z')??true,true);
 }finally{for(const pid of [childPid,root.pid,unrelated.pid])if(pid)try{process.kill(pid,'SIGKILL');}catch{}}
});
test('reused PID or changed command identity never receives a signal',async()=>{
 const rootPid=900001,childPid=900002,record=(pid,ppid,start,commandHash)=>({pid,ppid,start,commandHash,state:'S'});
 let rows=new Map([[rootPid,record(rootPid,1,'original-root','root')],[childPid,record(childPid,rootPid,'original-child','child')]]);const signals=[];
 const tree=new OwnedProcessTree(rootPid,{snapshot:async()=>rows,signal:(pid,signal)=>signals.push({pid,signal})});await tree.capture();
 rows=new Map([[rootPid,record(rootPid,1,'reused-root','other')],[childPid,record(childPid,1,'original-child','exec-replaced')]]);
 const result=await tree.stop({graceMs:0});assert.deepEqual(signals,[]);assert.equal(result.confirmed,false);assert.equal(result.remaining.length,1);assert.equal(result.remaining[0].pid,childPid);assert.equal(result.remaining[0].identityVerified,false);
});
test('a reused root cannot acquire unrelated new children and unknown initial ownership stays unconfirmed',async()=>{
 const row={pid:900001,ppid:1,start:'root',commandHash:'hash',state:'S'};let rows=new Map([[row.pid,row]]);
 const tree=new OwnedProcessTree(row.pid,{snapshot:async()=>rows,signal:()=>assert.fail('Must not signal reused PID')});await tree.capture();
 rows=new Map([[row.pid,{...row,start:'replacement'}],[900002,{pid:900002,ppid:row.pid,start:'other',commandHash:'other',state:'S'}]]);
 assert.equal((await tree.capture()).length,1);assert.equal((await tree.stop({graceMs:0})).confirmed,true);
 const unknown=new OwnedProcessTree(900003,{snapshot:async()=>new Map()});assert.equal((await unknown.stop({graceMs:0})).confirmed,false);
});
