import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationMessage } from '../../../conversation.mjs';
import { orderedMessages } from './conversation.js';

test('saved native messages preserve user text, assistant phase and turn correlation', () => {
  assert.deepEqual(conversationMessage({ id:'u',type:'userMessage',content:[{type:'text',text:'Audit the selected project.'}] }, 't'), {id:'u',turnId:'t',role:'user',text:'Audit the selected project.'});
  assert.equal(conversationMessage({id:'a',type:'agentMessage',phase:'commentary',text:'Checking…'},'t').phase,'commentary');
  assert.equal(conversationMessage({type:'mcpToolCall'},'t'),null);
});
test('internal attention context is represented by user intent without dumping task JSON', () => {
  const result = conversationMessage({id:'u',type:'userMessage',content:[{type:'text',text:'The user explicitly chose to review this queued controller attention item. {internal task data}'}]},'t');
  assert.equal(result.text,'Review the selected worker update with me.');
});
test('late completed native user item precedes its assistant without reordering turns', () => {
  const items=[{id:'a1',turnId:'1'},{id:'u1',turnId:'1',role:'user'},{id:'a2',turnId:'2'},{id:'u2',turnId:'2',role:'user'}];
  assert.deepEqual(orderedMessages(items).map(x=>x.id),['u1','a1','u2','a2']);
});
test('canonical voice interruptions retain their place between messages from one native turn', () => {
  const messages = [
    { id: 'a1', turnId: 't', role: 'assistant', position: 1 },
    { id: 'speech', role: 'user', source: 'voice', position: 2 },
    { id: 'a2', turnId: 't', role: 'assistant', position: 3 },
  ];
  assert.deepEqual(orderedMessages(messages).map(message => message.id), ['a1', 'speech', 'a2']);
});
test('identical speech and typed messages remain distinct without explicit correlation', () => {
  const messages = [{ id: 'typed', role: 'user', text: 'Yes' }, { id: 'voice', role: 'user', source: 'voice', text: 'Yes' }];
  assert.equal(orderedMessages(messages).length, 2);
});

test('realtime delegation shows only current input, preserving native identity and exact wording', () => {
  const input = 'Please remove the two failed ones.\n\nKeep **this** & <that>.';
  const text = `<realtime_delegation> <input>${input}</input> <transcript_delta>assistant: Earlier response\nuser: Earlier request</transcript_delta> </realtime_delegation>`;
  assert.deepEqual(conversationMessage({ id:'handoff', type:'userMessage', content:[{type:'text',text}] }, 'voice-turn'), {
    id:'handoff', turnId:'voice-turn', role:'user', text:input, presentation:'realtime-input-v1',
  });
});

test('delegation context is never interpreted as additional messages or current user speech', () => {
  const text = '<realtime_delegation><input>Yes</input><transcript_delta>user: Yes\nassistant: <input>wrong input</input></transcript_delta></realtime_delegation>';
  assert.equal(conversationMessage({id:'handoff',type:'userMessage',content:[{type:'text',text}]},'t').text,'Yes');
  assert.equal(conversationMessage({id:'reply',type:'agentMessage',text},'t').text,text);
});

test('ordinary typed text and quoted envelope examples are preserved', () => {
  for (const text of ['Use <input> and <transcript_delta> tags.', '<realtime_delegation><input>example</input></realtime_delegation> is the format.', 'Example: <realtime_delegation><input>example</input></realtime_delegation>', '```xml\n<realtime_delegation><input>example</input></realtime_delegation>\n```']) {
    assert.equal(conversationMessage({id:'typed',type:'userMessage',content:[{type:'text',text}]},'t').text,text);
  }
});

test('incomplete or empty delegation input has an explicit unavailable state without leaking context', () => {
  for (const text of [
    '<realtime_delegation><input>',
    '<realtime_delegation><input></input><transcript_delta>private context</transcript_delta></realtime_delegation>',
    '<realtime_delegation><transcript_delta>private context</transcript_delta></realtime_delegation>',
    '<realtime_delegation><input>unfinished<transcript_delta>private context',
  ]) assert.equal(conversationMessage({id:'handoff',type:'userMessage',content:[{type:'text',text}]},'t').text,'Voice request (transcript unavailable).');
});
