#!/usr/bin/env node
// AI-006: dependency-free macOS local lifecycle and portable source packaging.
import { readFile, writeFile, mkdir, copyFile, access, open, stat, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareCrewStorage } from './desktop/storage.mjs';
import { appRoot, loadAppConfig } from './config.mjs';
const run = promisify(execFile);
const sleep = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const safe = value => String(value).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/sk-[\w-]+/g, '[redacted]').slice(0, 1200);
const exists = async path => { try { await access(path); return true; } catch { return false; } };
const defaultInstanceConfig=join(homedir(),'Library','Application Support','Crew','instances','default','project.json');
const usage = `Crew — one project per instance

  node cli.mjs init [--template fixture|set1] [--config path]
  node cli.mjs doctor [--config path]
  node cli.mjs validate [--config path]
  node cli.mjs start [--config path] [--background]
  node cli.mjs status [--config path]
  node cli.mjs stop [--config path]
  node cli.mjs package [--output path.tar.gz]

init never overwrites configuration or prompts. start stays in the foreground
unless --background is supplied. stop ends only this instance's local server;
already launched workers retain their independent lifecycle. No login daemon
or cloud deployment is installed. Each other project needs a separate instance,
configuration, data directory and port. Use existing ChatGPT sign-in only.`;
function parse(args) {
  const command = args.shift() || 'help';
  if (['help', '--help', '-h'].includes(command)) return { command: 'help' };
  if (!['init', 'doctor', 'validate', 'start', 'status', 'stop', 'package'].includes(command)) throw new Error(`Unknown command "${command}". Run node cli.mjs --help.`);
  const options = { command };
  const allowed = { init: ['--config', '--template'], doctor: ['--config'], validate: ['--config'], start: ['--config', '--background'], status: ['--config'], stop: ['--config'], package: ['--output'] }[command];
  while (args.length) {
    const flag = args.shift();
    if (!allowed.includes(flag) || flag in options) throw new Error(`Unsupported or repeated option "${flag}" for ${command}.`);
    if (flag === '--background') options[flag] = true;
    else { const value = args.shift(); if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`); options[flag] = value; }
  }
  return options;
}
async function initialize(options) {
  const template = options['--template'] || 'fixture';
  if (!['fixture', 'set1'].includes(template)) throw new Error('--template must be fixture or set1.');
  const target = resolve(options['--config'] || process.env.AI_MANAGER_CONFIG || defaultInstanceConfig);
  const folder = dirname(target), promptDir = join(folder, 'prompts');
  const targets = [target, join(promptDir, 'manager.md'), join(promptDir, 'worker.md')];
  for (const path of targets) if (await exists(path)) throw new Error(`Refusing to overwrite ${path}. Edit the existing instance files, or select a new config directory.`);
  const config = JSON.parse(await readFile(join(appRoot, 'config', `${template}.example.json`), 'utf8'));
  config.runtime.dataDir = folder === resolve(appRoot, 'config') ? '../.data' : '.data';
  config.project.prompts = { manager: 'prompts/manager.md', worker: 'prompts/worker.md' };
  await mkdir(promptDir, { recursive: true, mode: 0o700 });
  const created = [];
  try {
    for (const role of ['manager', 'worker']) {
      const promptTarget = join(promptDir, `${role}.md`);
      await copyFile(join(appRoot, 'prompts', `${role}.md`), promptTarget, constants.COPYFILE_EXCL); created.push(promptTarget);
    }
    await writeFile(target, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); created.push(target);
  } catch (error) { for (const path of created) await unlink(path).catch(() => {}); throw error; }
  console.log(`Created ${target}\nEditable manager/worker prompts: ${promptDir}\n${template === 'set1' ? 'Set1 is a template: confirm repository paths, base refs and Linear identifiers before dispatch. No work was launched.' : 'Disposable read-only fixture selected. No worker was launched.'}\nNext: node cli.mjs doctor --config ${JSON.stringify(target)}`);
}
async function readMarker(config) {
  if (!await exists(config.serverStatePath)) return null;
  let marker;
  try { marker = JSON.parse(await readFile(config.serverStatePath, 'utf8')); } catch { throw new Error(`Cannot read this instance's server marker at ${config.serverStatePath}. No process was stopped.`); }
  if (!Number.isInteger(marker.pid) || !Number.isInteger(marker.port) || typeof marker.token !== 'string' || !/^[\w-]{16,100}$/.test(marker.token) || marker.projectId !== config.project.id || marker.configPath !== config.configPath) throw new Error('Server marker does not match this instance configuration. No process was stopped; inspect its data directory and original configuration.');
  return marker;
}
function sanitizedEnv(configPath) {
  const env = { ...process.env };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL']) delete env[key];
  if (configPath) env.AI_MANAGER_CONFIG = configPath;
  else delete env.AI_MANAGER_CONFIG;
  return env;
}
async function doctor(config) {
  console.log(`Node: ${config.runtime.nodeVersion}\nGit: ${config.runtime.gitVersion}\nCodex: ${config.runtime.codexVersion}\nExecutable: ${config.executable}\nConfiguration: ${config.configPath || 'built-in disposable fixture (no local configuration)'}\nProject: ${config.project.name} (${config.project.id})\nState: ${config.projectStateDir}${config.legacyState ? ' (existing fixture state preserved)' : ''}\nURL: http://127.0.0.1:${config.port}`);
  let subscription = false;
  try {
    const status = await run(config.executable, ['login', 'status'], { env: sanitizedEnv(config.configPath), timeout: 10000, maxBuffer: 65536 });
    subscription = /logged in using chatgpt/i.test(`${status.stdout}\n${status.stderr}`);
  } catch {}
  console.log(`ChatGPT sign-in: ${subscription ? 'available (CLI login status; server preparation still required)' : 'not confirmed; run Codex login and choose ChatGPT, not an API key'}`);
  console.log(`Dispatch configuration: ${config.project.readiness.ready ? 'ready' : 'incomplete'}`);
  for (const issue of config.project.readiness.issues) console.log(`  - ${issue}`);
  console.log('Realtime voice and MCP availability depend on your installed Codex version/account/configuration. Confirm them in the browser before real work. This check starts no voice or worker.');
  if (!subscription) process.exitCode = 1;
}
async function start(config, background) {
  const marker = await readMarker(config);
  if (marker) throw new Error(`An existing server marker is present for PID ${marker.pid}. Use stop with the same configuration or inspect the marker; no duplicate server was launched.`);
  const env = sanitizedEnv(config.configPath);
  if (!background) {
    const child = spawn(process.execPath, [join(appRoot, 'server.mjs')], { cwd: appRoot, env, stdio: 'inherit' });
    let forwarded = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (!forwarded) { forwarded = true; child.kill(signal); } });
    child.on('error', error => { console.error(safe(error.message)); process.exitCode = 1; });
    child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
    return;
  }
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const logPath = join(config.dataDir, 'server.log');
  const log = await open(logPath, 'a', 0o600);
  let child;
  try { child = spawn(process.execPath, [join(appRoot, 'server.mjs')], { cwd: appRoot, env, stdio: ['ignore', log.fd, log.fd], detached: true }); }
  finally { await log.close(); }
  let spawnError;
  child.on('error', error => { spawnError = error; });
  child.unref();
  for (let attempt = 0; attempt < 150; attempt++) {
    if (spawnError || child.exitCode !== null) throw new Error(`Server did not start. Inspect ${logPath}${spawnError ? ` (${safe(spawnError.message)})` : ''}.`);
    const next = await readMarker(config);
    if (next?.pid === child.pid) { console.log(`Started local server PID ${child.pid}: http://127.0.0.1:${next.port}\nLog: ${logPath}\nMicrophone remains off until you connect. Stop with the same --config.`); return; }
    await sleep(100);
  }
  throw new Error(`Server startup was not confirmed within 15 seconds. It may still be starting; inspect ${logPath} before trying again. No process was killed.`);
}
async function stop(config) {
  const marker = await readMarker(config);
  if (!marker) { console.log('No server marker for this instance. No process was stopped.'); return; }
  const origin = `http://127.0.0.1:${marker.port}`;
  let response;
  try { response = await fetch(`${origin}/api/shutdown`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: marker.token }), signal: AbortSignal.timeout(10000) }); }
  catch { throw new Error('This instance did not answer its authenticated shutdown request. No PID was killed. Check whether it is still running before removing a stale server marker.'); }
  if (response.status !== 202) throw new Error(`This instance rejected shutdown (${response.status}). No PID was killed.`);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!await exists(config.serverStatePath)) { console.log('Local server stopped. Independently launched workers were not canceled.'); return; }
    const current = await readMarker(config);
    if (current.token !== marker.token) throw new Error('Server marker changed during shutdown; another server may have started. No further action taken.');
    await sleep(100);
  }
  throw new Error('Shutdown was accepted but marker removal is not yet confirmed. Inspect server.log before restarting.');
}
async function status(config) {
  const marker = await readMarker(config);
  if (!marker) { console.log('This instance has no running-server marker.'); return; }
  const origin = `http://127.0.0.1:${marker.port}`;
  try {
    const response = await fetch(`${origin}/api/state`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Status request failed.');
    const state = await response.json();
    console.log(`Local server responds: ${origin}\nProject: ${config.project.name}\nManager: ${state.status || 'idle'}\nVoice: ${state.voiceActive ? 'connected' : 'disconnected'}\nThis command did not prepare a chat, activate a microphone or launch work.`);
  } catch { throw new Error('A server marker exists but its local server did not answer. No process was stopped. Inspect server.log before restarting.'); }
}
async function packageSource(options) {
  const version=JSON.parse(await readFile(join(appRoot,'package.json'),'utf8')).version;
  const output = resolve(options['--output'] || join(appRoot, 'dist', `crew-${version}-source.tar.gz`));
  if (!output.endsWith('.tar.gz')) throw new Error('--output must end in .tar.gz.');
  if (await exists(output)) throw new Error(`Refusing to overwrite ${output}. Choose a new --output or remove the old archive explicitly.`);
  const allowed = ['worker-model-selection.mjs','tests/worker-model-selection.test.mjs','tests/worker-model-transition.test.mjs','tickets/GH-022.md','conversation-timeline.mjs','tests/conversation-timeline.test.mjs','tickets/GH-015.md','managed-toolchain.mjs','project-toolchain.mjs','tests/managed-toolchain.test.mjs','tests/project-toolchain.test.mjs','tickets/GH-1.md','tests/worktree-paths.test.mjs','worktree-paths.mjs','tests/diagnostics.test.mjs','desktop/execution-selection.mjs','diagnostics.mjs','project-execution-plan.mjs','project-environment.mjs','project-runtime-runner.mjs','desktop/environment-options.mjs','tests/environment-options.test.mjs','tests/project-execution-plan.test.mjs','tests/project-environment.test.mjs','docs/PROJECT-ENVIRONMENTS.md','tickets/AI-012.md','environment-command.mjs','process-ownership.mjs','environment-runner.mjs','tests/process-ownership.test.mjs','docs/WORKERS.md','worker-environment.mjs','desktop/project-options.mjs','desktop/project-setup.mjs','tests/project-options.test.mjs','tests/project-setup.test.mjs','tests/worker-lifecycle.test.mjs','tests/concurrent-controller.test.mjs','tickets/AI-010.md','tickets/AI-011.md','.gitignore', 'package.json', 'cli.mjs', 'config.mjs', 'project-discovery.mjs', 'server.mjs', 'codex-bridge.mjs', 'controller.mjs', 'worker-runner.mjs', 'orchestration-mcp.mjs', 'orchestration-store.mjs', 'README.md', 'AGENTS.md', 'config/fixture.example.json', 'config/set1.example.json', 'prompts/manager.md', 'prompts/worker.md', 'docs/ARCHITECTURE.md', 'docs/CONFIGURATION.md', 'docs/MACOS.md', 'docs/VALIDATION-HISTORY.md', 'tickets/AI-006.md', 'tests/config.test.mjs', 'tests/worker-project.test.mjs', 'package-lock.json', 'electron-builder.yml', 'desktop/main.mjs', 'desktop/storage.mjs', 'build/crew-mark.png', 'desktop/lifecycle.mjs', 'desktop/setup-service.mjs', 'desktop/setup-preload.cjs', 'scripts/desktop-build.mjs', 'build/icon.icns', 'build/icon.png', 'build/entitlements.mac.plist', 'docs/ONBOARDING.md', 'docs/STORAGE.md', 'tickets/AI-009.md', 'tickets/AI-007.md', 'tickets/AI-008.md', 'tests/desktop.test.mjs', 'tests/setup.test.mjs', 'tests/storage.test.mjs', 'tests/project-discovery.test.mjs'];
  allowed.push('tests/update-readiness.test.mjs','update-evidence.mjs','tests/update-evidence.test.mjs','tests/bridge-turn-state.test.mjs','tickets/AI-017.md','tests/voice-session.test.mjs','tickets/AI-016.md','tests/updater-feed.test.mjs','.github/workflows/macos-release.yml','scripts/release-policy.mjs','scripts/verify-release.mjs','tests/release-policy.test.mjs','desktop/updater.mjs','tests/updater.test.mjs','update-activity.mjs','update-admission.mjs','update-bridge.mjs','tests/update-activity.test.mjs','tests/update-admission.test.mjs','tests/update-bridge.test.mjs','renderer/src/manager/UpdateControls.jsx','tickets/AI-015.md','docs/RELEASES.md','docs/UPDATES.md','docs/ASTRA-HANDOFF.md', 'renderer-assets.mjs', 'tests/renderer-assets.test.mjs', 'tests/renderer-theme.test.mjs', 'tests/fixtures/shadcn-neutral-theme.css', 'vite.config.js', 'jsconfig.json', 'components.json', 'docs/UI-FOUNDATION.md', 'tickets/AI-013.md', 'renderer/index.html', 'renderer/setup.html', 'renderer/src/components/ui/alert.jsx', 'renderer/src/components/ui/badge.jsx', 'renderer/src/components/ui/button.jsx', 'renderer/src/components/ui/card.jsx', 'renderer/src/components/ui/input.jsx', 'renderer/src/components/ui/label.jsx', 'renderer/src/components/ui/native-select.jsx', 'renderer/src/components/ui/separator.jsx', 'renderer/src/components/ui/textarea.jsx', 'renderer/src/lib/utils.js', 'renderer/src/manager/App.jsx', 'renderer/src/manager/ApprovalForm.jsx', 'renderer/src/manager/README.md', 'renderer/src/manager/Message.jsx', 'renderer/src/manager/VoiceControls.jsx', 'renderer/src/manager/WorkChat.jsx', 'renderer/src/manager/WorkerAttention.jsx', 'renderer/src/manager/api.js', 'renderer/src/manager/main.jsx', 'renderer/src/manager/state.js', 'renderer/src/manager/state.test.mjs', 'renderer/src/manager/useCrewManager.js', 'renderer/src/manager/useVoiceSession.js', 'renderer/src/setup/App.jsx', 'renderer/src/setup/ProjectSettings.jsx', 'renderer/src/setup/components.jsx', 'renderer/src/setup/main.jsx', 'renderer/src/setup/model.js', 'renderer/src/setup/model.test.mjs', 'renderer/src/setup/useSetup.js', 'renderer/src/styles/theme.css');
  allowed.push('tickets/GH-003.md', 'prompt-settings.mjs', 'manager-lifecycle.mjs', 'renderer/src/manager/Settings.jsx', 'docs/SETTINGS.md', 'tests/prompt-settings.test.mjs', 'tests/manager-lifecycle.test.mjs', 'tests/settings-server.test.mjs', 'tests/fixtures/prompts-before-settings.json');
  allowed.push('tickets/GH-024.md');
  allowed.push('update-plan.mjs','cooperative-process.mjs','tests/update-plan.test.mjs','tests/update-plan-integration.test.mjs','tests/cooperative-update.test.mjs','tickets/AI-018.md');
  allowed.push('tests/fixtures/browser-media.js','global-capacity.mjs','desktop/project-host.mjs','desktop/workspace-registry.mjs','desktop/workspace-isolation.mjs','desktop/workspace-update.mjs','desktop/workspace-preload.cjs','renderer/src/manager/ProjectSwitcher.jsx','renderer/src/manager/draft-storage.js','renderer/src/manager/draft-storage.test.mjs','tests/workspace-registry.test.mjs','tests/workspace-isolation.test.mjs','tests/workspace-preload.test.mjs','tests/workspace-update.test.mjs','tests/global-capacity.test.mjs','scripts/workspace-native-acceptance.mjs','docs/multi-project-workspaces.md');
  allowed.push('desktop/workspace-pause-update.mjs','tests/workspace-pause-update.test.mjs','tests/toolchain-update-integration.test.mjs','tests/global-admission-http.test.mjs','tickets/REL-0.10.0.md','tests/workspace-pause-integration.test.mjs');
  allowed.push('worker-approvals.mjs', 'tickets/GH-13.md','tests/worker-app-server.test.mjs','tests/worker-approvals.test.mjs','tests/worker-app-server.test.mjs','tests/worker-bootstrap.test.mjs','tests/helpers/worker-app-server-fixture.mjs');
  allowed.push('tests/browser-fixture.mjs', 'tests/fixtures/browser-setup.js', 'tests/fixtures/BROWSER-ACCEPTANCE.md', 'docs/SOUNDS.md', 'docs/MANAGER-WORKSPACE.md', 'renderer/src/manager/attention-sounds.js', 'renderer/src/manager/sounds.js', 'renderer/src/manager/sounds.test.mjs', 'renderer/src/manager/conversation.js', 'renderer/src/manager/conversation.test.mjs', 'renderer/src/manager/worker-model.js', 'renderer/src/manager/worker-model.test.mjs', 'renderer/src/manager/voice-input.js', 'renderer/src/manager/voice-input.test.mjs', 'renderer/src/manager/voice-silence.js', 'renderer/src/manager/voice-silence.test.mjs', 'conversation.mjs', 'attention-keys.mjs', 'manager-attention.mjs', 'desktop/native-attention.mjs', 'desktop/sounds/attention.wav', 'tests/native-attention.test.mjs', 'tests/manager-attention.test.mjs');

  allowed.push('conversation.mjs','worker-detail.mjs','tests/worker-detail.test.mjs','tickets/GH-014.md','docs/MANAGER-WORKSPACE.md','renderer/src/manager/ManagerCallBar.jsx','renderer/src/manager/WorkerDetail.jsx','scripts/worker-overview-browser-acceptance.mjs','tests/browser-fixture.mjs','tests/fixtures/BROWSER-ACCEPTANCE.md','tests/fixtures/browser-setup.js','renderer/src/manager/conversation.js','renderer/src/manager/conversation.test.mjs','renderer/src/manager/voice-input.js','renderer/src/manager/voice-input.test.mjs','renderer/src/manager/voice-silence.js','renderer/src/manager/voice-silence.test.mjs','renderer/src/manager/worker-model.js','renderer/src/manager/worker-model.test.mjs');
  allowed.push('tickets/REL-0.11.0.md', 'tickets/REL-0.12.0.md', 'tests/grouped-012.test.mjs');
  allowed.push('tickets/GH-20.md');
  const sources = [...new Set(allowed)];
  for (const path of sources) if (!(await stat(join(appRoot, path))).isFile()) throw new Error(`Missing package source file: ${path}.`);
  await mkdir(dirname(output), { recursive: true });
  try { await run('tar', ['-czf', output, '-C', appRoot, ...sources], { timeout: 30000, maxBuffer: 65536 }); }
  catch { await unlink(output).catch(() => {}); throw new Error('Could not create source archive with tar. No partial archive was retained.'); }
  console.log(`Created ${output}\nAllowlisted source and templates only. No local configuration, state, chat history, Git repositories or credentials are included.\nOn the destination Mac: extract, install Node.js 22+ and Git, run npm ci and npm run renderer:build, sign into Codex with ChatGPT, then run node cli.mjs init --template set1.`);
}
try {
  const options = parse(process.argv.slice(2));
  if(['init','start'].includes(options.command) && !options['--config'] && !process.env.AI_MANAGER_CONFIG){const storage=await prepareCrewStorage({appData:join(homedir(),'Library','Application Support')});if(storage.issue)throw new Error(storage.issue+' Open Crew setup for recovery, or pass the original --config explicitly.');options['--config']=storage.configPath;}
  if (options.command === 'help') console.log(usage);
  else if (options.command === 'init') await initialize(options);
  else if (options.command === 'package') await packageSource(options);
  else {
    const requestedConfig = options['--config'] || process.env.AI_MANAGER_CONFIG || defaultInstanceConfig;
    const config = await loadAppConfig({ configPath: requestedConfig ? resolve(requestedConfig) : undefined });
    if (options.command === 'doctor') await doctor(config);
    else if (options.command === 'validate') {
      console.log(`Configuration valid: ${config.configPath || config.sourceConfigPath}\nProject: ${config.project.name}\nDispatch configuration: ${config.project.readiness.ready ? 'ready' : 'incomplete'}`);
      for (const issue of config.project.readiness.issues) console.log(`  - ${issue}`);
      if (!config.project.readiness.ready) process.exitCode = 1;
    }
    else if (options.command === 'start') await start(config, options['--background']);
    else if (options.command === 'status') await status(config);
    else await stop(config);
  }
} catch (error) { console.error(safe(error.message)); process.exitCode = 1; }
