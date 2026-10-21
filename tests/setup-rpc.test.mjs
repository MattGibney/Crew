import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSetupRpc, initializeSetupRpc } from '../runtime/desktop/setup-rpc.mjs';

test('disposable setup transport distinguishes native requests from colliding client response IDs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'crew-setup-rpc-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const executable = join(root, 'fake-codex');
  await writeFile(executable, `#!${process.execPath}\nimport {createInterface} from 'node:readline';
let initialization;
for await(const line of createInterface({input:process.stdin})) {
 const message=JSON.parse(line);
 if(message.method==='initialize') {
  initialization=message.id;
  console.log(JSON.stringify({id:initialization,method:'mcpServer/elicitation/request',params:{message:'Setup must not approve this.'}}));
 } else if(message.error&&message.id===initialization) {
  console.log(JSON.stringify({id:initialization,result:{capabilities:{}}}));
 } else if(message.method==='account/read') {
  console.log(JSON.stringify({id:message.id,result:{account:{type:'chatgpt'}}}));
 }
}
`);
  await chmod(executable, 0o700);
  const client = openSetupRpc({executable, root, timeoutMs:2000});
  t.after(() => client.close());
  await initializeSetupRpc(client, 'crew_setup_collision_test');
  const reply = await client.request('account/read');
  assert.deepEqual(reply, {account:{type:'chatgpt'}});
});
