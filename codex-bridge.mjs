// AI-002: native Codex protocol adapter. No separate model/tool loop.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { conversationMessage } from './conversation.mjs';
import { buildManagerInstructions } from './prompt-settings.mjs';
export const safeError = error => String(error?.message || error).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/sk-[\w-]+/g, '[redacted]').slice(0, 1500);
export function createBridge({ cwd, statePath, executable, orchestrationDir, project, managerPrompt, runtimeProjectPath, onEvent = () => {} }) {
  let child, ready, shuttingDown, threadId, threadReady, threadPromise, nextId = 0;
  let voiceActive = false, connecting = false, negotiation, activeTurnId = null, status = 'idle', voiceGeneration = 0, workStarting = false;
  let connectors = [], connectorError = null, voiceCatalog, greetingSession, lastVoice = null;
  const pending = new Map(), approvals = new Map(), items = new Map(), messages = new Map(), workRequests = new Map();
  const expectedExits = new WeakSet();
  const completedTurns = new Set();
  function markCompleted(id){completedTurns.add(id);if(completedTurns.size>100)completedTurns.delete(completedTurns.values().next().value);}
  const state = () => ({ threadId, managerConnected: Boolean(threadReady && child && child.exitCode === null && child.signalCode === null), activeTurnId, status, voiceActive, voiceConnecting:connecting, workStarting, lastVoice, connectors, connectorError, approvals: [...approvals.values()].map(r => ({ ...r, id: String(r.id) })), items: [...items.values()].slice(-40), messages: [...messages.values()].slice(-20) });
  const emit = (type, data = {}) => onEvent({ type, ...data });
  const changed = () => emit('work-state', { state: state() });
  const send = message => child?.stdin.write(`${JSON.stringify(message)}\n`);
  function rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return reject(new Error('Codex is not running.'));
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out.`)); }, 90000);
      pending.set(id, { resolve, reject, timer }); send({ id, method, params });
    });
  }
  function record(item, turnId) {
    const message = conversationMessage(item, turnId);
    if (message) messages.set(item.id, message);
    if (item.type === 'commandExecution') items.set(item.id, { id: item.id, turnId, type: item.type, name: item.command, status: item.status, exitCode: item.exitCode, output: safeError(item.aggregatedOutput || '').slice(0, 2500) });
    if (item.type === 'mcpToolCall') items.set(item.id, { id: item.id, turnId, type: item.type, name: `${item.server}/${item.tool}`, status: item.status, resultPresent: item.result != null, error: item.error ? safeError(item.error.message || 'MCP call failed') : null });
    if (item.type === 'fileChange') items.set(item.id, { id: item.id, turnId, type: item.type, name: 'File changes', status: item.status, changes: item.changes });
    if (items.size > 80) items.delete(items.keys().next().value);
    if (messages.size > 40) messages.delete(messages.keys().next().value);
  }
  function handle(message) {
    if (message.id !== undefined && pending.has(message.id)) {
      const entry = pending.get(message.id); pending.delete(message.id); clearTimeout(entry.timer);
      message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result); return;
    }
    const { method, params = {} } = message;
    if (message.id !== undefined && method) {
      if (method === 'currentTime/read') return send({ id: message.id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } });
      if (params.threadId === threadId && ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request', 'item/permissions/requestApproval'].includes(method)) {
        approvals.set(String(message.id), { id: message.id, method, params }); changed(); return;
      }
      send({ id: message.id, error: { code: -32601, message: `This minimal client does not support ${method}. No action was approved.` } });
      emit('notice', { message: `Codex requested ${method}, which this client cannot handle.` }); return;
    }
    if (params.threadId !== threadId) return;
    // Passive observers only: NEVER start turns or append speech from these events.
    // Native realtime handoffs own routing, steering and result return.
    if (method === 'thread/realtime/sdp') negotiation?.resolve(params.sdp);
    else if (method === 'thread/realtime/started') { voiceActive = true; if (lastVoice) lastVoice.startedAt = new Date().toISOString(); emit('backend-started'); }
    else if (method === 'thread/realtime/error') { if (lastVoice) lastVoice.error = safeError(params.message); const error = new Error(params.message); negotiation?.reject(error); emit('error', { message: safeError(error) }); }
    else if (method === 'thread/realtime/closed') { if (lastVoice) { lastVoice.closedAt = new Date().toISOString(); lastVoice.closeReason = safeError(params.reason || 'Voice ended.'); } voiceActive = false; negotiation?.reject(new Error(params.reason || 'Voice closed.')); emit('closed', { reason: params.reason || 'Voice ended.' }); changed(); }
    else if (method === 'thread/realtime/transcript/delta') { if (lastVoice) { const key = params.role === 'user' ? 'inputTranscriptEvents' : 'outputTranscriptEvents'; lastVoice[key]++; } emit('transcript-delta', { role: params.role, text: params.delta }); }
    else if (method === 'thread/realtime/transcript/done') emit('transcript-done', { role: params.role, text: params.text });
    else if (method === 'turn/started') { if(completedTurns.has(params.turn.id))return;activeTurnId = params.turn.id; status = 'working'; changed(); }
    else if (method === 'turn/completed') {
      for (const item of params.turn.items || []) record(item, params.turn.id);
      markCompleted(params.turn.id);
      if (!activeTurnId || activeTurnId === params.turn.id) { activeTurnId = null; status = params.turn.status; }
      if (params.turn.error) emit('notice', { message: safeError(params.turn.error.message) });
      changed();
    } else if (method === 'item/started' || method === 'item/completed') { record(params.item, params.turnId); changed(); }
    else if (method === 'serverRequest/resolved') { approvals.delete(String(params.requestId)); changed(); }
    else if (method === 'error') emit('notice', { message: safeError(params.error?.message || 'Backend work error.') });
  }
  async function prepare() {
    if (shuttingDown) await shuttingDown;
    if (ready) return ready;
    ready = (async () => {
      const env = { ...process.env };
      for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL']) delete env[key];
      const args = ['app-server', '--stdio', '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"'];
      if (orchestrationDir) args.push('-c', `mcp_servers.local_orchestration.command=${JSON.stringify(process.execPath)}`, '-c', `mcp_servers.local_orchestration.args=${JSON.stringify([`${cwd}/orchestration-mcp.mjs`, orchestrationDir, 'manager', ...(runtimeProjectPath ? [runtimeProjectPath] : [])])}`, '-c', 'mcp_servers.local_orchestration.required=true', '-c', 'mcp_servers.local_orchestration.default_tools_approval_mode="approve"');
      if (orchestrationDir && process.env.ELECTRON_RUN_AS_NODE === '1') args.push('-c', 'mcp_servers.local_orchestration.env.ELECTRON_RUN_AS_NODE="1"');
      child = spawn(executable, args, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] });
      const proc = child;
      const fail = error => {
        if (proc !== child) return;
        for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
        pending.clear(); approvals.clear(); negotiation?.reject(error);
        ready = undefined; voiceCatalog = undefined; greetingSession = undefined; threadReady = false; voiceActive = false; activeTurnId = null;
        if (!expectedExits.has(proc)) { status = 'connection lost'; emit('error', { message: safeError(error) }); changed(); }
      };
      proc.on('error', fail); proc.on('exit', () => fail(new Error('Codex process stopped. Reconnect to resume this chat.')));
      createInterface({ input: proc.stdout }).on('line', line => { if (proc !== child) return; try { handle(JSON.parse(line)); } catch (error) { emit('notice', { message: safeError(error) }); } });
      await rpc('initialize', { clientInfo: { name: 'crew_manager', version: '0.6.0' }, capabilities: { experimentalApi: true, requestAttestation: false, mcpServerOpenaiFormElicitation: true } });
      send({ method: 'initialized', params: {} });
      const { account } = await rpc('account/read', { refreshToken: false });
      if (account?.type !== 'chatgpt') throw new Error('ChatGPT sign-in required. API-key authentication is not allowed.');
      return { auth: account.type, plan: account.planType };
    })();
    try { return await ready; } catch (error) { await shutdown(); throw error; }
  }
  async function ensureThread() {
    await prepare();
    if (threadPromise) return threadPromise;
    if (threadReady) return threadId;
    threadPromise = (async () => {
      if (!threadId) {
        try {
          ({ threadId } = JSON.parse(await readFile(statePath, 'utf8')));
          if (typeof threadId !== 'string' || !/^[\w-]+$/.test(threadId)) throw new Error('Invalid saved chat ID.');
        }
        catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read the saved chat reference. It has not been replaced.'); }
      }
      const managerInstructions = buildManagerInstructions({ managerPrompt: managerPrompt ?? await readFile(new URL('./prompts/manager.md', import.meta.url), 'utf8'), project });
      const options = { cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only', developerInstructions: managerInstructions };
      let result;
      if (threadId) {
        try { result = await rpc('thread/resume', { threadId, excludeTurns: true, ...options }); }
        catch (error) {
          if (!/already has an active writer/.test(error.message)) throw error;
          const previousThreadId = threadId;
          const source = await rpc('thread/read', { threadId, includeTurns: false });
          const recent = await rpc('thread/turns/list', { threadId, limit: 1, itemsView: 'notLoaded', sortDirection: 'desc' });
          if (source.thread.status?.type === 'active' || recent.data.some(turn => turn.status === 'inProgress')) throw new Error('ChatGPT is signed in, but the saved manager chat is active in another Codex client. Finish that work before reconnecting.');
          // Native history-preserving fork avoids terminating the owning desktop runtime.
          // It starts no turn; controller task files remain the same source of execution state.
          result = await rpc('thread/fork', { threadId, ...options, excludeTurns: true, ephemeral: false, deferGoalContinuation: true });
          const reference = { threadId: result.thread.id, previousThreadId, recoveredAt: new Date().toISOString(), reason: 'saved_chat_writer_conflict' };
          await writeFile(`${statePath}.tmp`, JSON.stringify(reference) + '\n', { mode: 0o600 });
          await rename(`${statePath}.tmp`, statePath);
          threadId = result.thread.id;
          await rpc('thread/name/set', { threadId, name: 'Crew work chat' });
          emit('notice', { message: 'The saved manager chat was held by another Codex client. Continued from its preserved history; the original chat and worker state are retained.' });
        }
      }
      else {
        result = await rpc('thread/start', { ...options, ephemeral: false }); threadId = result.thread.id;
        await writeFile(`${statePath}.tmp`, JSON.stringify({ threadId }) + '\n', { mode: 0o600 }); await rename(`${statePath}.tmp`, statePath);
        await rpc('thread/name/set', { threadId, name: 'Crew work chat' });
      }
      threadId = result.thread.id;
      const history = await rpc('thread/turns/list', { threadId, limit: 10, itemsView: 'full', sortDirection: 'desc' });
      for (const turn of [...history.data].reverse()) {
        for (const item of turn.items || []) record(item, turn.id);
        if (turn.status === 'inProgress') { activeTurnId = turn.id; status = 'working'; }
      }
      threadReady = true;
      changed();
      void rpc('mcpServerStatus/list', { threadId, limit: 100, detail: 'toolsAndAuthOnly' }).then(result => {
        connectors = result.data.map(s => ({ name: s.name, status: s.runtimeStatus, auth: s.authStatus, tools: Object.keys(s.tools || {}).length })); connectorError = null; changed();
      }).catch(error => { connectorError = safeError(error); changed(); });
      return threadId;
    })();
    try { return await threadPromise; } finally { threadPromise = undefined; }
  }
  async function listVoices() {
    await prepare();
    if (voiceCatalog) return voiceCatalog;
    const { voices } = await rpc('thread/realtime/listVoices');
    if (!Array.isArray(voices?.v3) || !voices.v3.length || !voices.v3.every(id => typeof id === 'string' && /^[a-z][a-z0-9_-]{0,60}$/.test(id)) || !voices.v3.includes(voices.defaultV1)) throw new Error('Codex did not return a usable v3 voice catalog. Try loading voices again.');
    voiceCatalog = { voices: [...new Set(voices.v3)].map(id => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1) })), defaultVoice: voices.defaultV1 };
    return voiceCatalog;
  }
  async function startVoice(sdp, selectedVoice) {
    if (connecting || voiceActive) throw new Error('A voice session is already active or connecting.');
    connecting = true;
    const attempt = ++voiceGeneration;
    let startRequested = false;
    try {
      await ensureThread();
      const catalog = await listVoices();
      const voice = selectedVoice === undefined || selectedVoice === '' ? catalog.defaultVoice : selectedVoice;
      if (typeof voice !== 'string' || !catalog.voices.some(item => item.id === voice)) throw new Error('Choose a supported Codex voice before connecting.');
      if (attempt !== voiceGeneration) throw new Error('Voice connection cancelled.');
      lastVoice = { voice, requestedAt: new Date().toISOString(), inputTranscriptEvents: 0, outputTranscriptEvents: 0, error: null, browser: null };
      const answer = new Promise((resolve, reject) => { negotiation = { resolve, reject }; }); answer.catch(() => {});
      const timer = setTimeout(() => negotiation?.reject(new Error('No WebRTC answer arrived within 40 seconds.')), 40000);
      try {
        startRequested = true;
        await rpc('thread/realtime/start', { threadId, transport: { type: 'webrtc', sdp }, outputModality: 'audio', version: 'v3', voice, initialItems: [{ role: 'developer', text: `${managerPrompt ?? await readFile(new URL('./prompts/manager.md', import.meta.url), 'utf8')}\n\nVoice runtime event (data): a new voice session is starting. Selected voice name: ${catalog.voices.find(item => item.id === voice).name}. This is connection context, not a user work request.` }], clientManagedHandoffs: false, includeStartupContext: true });
        const responseSdp = await answer;
        if (attempt !== voiceGeneration) throw new Error('Voice connection cancelled.');
        greetingSession = { token: randomUUID(), generation: attempt, sent: false };
        return { sdp: responseSdp, threadId, sessionToken: greetingSession.token };
      } finally { clearTimeout(timer); negotiation = undefined; }
    } catch (error) { if (attempt === voiceGeneration && startRequested) await stopVoice(); throw error; }
    finally { connecting = false; }
  }
  async function greetVoice(sessionToken) {
    const session = greetingSession;
    if (!session || session.token !== sessionToken || session.generation !== voiceGeneration || !voiceActive) throw new Error('This voice call is no longer active.');
    if (session.sent) return { requested: true };
    // Claim once: duplicate connection events cannot repeat startup acknowledgement.
    session.sent = true;
    if (lastVoice) lastVoice.voiceReadyAt = new Date().toISOString();
    // Startup behavior is in the active editable prompt. Connection acknowledgement
    // must not append a second hidden behavior instruction or synthetic user turn.
    return { requested: true };
  }
  function reportVoiceStatus(sessionToken, data = {}) {
    if (!greetingSession || greetingSession.token !== sessionToken || greetingSession.generation !== voiceGeneration || !voiceActive) return { recorded: false };
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { recorded: false };
    const snapshot = {};
    const allowed = ['connection', 'ice', 'channel', 'inputSource', 'localTrack', 'localEnabled', 'localMuted', 'remoteTrack', 'audioPaused', 'audioMuted', 'audioVolume', 'audioReady', 'playbackError', 'packetsSent', 'packetsReceived', 'bytesSent', 'bytesReceived', 'inputEnergy'];
    for (const key of allowed) {
      const value = data[key];
      if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) snapshot[key] = value;
      else if (typeof value === 'string') snapshot[key] = safeError(value).slice(0, 200);
    }
    if (lastVoice) lastVoice.browser = { ...snapshot, at: new Date().toISOString() };
    return { recorded: true };
  }
  async function stopVoice({ preserveWork = true, cooperative = false } = {}) {
    greetingSession = undefined;
    voiceGeneration++;
    if (child && threadId && (voiceActive || connecting)) {
      let timer;
      try { await Promise.race([rpc('thread/realtime/stop', { threadId }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Voice stop timed out.')), 3000); })]); }
      catch (error) { if (cooperative) throw new Error(`Voice shutdown could not be confirmed: ${safeError(error)}`); if (preserveWork) throw error; await shutdown(); }
      finally { clearTimeout(timer); }
    }
    voiceActive = false; negotiation?.reject(new Error('Disconnected.')); changed();
  }
  async function shutdown({cooperative=false}={}) {
    if (shuttingDown) return shuttingDown;
    shuttingDown = (async () => {
      const proc = child;
      if (proc?.pid && proc.exitCode === null && proc.signalCode === null) {
        if (cooperative) {
          if (activeTurnId || workStarting || voiceActive || connecting || approvals.size) throw new Error('Manager activity changed before cooperative shutdown.');
          expectedExits.add(proc);
          await new Promise((resolve, reject) => {
            const done = () => { clearTimeout(timer); resolve(); };
            const timer = setTimeout(() => { proc.removeListener('exit', done); reject(new Error('Manager runtime shutdown is still pending. No force signal was sent.')); }, 3000);
            proc.once('exit', done); proc.stdin.end();
          });
        } else {
          expectedExits.add(proc); proc.kill('SIGTERM');
          await new Promise((resolve, reject) => { const force = setTimeout(() => proc.kill('SIGKILL'), 1500); const deadline = setTimeout(() => { clearTimeout(force); reject(new Error('Manager process exit could not be confirmed.')); }, 4500); proc.once('exit', () => { clearTimeout(force); clearTimeout(deadline); resolve(); }); });
        }
      }
      child = undefined; ready = undefined; threadReady = false; voiceActive = false;
    })();
    try { await shuttingDown; } finally { shuttingDown = undefined; }
  }
  async function stopManager({ timeoutMs = 12000 } = {}) {
    // Never terminate an app-server while native tools/approval execution is unverified.
    const deadline = Date.now() + timeoutMs;
    await stopVoice({ preserveWork: true });
    while (workStarting || threadPromise) {
      if (Date.now() >= deadline) throw new Error('Manager is still starting a request. Wait, then retry Stop manager. Workers are unchanged.');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (activeTurnId) await interrupt();
    while (activeTurnId || approvals.size) {
      if (Date.now() >= deadline) throw new Error('Manager interruption is not yet confirmed. Resolve pending input or wait, then retry Stop manager. Workers are unchanged.');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await shutdown();
    status = 'stopped'; changed();
  }
  function setManagerPrompt(text) {
    if (child || threadReady || threadPromise) throw new Error('Stop the manager before applying instructions.');
    managerPrompt = text;
  }
  async function startWork(text, requestId) {
    // Explicit diagnostic/user request only. NEVER called by transcript/handoff events.
    if (workRequests.has(requestId)) return workRequests.get(requestId);
    const result = (async () => {
      if (activeTurnId || workStarting) throw new Error('Codex is already working. Use voice to steer it or Stop work.');
      workStarting = true; changed();
      try {
        await ensureThread();
        // Resumed history can reveal an already active native turn. Never launch
        // a replacement merely because it was unknown before thread loading.
        if(activeTurnId)throw new Error('Codex is already working. Use voice to steer it or Stop work.');
        const result=await rpc('turn/start', { threadId, clientUserMessageId: requestId, input: [{ type: 'text', text }] });
        // The response may arrive before turn/started, or after turn/completed.
        // Close the former idle gap without resurrecting the latter finished turn.
        if(result?.turn?.status==='inProgress'&&!completedTurns.has(result.turn.id)&&!activeTurnId){activeTurnId=result.turn.id;status='working';changed();}
        return result;
      }
      finally { workStarting = false; changed(); }
    })();
    workRequests.set(requestId, result);
    result.catch(() => { if (workRequests.get(requestId) === result) workRequests.delete(requestId); });
    if (workRequests.size > 100) workRequests.delete(workRequests.keys().next().value);
    return result;
  }
  async function interrupt({expectedTurnId}={}) { if(expectedTurnId&&activeTurnId!==expectedTurnId)throw new Error('The active manager turn changed. Review the update plan before interrupting work.'); if (activeTurnId) await rpc('turn/interrupt', { threadId, turnId: activeTurnId }); }
  function answerApproval(id, response) {
    const request = approvals.get(String(id)); if (!request) throw new Error('This request has already been resolved.');
    const { method, params } = request; let result;
    if (method === 'item/tool/requestUserInput') {
      const answers = {};
      for (const question of params.questions) {
        const answer = response.answers?.[question.id];
        if (typeof answer !== 'string' || !answer.trim()) throw new Error('Answer each question before submitting.');
        if (question.options?.length && !question.isOther && !question.options.some(o => o.label === answer)) throw new Error('Choose one of the offered answers.');
        answers[question.id] = { answers: [answer] };
      }
      result = { answers };
    } else if (method === 'mcpServer/elicitation/request') {
      if (!['accept', 'decline', 'cancel'].includes(response.action)) throw new Error('Invalid MCP response.');
      const emptyToolApproval = params.mode === 'form' && params._meta?.codex_approval_kind === 'mcp_tool_call' && Object.keys(params.requestedSchema?.properties || {}).length === 0;
      if (response.action === 'accept' && params.mode !== 'url' && !emptyToolApproval) throw new Error('This MCP form needs a fuller client. Cancel it and use the normal Codex client.');
      result = { action: response.action, content: response.action === 'accept' && emptyToolApproval ? {} : null, _meta: null };
    } else if (method === 'item/permissions/requestApproval') {
      if (!['accept', 'decline'].includes(response.decision)) throw new Error('Invalid permission decision.');
      result = { permissions: response.decision === 'accept' ? params.permissions : {}, scope: 'turn' };
    } else {
      if (!['accept', 'decline', 'cancel'].includes(response.decision)) throw new Error('Invalid approval decision.');
      if (params.availableDecisions && !params.availableDecisions.includes(response.decision)) throw new Error('That decision is not available for this request.');
      result = { decision: response.decision };
    }
    send({ id: request.id, result }); approvals.delete(String(id)); changed();
  }
  return { stopManager, setManagerPrompt, prepare, ensureThread, listVoices, startVoice, greetVoice, reportVoiceStatus, stopVoice, shutdown, startWork, interrupt, answerApproval, state };
}
