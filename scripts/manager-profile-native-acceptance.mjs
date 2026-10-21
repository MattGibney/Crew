// Issue #35: real Electron/compiled renderer, disposable state and synthetic Codex/media.
// CREW_PLAYWRIGHT_MODULE may point to a bundled playwright-core/index.mjs.
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const { _electron } = await import(process.env.CREW_PLAYWRIGHT_MODULE || 'playwright-core');
const exec = promisify(execFile), root = process.cwd();
const dir = await mkdtemp(path.join(tmpdir(), 'crew-profile-native-'));
console.log('Disposable profile acceptance directory:', dir);
const executablePath = process.env.CREW_ACCEPTANCE_EXECUTABLE || path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const configPath = path.join(dir, 'first/project.json'), binary = path.join(dir, 'fake-codex');
const protocolPath = path.join(dir, 'protocol.jsonl');
const personality = 'Be calm, concise and curious. Explain decisions using concrete examples.';
const customPrompt = 'CUSTOM REPLACEMENT INSTRUCTIONS: preserve this text verbatim.';
const picture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
await writeFile(path.join(dir, 'portrait.png'), picture);
await writeFile(path.join(dir, 'invalid.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
await writeFile(binary, `#!${process.execPath}
import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';
if(process.argv.includes('--version')){console.log('codex-cli synthetic-profile');process.exit(0);}
for await(const line of createInterface({input:process.stdin})){
 const m=JSON.parse(line);appendFileSync(${JSON.stringify(protocolPath)},JSON.stringify({pid:process.pid,...m})+'\\n');
 if(m.id===undefined)continue;let result={};
 if(m.method==='account/read')result={account:{type:'chatgpt',planType:'synthetic'}};
 if(m.method==='config/read')result={config:{developer_instructions:'NORMAL CONFIG INSTRUCTIONS'}};
 if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:m.params.threadId||'retained-profile-manager'}};
 if(m.method==='thread/timeline/list')result={data:[{type:'item',position:0,turnId:'retained-turn',item:{id:'retained-message',type:'agentMessage',text:'Retained conversation before profile edits.'}}],nextCursor:null};
 if(m.method==='thread/turns/list')result={data:[{id:'retained-turn',status:'completed',items:[{id:'retained-message',type:'agentMessage',text:'Retained conversation before profile edits.'}]}],nextCursor:null};
 if(m.method==='mcpServerStatus/list')result={data:[]};
 if(m.method==='thread/realtime/listVoices')result={voices:{v3:['cove'],defaultV1:'cove'}};
 if(m.method==='thread/realtime/start'){
  console.log(JSON.stringify({method:'thread/realtime/started',params:{threadId:m.params.threadId}}));
  console.log(JSON.stringify({method:'thread/realtime/sdp',params:{threadId:m.params.threadId,sdp:'v=0 synthetic-answer'}}));
 }
 console.log(JSON.stringify({id:m.id,result}));
}
`, { mode: 0o700 });
await exec(process.execPath, [path.join(root, 'cli.mjs'), 'init', '--template', 'fixture', '--config', configPath]);
const config = JSON.parse(await readFile(configPath, 'utf8'));
config.runtime.port = 59235; config.runtime.codexBinary = binary; config.project.name = 'Profile acceptance one';
await writeFile(configPath, JSON.stringify(config, null, 2));
const dataDir = path.resolve(path.dirname(configPath), config.runtime.dataDir);
await mkdir(path.join(dataDir, 'orchestration', 'manager-profiles'), { recursive: true });
await writeFile(path.join(dataDir, 'manager-chat.json'), JSON.stringify({ threadId: 'retained-profile-manager' }));
const profilePath = path.join(dataDir, 'orchestration', 'manager-profiles', `${config.project.id}.json`);
// Upgrade an existing voice-only preference through the actual UI.
await writeFile(profilePath, JSON.stringify({ schemaVersion: 1, projectId: config.project.id, voice: 'cove' }));
const managerPromptPath = path.resolve(path.dirname(configPath), config.project.prompts.manager);
await writeFile(managerPromptPath, customPrompt);
const workerPromptPath = path.resolve(path.dirname(configPath), config.project.prompts.worker);
const workerBefore = await readFile(workerPromptPath, 'utf8');
const env = { ...process.env, CREW_APP_DATA: path.join(dir, 'app-data'), AI_MANAGER_CONFIG: configPath, AI_MANAGER_CODEX_BINARY: binary };
delete env.ELECTRON_RUN_AS_NODE;
delete env.AI_MANAGER_PORT; delete env.VOICE_PORT;
let electron, nativeProcess, page, expectedPort = 59235;
async function until(fn, label) { const end = Date.now() + 30000; while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); } throw Error(`Timed out: ${label}`); }
const calls = async () => (await readFile(protocolPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const settings = () => page.evaluate(() => fetch('/api/settings').then(response => response.json()));
async function launch() {
 electron = await _electron.launch({ executablePath, args: [root, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], env, timeout: 30000 });
 nativeProcess = electron.process(); nativeProcess.stderr.on('data', data => process.stderr.write(data));
 page = await electron.firstWindow(); await page.waitForURL(`http://127.0.0.1:${expectedPort}/**`);
 await page.getByText('Retained conversation before profile edits.', { exact: true }).waitFor();
}
async function quit() {
 if (!nativeProcess || nativeProcess.exitCode !== null || nativeProcess.signalCode !== null) return;
 // Close this disposable control surface first. This exercises supported
 // close-then-Quit and prevents the test EventSource reconnecting during drain.
 await electron.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.close(); });
 await electron.evaluate(({ dialog, Menu }) => { dialog.showMessageBox = async () => ({ response: 1 }); Menu.getApplicationMenu().items[0].submenu.items.find(item => item.label === 'Quit Crew…').click(); });
 // Release the automation inspector after the ordinary native lifecycle request.
 let detachTimer;
 try { await Promise.race([electron.close(), new Promise((_, reject) => { detachTimer = setTimeout(() => reject(Error('Timed out detaching native automation')), 30000); })]); }
 finally { clearTimeout(detachTimer); }
 await until(() => nativeProcess.exitCode !== null || nativeProcess.signalCode !== null, 'native Quit exit');
}

async function openProfile() { await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('button', { name: 'Manager profile', exact: true }).click(); }
try {
 await launch();
 const original = await settings();
 assert.equal(original.managerProfile.name, ''); assert.equal(original.managerProfile.picture, null); assert.equal(original.managerProfile.voice, 'cove');
 const initialThread = (await calls()).find(call => call.method === 'thread/resume');
 assert.ok(initialThread.params.developerInstructions.includes(customPrompt));
 assert.ok(!initialThread.params.developerInstructions.includes('Configured manager profile'));
 await openProfile();
 await page.getByRole('button', { name: 'Update manager name and picture' }).click();
 await page.getByLabel('Manager name', { exact: true }).fill('Morgan');
 await page.getByLabel('Manager picture', { exact: true }).setInputFiles(path.join(dir, 'invalid.svg'));
 await page.getByRole('alert').filter({ hasText: /PNG, JPEG or WebP/ }).waitFor();
 assert.equal((await settings()).managerProfile.picture, null);
 await page.getByLabel('Manager picture', { exact: true }).setInputFiles(path.join(dir, 'portrait.png'));
 await page.locator('[aria-labelledby="manager-identity-heading"]').getByRole('button', { name: 'Save', exact: true }).click();
 await until(async () => (await settings()).managerProfile.name === 'Morgan', 'name save');
 await page.getByRole('button', { name: 'Update manager personality' }).click();
 await page.getByLabel('Manager personality', { exact: true }).fill(personality);
 await page.locator('[aria-labelledby="manager-personality-heading"]').getByRole('button', { name: 'Save', exact: true }).click();
 await until(async () => (await settings()).managerProfile.personality === personality, 'personality save');
 let saved = await settings();
 assert.equal(saved.managerProfile.voice, 'cove'); assert.ok(saved.managerProfile.picture.startsWith('data:image/png;base64,'));
 assert.equal(saved.manager.pendingRestart, true);
 assert.equal(await readFile(managerPromptPath, 'utf8'), customPrompt); assert.equal(await readFile(workerPromptPath, 'utf8'), workerBefore);
 await page.screenshot({ path: path.join(dir, 'manager-profile-settings.png'), fullPage: true });
 await page.getByRole('button', { name: 'Settings', exact: true }).click();
 await page.getByRole('article', { name: 'Manager message' }).getByText('Morgan', { exact: true }).waitFor();
 const displayed = page.getByRole('article', { name: 'Manager message' }).locator('img');
 assert.ok((await displayed.getAttribute('src')).startsWith('data:image/png;base64,'));
 await page.screenshot({ path: path.join(dir, 'manager-profile-conversation.png') });
 await page.reload(); await page.getByText('Retained conversation before profile edits.', { exact: true }).waitFor();
 assert.equal((await settings()).manager.pendingRestart, true);
 await quit(); await launch();
 saved = await settings(); assert.equal(saved.managerProfile.name, 'Morgan'); assert.equal(saved.manager.pendingRestart, true);
 assert.equal(saved.managerProfile.personality, personality); assert.equal(saved.managerProfile.voice, 'cove');
 assert.ok(!(await calls()).filter(call => call.method === 'thread/resume').at(-1).params.developerInstructions.includes(personality));
 await openProfile(); await page.getByRole('button', { name: 'Sessions', exact: true }).click();
 await page.getByRole('button', { name: 'Restart manager', exact: true }).click();
 await until(async () => !(await settings()).manager.pendingRestart, 'explicit restart applies profile');
 const resumed = (await calls()).filter(call => call.method === 'thread/resume').at(-1);
 assert.equal(resumed.params.threadId, 'retained-profile-manager');
 assert.ok(resumed.params.developerInstructions.includes(customPrompt));
 assert.ok(resumed.params.developerInstructions.includes('NORMAL CONFIG INSTRUCTIONS'));
 assert.ok(resumed.params.developerInstructions.includes(personality));
 assert.ok(resumed.params.developerInstructions.includes('Morgan'));
 await page.getByRole('button', { name: 'Settings', exact: true }).click();
 await page.evaluate(await readFile(path.join(root, 'tests/fixtures/browser-media.js'), 'utf8'));
 await page.getByRole('tab', { name: 'Voice', exact: true }).click();
 await page.getByRole('button', { name: 'Connect voice', exact: true }).click();
 await page.getByText('Voice connected', { exact: true }).first().waitFor();
 const realtime = (await calls()).find(call => call.method === 'thread/realtime/start');
 assert.equal(realtime.params.voice, 'cove');
 assert.ok(realtime.params.initialItems[0].text.includes(customPrompt));
 assert.ok(realtime.params.initialItems[0].text.includes(personality));
 assert.ok(realtime.params.realtimeStartInstructions.includes(personality));
 assert.ok(realtime.params.realtimeEndInstructions.includes(personality));
 assert.ok(realtime.params.initialItems[0].text.includes('Morgan'));
 assert.equal(await page.evaluate(() => window.__crewMedia.calls), 1);
 assert.ok(!(await calls()).some(call => call.method === 'turn/start'), 'navigation, restart and synthetic voice connection start no manager turn');
 assert.equal(JSON.parse(await readFile(path.join(dataDir, 'manager-chat.json'), 'utf8')).threadId, 'retained-profile-manager');
 await page.getByRole('button', { name: 'End call', exact: true }).click();
 await until(async () => (await page.evaluate(() => window.__crewMedia.tracks.every(track => track.readyState === 'ended'))), 'synthetic media released');
 await openProfile();
 await page.getByRole('button', { name: 'Update manager name and picture' }).click();
 await page.getByLabel('Manager name', { exact: true }).fill('');
 await page.getByRole('button', { name: 'Remove picture', exact: true }).click();
 await page.locator('[aria-labelledby="manager-identity-heading"]').getByRole('button', { name: 'Save', exact: true }).click();
 await until(async () => (await settings()).managerProfile.picture === null, 'picture removal');
 await page.getByRole('button', { name: 'Settings', exact: true }).click();
 await page.getByRole('article', { name: 'Manager message' }).getByText('Manager', { exact: true }).waitFor();
 assert.ok(!(await page.getByRole('article', { name: 'Manager message' }).locator('img').getAttribute('src')).startsWith('data:'));
 await page.screenshot({ path: path.join(dir, 'manager-profile-fallback.png') });
 // Exercise the maximum supported unbroken name in the actual narrow renderer.
 await openProfile();
 await page.getByRole('button', { name: 'Update manager name and picture' }).click();
 await page.getByLabel('Manager name', { exact: true }).fill('W'.repeat(80));
 await page.locator('[aria-labelledby="manager-identity-heading"]').getByRole('button', { name: 'Save', exact: true }).click();
 await until(async () => (await settings()).managerProfile.name.length === 80, 'long name save');
 await page.setViewportSize({ width: 390, height: 844 });
 assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'narrow Settings does not overflow');
 await page.screenshot({ path: path.join(dir, 'manager-profile-narrow.png'), fullPage: true });
 await page.getByRole('button', { name: 'Settings', exact: true }).click();
 await page.getByRole('article', { name: 'Manager message' }).getByText('W'.repeat(80), { exact: true }).waitFor();
 assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'narrow conversation does not overflow');
 await quit();
 const secondPath = path.join(dir, 'second/project.json');
 await exec(process.execPath, [path.join(root, 'cli.mjs'), 'init', '--template', 'fixture', '--config', secondPath]);
 const second = JSON.parse(await readFile(secondPath, 'utf8'));
 second.runtime.port = 59236; second.runtime.codexBinary = binary; second.project.id = 'profile-two'; second.project.name = 'Profile acceptance two';
 await writeFile(secondPath, JSON.stringify(second));
 const secondData = path.resolve(path.dirname(secondPath), second.runtime.dataDir);
 await mkdir(secondData, { recursive: true });
 await writeFile(path.join(secondData, 'manager-chat.json'), JSON.stringify({ threadId: 'retained-profile-two' }));
 env.AI_MANAGER_CONFIG = secondPath; expectedPort = 59236;
 await launch();
 const other = await settings();
 assert.equal(other.managerProfile.name, ''); assert.equal(other.managerProfile.picture, null); assert.equal(other.managerProfile.personality, ''); assert.equal(other.managerProfile.voice, null);
 const registry = await page.evaluate(() => window.crewWorkspaces.snapshot());
 assert.equal(registry.projects.length, 2);
 assert.equal(JSON.parse(await readFile(profilePath, 'utf8')).personality, personality);
 assert.ok(!(await calls()).filter(call => call.method === 'thread/resume').at(-1).params.developerInstructions.includes(personality));
 await quit();
 const result = { pass: true, dir, savedAndRelaunched: true, quitSequence: 'close-window-then-native-Quit-and-inspector-detach', ordinaryOpenWindowQuitProven: false, oldVoiceProfileMigrated: true, projectIsolation: true, narrowLongName: true, unchangedVoice: true, preservedHistoryAndPrompts: true, explicitRestart: true, syntheticNativeInstructionProtocol: true, physicalMicrophone: false, realModelBehavior: false };
 await writeFile(path.join(dir, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) {
 console.error('Native profile acceptance failed:', error.message);
 if (page && !page.isClosed()) { await page.screenshot({ path: path.join(dir, 'failure.png'), fullPage: true }).catch(() => {}); console.error((await page.locator('body').innerText().catch(() => '')).slice(0, 8000)); }
 throw error;
} finally { await quit().catch(error => console.error('Disposable native cleanup:', error.message)); }
