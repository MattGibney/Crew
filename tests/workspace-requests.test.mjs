import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspaceRequests} from '../runtime/desktop/workspace-requests.mjs';

function fixture(){
 const sender={},event={sender},foreign={sender:{}},calls=[];
 const host={acceptsSetup:value=>value===sender,acceptsWorkspace:value=>value.sender===sender,handleSetup:async(_event,action,input)=>{calls.push(['setup',action,input]);return {saved:true};}};
 const snapshot={selectedId:'project-one',projects:[]};let held=false;
 const requests=createWorkspaceRequests({selected:()=>host,snapshot:()=>snapshot,assertSetupAllowed(){if(held)throw Error('update reservation held');},select:async id=>{calls.push(['select',id]);},add:async()=>{calls.push(['add']);return snapshot;},rename:async(id,name)=>{calls.push(['rename',id,name]);},configureCapacity:async limit=>{if(!Number.isSafeInteger(limit)||limit<1||limit>64)throw Error('invalid capacity');calls.push(['capacity',limit]);},setWorkerLimit:async limit=>{calls.push(['limit',limit]);},changed:()=>calls.push(['changed']),writeClipboard:text=>calls.push(['clipboard',text])});
 return {requests,event,foreign,calls,snapshot,hold:()=>{held=true;}};
}

test('native requests reject foreign surfaces before clipboard, setup or registry mutations',async()=>{
 const f=fixture();
 assert.throws(()=>f.requests.clipboard(f.foreign,'text'),/rejected/);
 assert.throws(()=>f.requests.setup(f.foreign,'save',{}),/rejected/);
 await assert.rejects(f.requests.workspaces(f.foreign,'rename',{id:'project-one',name:'New'}),/rejected/);
 assert.deepEqual(f.calls,[]);
});

test('native unknown payloads cannot coerce absent names or invalid capacities into saved settings',async()=>{
 const f=fixture();
 for(const value of [{id:'project-one'},{id:'project-one',name:42},null,[]])await assert.rejects(f.requests.workspaces(f.event,'rename',value));
 for(const value of ['2',null,65,0,NaN])await assert.rejects(f.requests.workspaces(f.event,'capacity',value));
 assert.throws(()=>f.requests.setup(f.event,{},{}),/Invalid setup/);
 assert.throws(()=>f.requests.clipboard(f.event,{}));
 assert.deepEqual(f.calls,[]);
 await f.requests.workspaces(f.event,'rename',{id:'project-one',name:'New'});
 assert.deepEqual(f.calls,[['rename','project-one','New'],['changed']]);
});

test('native mutations respect the app owner update hold while read snapshots remain available',async()=>{
 const f=fixture();f.hold();
 assert.equal(await f.requests.workspaces(f.event,'snapshot'),f.snapshot);
 await assert.rejects(f.requests.workspaces(f.event,'add'),/held/);
 await assert.rejects(f.requests.workspaces(f.event,'rename',{id:'project-one',name:'New'}),/held/);
 assert.deepEqual(f.calls,[]);
});
