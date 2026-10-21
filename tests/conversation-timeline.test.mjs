import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationTimeline } from '../conversation-timeline.mjs';

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
