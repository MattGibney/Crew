import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationTimeline } from '../runtime/manager/conversation/timeline.mjs';

test('several promotion fragments reference one native item and canonical replay updates its exact position', () => {
  const timeline = createConversationTimeline();
  timeline.realtime({ type:'bemItemPromoted', id:'promotion', itemId:'native' }, { position:4 });
  timeline.record({ type:'agentMessage', id:'native', text:'Result' },'turn',{ position:1 });
  timeline.realtime({ type:'bemItemPromoted', id:'fragment', itemId:'native' });
  assert.equal(timeline.snapshot().length,1);
  assert.equal(timeline.snapshot()[0].position,4);
  timeline.realtime({ type:'bemItemPromoted', id:'promotion', itemId:'native' },{ position:9 });
  assert.equal(timeline.snapshot()[0].position,9);
  timeline.realtime({ type:'bemItemPromoted', id:'second-fragment', itemId:'native' },{ position:10 });
  assert.equal(timeline.snapshot()[0].position,9);
});

test('long conversations expose a bounded recent window while retaining live utterance identity', () => {
  const timeline = createConversationTimeline();
  for(let index=0;index<600;index++) {
    timeline.record({ type:'agentMessage', id:`native-${index}`, text:String(index) },`turn-${index}`);
    timeline.snapshot();
  }
  assert.equal(timeline.snapshot().length,200);
  assert.equal(timeline.snapshot()[0].id,'native-400');
  timeline.realtime({ type:'transcriptSegment',id:'voice',role:'user',text:'' },{ status:'streaming' });
  timeline.delta('voice','Exact words');
  timeline.realtime({ type:'transcriptSegment',id:'voice',role:'user',text:'Exact words' });
  timeline.delta('voice',' duplicated');
  assert.equal(timeline.snapshot().find(message=>message.id==='voice').text,'Exact words');
});

test('duplicate empty started preserves streaming and later deltas; empty completed retains honest partial words',()=>{
 const timeline=createConversationTimeline();
 const item={type:'transcriptSegment',id:'live',role:'user',text:''};
 timeline.realtime(item,{status:'streaming'});timeline.delta('live','Hello');
 timeline.realtime(item,{status:'streaming'});timeline.delta('live',' world');
 assert.equal(timeline.snapshot()[0].text,'Hello world');
 assert.equal(timeline.snapshot()[0].status,'streaming');
 timeline.realtime(item,{status:'complete'});
 assert.equal(timeline.snapshot()[0].text,'Hello world');
 assert.equal(timeline.snapshot()[0].status,'partial');
});


test('promotion identity survives snapshot restoration and replay without relocating older speech',()=>{
 const timeline=createConversationTimeline();
 timeline.record({type:'agentMessage',id:'native',text:'Native result'},'turn');
 timeline.realtime({type:'bemItemPromoted',id:'promotion',itemId:'native'});
 timeline.realtime({type:'transcriptSegment',id:'later-speech',role:'user',text:'Later speech'});
 const snapshot=timeline.snapshot();
 const restored=createConversationTimeline();restored.restore(JSON.parse(JSON.stringify(snapshot)));
 restored.realtime({type:'bemItemPromoted',id:'promotion',itemId:'native'});
 restored.realtime({type:'bemItemPromoted',id:'second-fragment',itemId:'native'});
 assert.deepEqual(restored.snapshot(),JSON.parse(JSON.stringify(snapshot)));
});

test('restoring old native handoff rows repairs presentation while preserving identity, ordering and status', () => {
  const text = '<realtime_delegation><input>Current request</input><transcript_delta>assistant: historical context</transcript_delta></realtime_delegation>';
  const entries = [
    { id:'before',role:'assistant',text:'Earlier response',position:1,status:'complete' },
    { id:'native',turnId:'t',role:'user',text,position:2,status:'complete',promotionId:'promotion' },
    { id:'voice',role:'user',source:'voice',text:'Current request',position:3,status:'partial' },
  ];
  const original = structuredClone(entries), timeline = createConversationTimeline();
  timeline.restore(entries);
  assert.deepEqual(timeline.snapshot(), entries.map(entry => entry.id === 'native' ? {...entry,text:'Current request',presentation:'realtime-input-v1',origin:'realtime-delegation'} : entry));
  assert.deepEqual(entries,original,'Source records are not mutated');
  const restored = createConversationTimeline(); restored.restore(timeline.snapshot());
  assert.deepEqual(restored.snapshot(),timeline.snapshot());
});

test('a literal envelope in current user wording is projected once across repeated journal restores', () => {
  const input = '<realtime_delegation><input>literal example</input></realtime_delegation>';
  const text = `<realtime_delegation><input>${input}</input><transcript_delta>Old context</transcript_delta></realtime_delegation>`;
  let timeline = createConversationTimeline();
  timeline.record({id:'native',type:'userMessage',content:[{type:'text',text}]},'t');
  for (let i=0;i<3;i++) {
    assert.equal(timeline.snapshot()[0].text,input);
    const restored = createConversationTimeline();restored.restore(JSON.parse(JSON.stringify(timeline.snapshot())));timeline=restored;
  }
});

test('delegated backing exchange keeps exact turn provenance through late input and journal restore', () => {
  const timeline = createConversationTimeline();
  const input = { id:'request',type:'userMessage',content:[{type:'text',text:'<realtime_delegation><input>Review this</input></realtime_delegation>'}] };
  timeline.record({id:'reply',type:'agentMessage',text:'Detailed written result'},'delegated',{status:'streaming'});
  timeline.realtime({id:'speech',type:'transcriptSegment',role:'user',text:'Review this',realtimeSessionId:'call'});
  timeline.record(input,'delegated');
  timeline.record({id:'typed',type:'userMessage',content:[{type:'text',text:'Review this'}]},'typed-turn');
  timeline.record({id:'reply',type:'agentMessage',text:'Detailed written result completed'},'delegated');
  const messages=timeline.snapshot();
  assert.equal(messages.find(m=>m.id==='request').origin,'realtime-delegation');
  assert.equal(messages.find(m=>m.id==='reply').origin,'realtime-delegation');
  assert.equal(messages.find(m=>m.id==='reply').status,'complete');
  assert.equal(messages.find(m=>m.id==='typed').origin,undefined);
  assert.equal(messages.find(m=>m.id==='speech').origin,undefined);
  const restored=createConversationTimeline();restored.restore(JSON.parse(JSON.stringify(messages)));
  assert.deepEqual(restored.snapshot(),JSON.parse(JSON.stringify(messages)));
  // A bounded journal can begin after the user item; retained provenance matters.
  const bounded=createConversationTimeline();bounded.restore(messages.filter(m=>m.id!=='request'));
  bounded.record({id:'later-reply',type:'agentMessage',text:'Additional detail'},'delegated');
  assert.equal(bounded.snapshot().find(m=>m.id==='later-reply').origin,'realtime-delegation');
});

test('malformed saved overlay entries cannot break provenance hydration', () => {
 const timeline=createConversationTimeline();
 timeline.record({id:'typed',type:'agentMessage',text:'Retained response'},'typed-turn');
 const before=timeline.snapshot();
 timeline.restoreProvenance([null,false,{}, {id:5}, {id:'typed',turnId:'other',role:'assistant',origin:'realtime-delegation'}]);
 assert.deepEqual(timeline.snapshot(),before);
});
