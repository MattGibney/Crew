import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplicationOrigins} from '../src/manager/bridge/origins.mts';
import {createConversationTimeline} from '../src/manager/conversation/timeline.mts';

test('application activity stays private live, after reload, and when native history is restored', async t => {
 const dir=await mkdtemp(join(tmpdir(),'crew-activity-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=join(dir,'manager.json'), timeline=createConversationTimeline();
 const origins=createApplicationOrigins(file);await origins.ready;
 const old={id:'old-review',turnId:'old',role:'user',text:'An older visible entry'};
 timeline.restore([old]);
 await origins.begin('request', {source:'scheduled-review',operationId:'schedule'},null,timeline.snapshot());
 const internal=[{id:'native-input',turnId:'new',role:'user',text:'check workers'},{id:'native-output',turnId:'new',role:'assistant',text:'Checking workers now.'}];
 for(const m of internal){timeline.restore([m]);origins.observed(m);}
 // Notifications can arrive before turn/start acknowledgement.
 assert.deepEqual(timeline.snapshot().filter(m=>!origins.hidden(m)).map(m=>m.id),['old-review']);
 await origins.acknowledged('new');await origins.flush();
 const restored=createApplicationOrigins(file);await restored.ready;
 assert.deepEqual([...internal,old].filter(m=>!restored.hidden(m)).map(m=>m.id),['old-review']);
 assert.equal(restored.hidden({id:'voice',source:'voice',turnId:'new',role:'user',text:'check workers'}),false);
 await restored.begin('human',undefined,'new',timeline.snapshot());
 const human={id:'human-input',turnId:'new',role:'user',text:'check workers'};
 const reply={id:'human-reply',turnId:'new',role:'assistant',text:'Here is your update.'};
 assert.equal(restored.hidden(human),false);assert.equal(restored.hidden(reply),false);
 assert.equal(restored.hidden(internal[0]),true);assert.equal(restored.hidden(internal[1]),true);
 await restored.flush();
 const again=createApplicationOrigins(file);await again.ready;
 assert.equal(again.hidden(human),false);assert.equal(again.hidden(internal[0]),true);
});

test('preparation can hide its new input while preserving the pre-existing human turn',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'crew-preparation-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const origins=createApplicationOrigins(join(dir,'manager.json'));await origins.ready;
 const human={id:'human',turnId:'active',role:'user',text:'My request'};
 await origins.begin('prepare',{source:'preparation',operationId:'prepare-1'},'active',[human]);
 assert.equal(origins.hidden(human),false);
 assert.equal(origins.hidden({id:'prep',turnId:'active',role:'user',text:'Prepare to restart'}),true);
 await origins.acknowledged('active');
});

test('late native echo matches exact client identity without hiding a later human direction',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'crew-late-echo-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const origins=createApplicationOrigins(join(dir,'manager.json'));await origins.ready;
 await origins.begin('scheduled-native-id',{source:'scheduled-review',operationId:'schedule'},null,[]);await origins.acknowledged('turn');
 await origins.begin('human-id',undefined,'turn',[]);
 const echo={id:'scheduled-native-id',turnId:'turn',role:'user',text:'Same words'};
 assert.equal(origins.hidden(echo),true);
 assert.equal(origins.hidden({id:'human-id',turnId:'turn',role:'user',text:'Same words'}),false);
 assert.equal(origins.hidden({id:'reply',turnId:'turn',role:'assistant',text:'Your reply'}),false);
 await origins.flush();
});

test('failed internal dispatch does not classify the next real human turn as background',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'crew-failed-activity-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const origins=createApplicationOrigins(join(dir,'manager.json'));await origins.ready;
 await origins.begin('failed',{source:'scheduled-review',operationId:'schedule'},null,[]);await origins.failed();
 await origins.begin('human',undefined,null,[]);await origins.acknowledged('human-turn');
 assert.equal(origins.hidden({id:'human',turnId:'human-turn',role:'user',text:'Hello'}),false);await origins.flush();
});
