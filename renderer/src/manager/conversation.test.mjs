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
