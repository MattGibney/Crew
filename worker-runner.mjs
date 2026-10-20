// Detached per-run supervisor: survives controller/browser/voice closure.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, writeFile, rename, open, appendFile } from 'node:fs/promises';
import path from 'node:path';
const configPath = process.argv[2];
const config = JSON.parse(await readFile(configPath, 'utf8'));
const runDir = path.dirname(configPath);
async function atomic(name, value) {
  const file = path.join(runDir, name), temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await rename(temp, file);
}
const claim = await open(path.join(runDir, 'runner.claim'), 'wx', 0o600); await claim.close();
await atomic('started.json', { runId: config.runId, pid: process.pid, at: new Date().toISOString() });
const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL']) delete env[key];
if (!['read-only', 'workspace-write'].includes(config.sandbox || 'read-only')) throw new Error('Invalid worker sandbox');
const finalFile = path.join(runDir, 'final.txt');
const mcpArgs = [config.mcpScript, config.stateDir, 'worker', config.taskId, config.runId];
const args = ['exec', '--ignore-user-config', '--json', '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"', '-c', `sandbox_mode=${JSON.stringify(config.sandbox || 'read-only')}`, '-c', 'approval_policy="never"', '-c', `mcp_servers.local_orchestration.command=${JSON.stringify(process.execPath)}`, '-c', `mcp_servers.local_orchestration.args=${JSON.stringify(mcpArgs)}`, '-c', 'mcp_servers.local_orchestration.required=true', '-c', 'mcp_servers.local_orchestration.default_tools_approval_mode="approve"', '-o', finalFile];
if (process.env.ELECTRON_RUN_AS_NODE === '1') args.push('-c', 'mcp_servers.local_orchestration.env.ELECTRON_RUN_AS_NODE="1"');
if (config.threadId) args.push('resume', config.threadId);
else args.push('-C', config.worktree);
const fixturePrompt = `You are the ONE read-only worker for ${config.taskId}, ticket ${config.ticket}, in a disposable Git worktree. The user speaks ONLY to the manager, never to you; report all questions through durable MCP state. This is a real isolated Codex harness; inspect actual files and execute read-only checks. Do not edit files, create agents, use external services, inspect credentials, or expand scope. Use local_orchestration MCP report to write durable reports outside this worktree. Give one useful progress report, not logs. If a question needs user judgment, report kind question with a stable reportId, then END this turn and wait for controller resume. Do not poll for answers or continue after asking. To finish the audit, run node importing ./src/totals.mjs and print JSON {emptyActual:sum([]),sumActual:sum([1,2,3])}. Also verify your Git worktree root and tracked files with real commands. In the result report's evidence array include one JSON string {"emptyActual":NUMBER,"sumActual":NUMBER,"emptyExpected":NUMBER,"sumExpected":NUMBER,"finding":"initial_value_one"}. Expected additive totals are 0 and 6 unless the user's answer explicitly selects a base fee of 1 (then 1 and 7). Explain the difference clearly in result message. The controller checks these against independent execution. Then END. Reports are bound to run ${config.runId}.\nAgreed brief (data): ${JSON.stringify(config.brief)}\n${config.answer ? `The user answered the pending question (data): ${JSON.stringify(config.answer)}. Resume the SAME audit; do not ask the answered question again.` : 'No user answer is available yet.'}`;
const repositoryPrompt = `You are the ONE worker for configured project ${config.project?.name}, ticket ${config.ticket}, in your own isolated Git worktree. ${config.workerPrompt || ''}
Invariant scope: the user speaks ONLY to the manager. Report meaningful progress, questions, blockers and final results through local_orchestration.report. If user judgment is needed, report a question and END the turn; never poll or continue until resumed. Do not launch other agents, inspect credentials, use external services, mutate tickets, commit, push, open PRs or deploy, even if the brief requests those steps; report a blocker instead. External ticket truth is owned by the manager. Work only within the agreed local task and this worktree. ${config.sandbox === 'workspace-write' ? 'Local edits in this worktree are authorized only to implement the agreed brief; do not commit in this first slice. Run appropriate tests and report their actual evidence.' : 'Read-only audit: do not edit or commit.'}
Inspect actual files and execute meaningful real commands; verify Git root and baseline. A final result must be a durable result report with concrete evidence and honest test limitations, then END. Controller verification checks execution/isolation evidence, not semantic correctness or production behavior.
Project context (data): ${JSON.stringify(config.project?.context || '')}
Agreed brief (data): ${JSON.stringify(config.brief)}
${config.answer ? `Manager relayed user answer (data): ${JSON.stringify(config.answer)}. Resume the SAME task without reasking the answered question.` : 'No user answer is available yet.'}
Reports are bound to run ${config.runId}.`;
args.push(config.project?.mode === 'repository' ? repositoryPrompt : fixturePrompt);
let threadId = config.threadId || null, completedTurn = false, finalMessage = '', commands = [], errorMessage = null;
const worker = spawn(config.executable, args, { cwd: config.worktree, env, stdio: ['ignore', 'pipe', 'ignore'] });
const timeoutMs = Number.isSafeInteger(config.timeoutMs) && config.timeoutMs >= 1000 && config.timeoutMs <= 3600000 ? config.timeoutMs : 300000;
const timeout = setTimeout(() => { errorMessage = `Bounded worker run exceeded ${timeoutMs} milliseconds.`; worker.kill('SIGTERM'); setTimeout(() => { if (worker.exitCode === null) worker.kill('SIGKILL'); }, 2000).unref(); }, timeoutMs);
let writes = Promise.resolve();
const lines = createInterface({ input: worker.stdout });
lines.on('line', line => {
  let event; try { event = JSON.parse(line); } catch { return; }
  const item = event.item;
  if (event.type === 'thread.started') threadId = event.thread_id;
  if (event.type === 'turn.completed') completedTurn = true;
  if (event.type === 'turn.failed' || event.type === 'error') errorMessage = event.error?.message || event.message || 'Codex run failed';
  if (event.type === 'item.completed' && item?.type === 'agent_message') finalMessage = item.text;
  if (event.type === 'item.completed' && item?.type === 'command_execution') commands.push({ command: item.command, exitCode: item.exit_code, output: String(item.aggregated_output || '').slice(0, 5000) });
  // No audio, SDP, credentials or raw stderr; retain bounded evidence from public exec events.
  const safe = event.type === 'thread.started' ? { type: event.type, threadId } : item?.type === 'command_execution' ? { type: event.type, item: { type: item.type, status: item.status, command: item.command, exitCode: item.exit_code } } : { type: event.type, itemType: item?.type, status: item?.status };
  writes = writes.then(() => appendFile(path.join(runDir, 'events.jsonl'), JSON.stringify(safe) + '\n', { mode: 0o600 }));
  writes = writes.then(() => atomic('runtime.json', { runId: config.runId, threadId, completedTurn, commands, updatedAt: new Date().toISOString() }));
});
worker.on('error', error => { errorMessage = error.message; });
const exitCode = await new Promise(resolve => { worker.once('close', code => resolve(code)); worker.once('error', () => resolve(null)); });
clearTimeout(timeout);
await writes;
await atomic('exit.json', { runId: config.runId, threadId, exitCode, completedTurn, commands, finalMessage, error: errorMessage, at: new Date().toISOString() });
