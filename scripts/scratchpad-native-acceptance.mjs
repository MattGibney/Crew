// GitHub #26: source Electron, real controller/storage/MCP, synthetic provider.
// Explicit temporary profile/config only; no physical microphone or installed app.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import { ManagerScratchpad } from '../runtime/manager/scratchpad.mjs';
const { _electron } = await import(process.env.CREW_PLAYWRIGHT_MODULE || 'playwright-core');
const exec = promisify(execFile), root = process.cwd();
const dir = await mkdtemp(path.join(tmpdir(), 'crew-scratchpad-native-'));
const executablePath = process.env.CREW_ACCEPTANCE_EXECUTABLE || path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const binary = path.join(dir, 'synthetic-codex'), protocolPath = path.join(dir, 'protocol.jsonl');
const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
await writeFile(binary, `#!${process.execPath}
import {createInterface} from 'node:readline';import{appendFileSync}from'node:fs';
if(process.argv.includes('--version')){console.log('codex-cli synthetic');process.exit(0);}
for await(const line of createInterface({input:process.stdin})){
const m=JSON.parse(line);appendFileSync(${JSON.stringify(protocolPath)},JSON.stringify(m)+'\\n');
if(m.id===undefined)continue;let result={};
if(m.method==='account/read')result={account:{type:'chatgpt',planType:'synthetic'}};
if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:m.params.threadId||'scratchpad-synthetic-manager'}};
if(['thread/turns/list','thread/timeline/list','mcpServerStatus/list'].includes(m.method))result={data:[],nextCursor:null};
if(m.method==='thread/realtime/listVoices')result={voices:{v3:['cove'],defaultV1:'cove'}};
console.log(JSON.stringify({id:m.id,result}));}
`, { mode: 0o700 });
const configPath = path.join(dir, 'project', 'project.json');
await exec(process.execPath, [path.join(root, 'runtime/cli.mjs'), 'init', '--template', 'fixture', '--config', configPath]);
const raw = JSON.parse(await readFile(configPath, 'utf8'));
raw.runtime.port = port; raw.runtime.codexBinary = binary; raw.project.name = 'Scratchpad native acceptance';
await writeFile(configPath, JSON.stringify(raw, null, 2));
const stateDir = path.resolve(path.dirname(configPath), raw.runtime.dataDir, 'orchestration');
const pad = new ManagerScratchpad({ stateDir });
await pad.update({ expectedRevision: 0, commitments: Array.from({ length: 4 }, (_, index) => ({ id: `request-${index + 1}`, title: `Explicit native request ${index + 1}`, status: 'pending', nextAction: 'Wait for the authorized follow-up.' })), notes: ['Native persisted project note.'], decisions: ['Use the current project only.'], questions: ['Which request needs review first?'] });
// A retained synthetic manager profile follows the existing native acceptance pattern.
await writeFile(path.resolve(stateDir, '..', 'manager-chat.json'), JSON.stringify({ threadId: 'scratchpad-synthetic-manager' }));
const otherPad = new ManagerScratchpad({ stateDir: path.join(dir, 'other-project', 'orchestration') });
await otherPad.update({ expectedRevision: 0, notes: ['Other project private note.'] });
const env = { ...process.env, CREW_APP_DATA: path.join(dir, 'app-data'), AI_MANAGER_CONFIG: configPath, AI_MANAGER_CODEX_BINARY: binary };
delete env.ELECTRON_RUN_AS_NODE; delete env.AI_MANAGER_PORT; delete env.VOICE_PORT;
let electron, nativeProcess;
const until = async (fn, label) => { const deadline = Date.now() + 30000; while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); } throw Error(`Timed out: ${label}`); };
const quit = async () => { if (!electron || nativeProcess.exitCode !== null) return; await electron.evaluate(({ dialog, Menu }) => { dialog.showMessageBox = async () => ({ response: 1 }); Menu.getApplicationMenu().items[0].submenu.items.find(item => item.label === 'Quit Crew…').click(); }); await until(() => nativeProcess.exitCode !== null, 'owned source Electron exits'); };
const launch = async () => { electron = await _electron.launch({ executablePath, args: [root, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], env, timeout: 30000 }); nativeProcess = electron.process(); const page = await electron.firstWindow(); await page.waitForURL(`http://127.0.0.1:${port}/**`); return page; };
const callMcp = input => new Promise((resolve, reject) => { const child = spawn(process.execPath, [path.join(root, 'runtime/orchestration-mcp.mjs'), stateDir, 'manager'], { stdio: ['pipe', 'pipe', 'pipe'] }); let out = '', error = ''; child.stdout.on('data', chunk => out += chunk); child.stderr.on('data', chunk => error += chunk); child.on('error', reject); child.on('exit', code => { if (code) return reject(Error(error)); try { const response = JSON.parse(out.trim()); assert.equal(response.result.isError, undefined, response.result.content?.[0]?.text); resolve(JSON.parse(response.result.content[0].text)); } catch (failure) { reject(failure); } }); child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'update_manager_scratchpad', arguments: { patchJson: JSON.stringify(input) } } }) + '\n'); });
// Cleanup is in place before observing native startup; only this profile is owned.
try {
  let page = await launch(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: 'Scratchpad', exact: true }).click();
  let view = page.getByRole('region', { name: 'Manager scratchpad', exact: true });
  await view.getByText('Explicit native request 4', { exact: true }).waitFor();
  assert.equal(await view.getByRole('textbox').count(), 0);
  assert.equal(await view.getByText('Other project private note.', { exact: true }).count(), 0);
  await page.screenshot({ path: path.join(dir, 'native-scratchpad.png') });
  const updated = await callMcp({ expectedRevision: 1, notes: ['Real MCP correction arrived in native UI.'] });
  assert.equal(updated.revision, 2);
  await view.getByText('Real MCP correction arrived in native UI.', { exact: true }).waitFor({ timeout: 10000 });
  assert.deepEqual((await otherPad.snapshot()).notes, ['Other project private note.']);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  await page.getByRole('button', { name: 'Stop manager', exact: true }).click();
  await page.waitForFunction(async () => (await fetch('/api/settings').then(response => response.json())).managerLifecycle.state === 'stopped');
  const stopped = JSON.parse(await readFile(path.join(stateDir, 'manager-lifecycle.json'), 'utf8'));
  assert.equal(stopped.intent, 'stopped');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await view.getByRole('heading', { name: 'Manager scratchpad', exact: true }).waitFor();
  await page.screenshot({ path: path.join(dir, 'native-scratchpad-stopped.png') });
  await electron.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.close(); });
  await until(() => electron.windows().length === 0, 'window close');
  const marker = JSON.parse(await readFile(path.resolve(stateDir, '..', 'server.json'), 'utf8'));
  process.kill(marker.pid, 0);
  const existing = (await readFile(protocolPath, 'utf8')).trim().split('\n').map(JSON.parse);
  await quit();
  assert.throws(() => process.kill(marker.pid, 0), 'Owned controller exits on explicit Quit');
  page = await launch();
  await page.getByRole('button', { name: 'Scratchpad', exact: true }).click();
  view = page.getByRole('region', { name: 'Manager scratchpad', exact: true });
  await view.getByText('Real MCP correction arrived in native UI.', { exact: true }).waitFor();
  assert.equal((await page.evaluate(async () => fetch('/api/settings').then(response => response.json()))).managerLifecycle.state, 'stopped');
  const nativeState = await page.evaluate(async () => fetch('/api/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(response => response.json()));
  assert.equal(nativeState.voiceActive, false); assert.equal(nativeState.managerScratchpad.revision, 2);
  const all = (await readFile(protocolPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(all.slice(existing.length), [], 'Stopped manager never starts the synthetic provider on reopen');
  assert.ok(!all.some(message => ['turn/start', 'thread/realtime/start'].includes(message.method)), 'No model turns or voice were started');
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(dir, 'native-scratchpad-reopened.png') });
  await quit();
  console.log(JSON.stringify({ passed: true, dir, sourceElectron: true, realControllerStorageMcp: true, syntheticProvider: true, physicalMicrophone: false, checks: ['four commitments', 'read-only', 'MCP correction to SSE UI', 'project storage isolation', 'explicit Stop', 'window close retains controller', 'Quit exits controller', 'restart preserves stopped manager and scratchpad', 'no provider restart, turn or voice'] }, null, 2));
} catch (error) { console.error('Native evidence:', dir); for (const page of electron?.windows() || []) { console.error('Native window:', page.url(), (await page.locator('body').innerText().catch(() => '')).slice(0,2000)); await page.screenshot({ path: path.join(dir, 'native-failure.png') }).catch(() => {}); } throw error; } finally { await quit().catch(error => console.error('Owned native cleanup:', error.message)); }
