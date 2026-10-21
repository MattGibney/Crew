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
