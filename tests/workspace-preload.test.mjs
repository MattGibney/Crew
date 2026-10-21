import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

function loadBridge() {
  let bridge, nativeWindow;
  const calls = [];
  const listeners = new Map();
  const contextBridge = { exposeInMainWorld(name, value) { if(name === 'crewWorkspaces') bridge = value; else { assert.equal(name, 'crewWindow'); nativeWindow = value; } } };
  const ipcRenderer = {
    async invoke(...args) { calls.push(args); return { selectedId: 'project-one' }; },
    on(channel, listener) { listeners.set(channel, listener); },
    removeListener(channel, listener) { if (listeners.get(channel) === listener) listeners.delete(channel); }
  };
  vm.runInNewContext(fs.readFileSync(new URL('../desktop/workspace-preload.cjs', import.meta.url), 'utf8'), { process: { platform: 'darwin' }, require(name) { assert.equal(name, 'electron'); return { contextBridge, ipcRenderer }; } });
  return { bridge, nativeWindow, calls, listeners, ipcRenderer };
}

test('workspace bridge exposes only scoped operations and validates mutations before IPC', async () => {
  const { bridge, calls } = loadBridge();
  assert.deepEqual(Object.keys(bridge).sort(), ['add', 'rename', 'select', 'setWorkerLimit', 'snapshot', 'subscribe'].sort());
  for (const invalid of ['', null, 12, 'x'.repeat(201)]) assert.throws(() => bridge.select(invalid));
  for (const invalid of [0, -1, 65, 1.2, '2', NaN]) assert.throws(() => bridge.setWorkerLimit(invalid));
  for (const invalid of [null, { id: 'one', name: '' }, { id: '', name: 'Two' }, { id: 'one', name: 'x'.repeat(101) }]) assert.throws(() => bridge.rename(invalid));
  assert.equal(calls.length, 0);
  await bridge.snapshot(); await bridge.select('project-one'); await bridge.add();
  await bridge.rename({ id: 'project-one', name: '  Product  ', unrelated: 'ignored' }); await bridge.setWorkerLimit(3);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['crew:workspaces', 'snapshot', null], ['crew:workspaces', 'select', 'project-one'],
    ['crew:workspaces', 'add', null], ['crew:workspaces', 'rename', { id: 'project-one', name: 'Product' }],
    ['crew:workspaces', 'capacity', 3]
  ]);
});

test('workspace change subscription strips the Electron event and cleans up its own listener', () => {
  const { bridge, listeners } = loadBridge();
  const received = [];
  const unsubscribe = bridge.subscribe((...args) => received.push(args));
  const snapshot = { selectedId: 'two', projects: [] };
  listeners.get('crew:workspaces:changed')({ sender: 'private' }, snapshot);
  assert.deepEqual(received, [[snapshot]]);
  unsubscribe(); assert.equal(listeners.size, 0);
  assert.throws(() => bridge.subscribe('not a function'));
});

test('workspace bridge returns readable main-process errors', async () => {
  const { bridge, ipcRenderer } = loadBridge();
  ipcRenderer.invoke = async () => { throw new Error("Error invoking remote method 'crew:workspaces': Error: Project is unavailable."); };
  await assert.rejects(bridge.select('one'), /Project is unavailable\./);
});


test('native window capability is write-only and rejects unbounded or structured clipboard input before IPC', async () => {
 const {nativeWindow,calls}=loadBridge();
 assert.equal(nativeWindow.integratedTitlebar,true);
 assert.deepEqual(Object.keys(nativeWindow).sort(),['copyText','integratedTitlebar']);
 assert.equal(Object.isFrozen(nativeWindow),true);
 for(const value of [null,42,{text:'private'},'x'.repeat(1000001)])assert.throws(()=>nativeWindow.copyText(value));
 assert.equal(calls.length,0);
 await nativeWindow.copyText('const value = 1;\n');
 assert.deepEqual(calls,[['crew:clipboard-write','const value = 1;\n']]);
});
