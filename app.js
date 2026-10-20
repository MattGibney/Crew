const $ = id => document.getElementById(id);
const status = text => { $('status').textContent = text; };
let pc, stream, channel, busy = false, prepared = false, eventReady = false, active = false, timer, generation = 0, disconnecting = false;
let diagnosticsTimer, playbackError = null;
let voiceCatalog, voiceLoading = false, voiceNotice = '';
const voiceStorageKey = 'crew.voice.v3';
const parts = new Map();
async function api(path, body = {}) {
  const response = await fetch(`/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error || `Request failed (${response.status}).`); error.account = result.account; throw error; }
  return result;
}
function buttons() {
  $('connect').disabled = !prepared || !eventReady || !voiceCatalog || busy || !!pc;
  $('voice').disabled = !voiceCatalog || busy || !!pc;
  $('voice-hint').textContent = pc || busy ? 'Disconnect to change voice. Your choice applies when you connect again.' : voiceNotice || (voiceCatalog ? 'Saved on this browser for your next call. Connect to hear the selected voice.' : 'Voices are unavailable. Retry loading before connecting.');
  $('retry-voices').disabled = voiceLoading;
  $('disconnect').disabled = !pc && !busy;
  $('mute').disabled = !active || !stream;
}
async function loadVoices() {
  voiceLoading = true; voiceNotice = 'Loading available Codex voices. Microphone stays off.'; buttons();
  try {
    const catalog = await api('voices');
    let saved;
    try { saved = localStorage.getItem(voiceStorageKey) || localStorage.getItem('relay.voice.v3') || localStorage.getItem('ai-manager.voice.v3'); } catch { /* Storage may be blocked. */ }
    voiceCatalog = catalog;
    const selected = catalog.voices.some(voice => voice.id === saved) ? saved : catalog.defaultVoice;
    $('voice').replaceChildren(...catalog.voices.map(voice => {
      const option = document.createElement('option'); option.value = voice.id;
      option.textContent = `${voice.name}${voice.id === catalog.defaultVoice ? ' (Codex default)' : ''}`;
      return option;
    }));
    $('voice').value = selected;
    try { if(saved) localStorage.setItem(voiceStorageKey, selected); } catch {}
    voiceNotice = saved && saved !== selected ? 'Your saved voice is no longer available. Codex default selected for the next call.' : '';
    $('retry-voices').hidden = true;
  } catch (error) {
    voiceCatalog = undefined;
    voiceNotice = `Could not load Codex voices: ${error.message} Retry before connecting.`;
    $('voice').replaceChildren(new Option('Voices unavailable', ''));
    $('retry-voices').hidden = false;
  } finally { voiceLoading = false; buttons(); }
}
$('retry-voices').onclick = () => void loadVoices();
$('voice').onchange = () => {
  try { localStorage.setItem(voiceStorageKey, $('voice').value); voiceNotice = ''; }
  catch { voiceNotice = 'Selected for your next call. Browser storage is unavailable, so this choice will not survive a refresh.'; }
  buttons();
};
function showError(error) { $('error').hidden = false; $('error').textContent = error.message || String(error); }
function release() {
  clearTimeout(timer); timer = undefined; clearInterval(diagnosticsTimer); diagnosticsTimer = undefined; active = false;
  if (pc) { pc.onconnectionstatechange = null; pc.close(); pc = undefined; }
  stream?.getTracks().forEach(track => track.stop()); stream = undefined;
  channel = undefined; $('audio').srcObject = null; $('mute').textContent = 'Mute microphone';
}
async function disconnect(message = 'Disconnected. Microphone off.') {
  if (disconnecting) return;
  disconnecting = true; generation++;
  release(); busy = true; buttons();
  try { await api('disconnect'); } catch (error) { showError(error); }
  finally { busy = false; disconnecting = false; status(message); buttons(); }
}
function transcript(role, text, done) {
  let item = parts.get(role);
  if (!item) {
    if (!$('transcript').querySelector('[data-part]')) $('transcript').replaceChildren();
    const p = document.createElement('p'); p.dataset.part = 'true';
    const label = document.createElement('strong'); label.textContent = `${role === 'user' ? 'You' : 'Codex'}: `;
    const span = document.createElement('span'); p.append(label, span); $('transcript').append(p);
    item = { span, text: '' }; parts.set(role, item);
  }
  item.text = done ? text : item.text + text; item.span.textContent = item.text;
  if (done) parts.delete(role);
  $('transcript').scrollTop = $('transcript').scrollHeight;
}
const events = new EventSource('/events');
events.onopen = () => { eventReady = true; buttons(); };
events.onerror = () => {
  eventReady = false;
  if (pc || busy) { generation++; release(); busy = false; status('Bridge connection lost. Microphone off.'); }
  else status('Live connection unavailable. Keep one browser tab open, then refresh. Microphone off.');
  buttons();
};
events.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.type === 'work-state') renderWork(message.state);
  if (message.type === 'orchestration-state') renderOrchestration(message.state);
  if (message.type === 'notice') { $('work-notice').hidden = false; $('work-notice').textContent = message.message; }
  if (message.type === 'transcript-delta') transcript(message.role, message.text, false);
  if (message.type === 'transcript-done') transcript(message.role, message.text, true);
  if (message.type === 'error' && !disconnecting && (pc || busy)) { showError(message.message); void disconnect('Voice error. Microphone off.'); }
  if (message.type === 'closed' && !disconnecting && (pc || busy)) void disconnect('Voice session ended. Microphone off.');
};
try {
  const config = await api('config');
  $('instance-project').textContent = `${config.project.name} · ${config.project.mode === 'fixture' ? 'disposable fixture' : 'configured project'}${config.project.readiness.ready ? '' : ' · setup needed: ' + config.project.readiness.issues.join('; ')}`;
} catch (error) { $('instance-project').textContent = `Project configuration unavailable: ${error.message}`; }
try {
  const account = await api('prepare'); prepared = true;
  $('account').textContent = `Signed in with ChatGPT · ${account.plan || 'subscription'}. No API key used.`;
  renderWork(account.state);
  buttons();
} catch (error) { $('account').textContent = error.account?.auth === 'chatgpt' ? `Signed in with ChatGPT · ${error.account.plan || 'subscription'}. Saved chat could not be prepared.` : 'Could not prepare the Codex connection.'; showError(error); }
await loadVoices();
try { renderOrchestration(await api('orchestration')); } catch (error) { $('controller-status').textContent = error.message; }

$('connect').onclick = async () => {
  if (busy || pc || !voiceCatalog) return;
  const selectedVoice = $('voice').value; playbackError = null;
  busy = true; $('error').hidden = true; parts.clear(); $('transcript').replaceChildren(); buttons();
  const attempt = ++generation;
  try {
    status('Waiting for microphone permission…');
    const acquired = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (attempt !== generation) { acquired.getTracks().forEach(track => track.stop()); return; }
    stream = acquired;
    pc = new RTCPeerConnection();
    const connection = pc;
    let sessionToken, greetingRequested = false;
    const reportAudioStatus = async () => {
      if (pc !== connection || !sessionToken) return;
      try {
        const stats = await connection.getStats();
        if (pc !== connection) return;
        const local = stream?.getAudioTracks()[0], audio = $('audio');
        const snapshot = { connection: connection.connectionState, ice: connection.iceConnectionState, channel: channel?.readyState || null, localTrack: local?.readyState || null, localEnabled: local?.enabled ?? null, localMuted: local?.muted ?? null, remoteTrack: audio.srcObject?.getAudioTracks()[0]?.readyState || null, audioPaused: audio.paused, audioMuted: audio.muted, audioVolume: audio.volume, audioReady: audio.readyState, playbackError, packetsSent: null, packetsReceived: null, bytesSent: null, bytesReceived: null, inputEnergy: null };
        stats.forEach(r => {
          if (r.kind !== 'audio' && r.mediaType !== 'audio') return;
          if (r.type === 'outbound-rtp') { snapshot.packetsSent = r.packetsSent ?? null; snapshot.bytesSent = r.bytesSent ?? null; }
          if (r.type === 'inbound-rtp') { snapshot.packetsReceived = r.packetsReceived ?? null; snapshot.bytesReceived = r.bytesReceived ?? null; }
          if (r.type === 'media-source') snapshot.inputEnergy = r.totalAudioEnergy ?? null;
        });
        await api('voice-status', { sessionToken, status: snapshot });
      } catch { /* Diagnostics must never stop an otherwise working call. */ }
    };
    stream.getTracks().forEach(track => connection.addTrack(track, stream));
    connection.ontrack = event => {
      $('audio').srcObject = event.streams[0] || new MediaStream([event.track]);
      $('audio').play().catch(error => { playbackError = error.name || 'Playback failed'; showError('Press Play in the audio player to hear Codex.'); });
    };
    connection.onconnectionstatechange = () => {
      if (pc !== connection) return;
      if (connection.connectionState === 'connected') {
        clearTimeout(timer); active = true; busy = false; status('Connected. Microphone on — speak naturally, or interrupt Codex.'); buttons();
        if (!greetingRequested && sessionToken) {
          greetingRequested = true;
          diagnosticsTimer = setInterval(() => void reportAudioStatus(), 2000);
          void reportAudioStatus();
          void api('voice-ready', { sessionToken }).catch(error => {
            if (pc === connection) showError(`Call connected, but the greeting could not be sent: ${error.message}`);
          });
        }
      } else if (['failed', 'disconnected'].includes(connection.connectionState)) {
        showError('WebRTC connection lost.'); void disconnect('Connection lost. Microphone off.');
      }
    };
    // Standard WebRTC events channel; app-server separately relays transcript events.
    channel = connection.createDataChannel('oai-events');
    await connection.setLocalDescription(await connection.createOffer());
    status('Connecting voice through Codex…');
    const answer = await api('connect', { sdp: connection.localDescription.sdp, voice: selectedVoice });
    if (pc !== connection) return;
    timer = setTimeout(() => { showError('WebRTC did not connect within 30 seconds.'); void disconnect('Connection timed out. Microphone off.'); }, 30000);
    sessionToken = answer.sessionToken;
    await connection.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
  } catch (error) { if (attempt === generation) { showError(error); await disconnect('Could not connect. Microphone off.'); } }
};
$('disconnect').onclick = () => void disconnect();
$('mute').onclick = () => {
  const track = stream?.getAudioTracks()[0]; if (!track) return;
  const enabled = !track.enabled; stream.getAudioTracks().forEach(item => { item.enabled = enabled; });
  $('mute').textContent = enabled ? 'Mute microphone' : 'Unmute microphone';
  status(enabled ? 'Connected. Microphone on.' : 'Connected. Microphone muted; Codex may still speak.');
};
window.addEventListener('pagehide', () => {
  generation++; release(); events.close();
  navigator.sendBeacon('/api/disconnect', new Blob(['{}'], { type: 'application/json' }));
});

function renderWork(work) {
  $('work-status').textContent = work.approvals.length ? 'Codex needs your answer below.' : work.activeTurnId ? 'Codex is working. You can keep talking.' : `Codex: ${work.status}.`;
  $('chat-reference').textContent = work.threadId ? `Same backing chat: ${work.threadId}` : 'Preparing a saved Codex chat…';
  $('connectors').textContent = work.connectorError ? `Tool discovery: ${work.connectorError}` : work.connectors.length ? `MCP discovery: ${work.connectors.filter(s => s.status === 'connected').length} servers connected; ${work.connectors.filter(s => s.status !== 'connected').length} unavailable or disabled. Individual tool calls are verified below.` : 'Checking configured MCP tools…';
  $('stop-work').disabled = !work.activeTurnId;
  $('work-log').replaceChildren(...work.items.slice(-6).map(item => {
    const li = document.createElement('li');
    li.textContent = `${item.type === 'mcpToolCall' ? 'MCP' : item.type === 'commandExecution' ? 'Command' : 'Files'}: ${item.name} — ${item.status}${item.exitCode != null ? ` (exit ${item.exitCode})` : ''}`;
    return li;
  }));
  $('work-result').replaceChildren(...work.messages.filter(m => m.phase !== 'commentary').slice(-2).map(message => {
    const p = document.createElement('p'); p.textContent = message.text; return p;
  }));
  const wanted = new Set(work.approvals.map(a => a.id));
  for (const node of $('approvals').children) if (!wanted.has(node.dataset.id)) node.remove();
  for (const request of work.approvals) {
    if ([...$('approvals').children].some(node => node.dataset.id === request.id)) continue;
    const form = document.createElement('form'); form.className = 'approval'; form.dataset.id = request.id;
    const title = document.createElement('strong'); title.textContent = 'Codex needs your input'; form.append(title);
    const p = request.params;
    const explain = document.createElement('p'); explain.textContent = p.reason || p.message || 'Review this request before proceeding.'; form.append(explain);
    const fields = [];
    const submit = async response => {
      try { await api('approval', { id: request.id, response }); }
      catch (error) { $('work-notice').hidden = false; $('work-notice').textContent = error.message; }
    };
    const button = (label, response) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.onclick = () => void submit(response); form.append(b);
    };
    if (request.method === 'item/tool/requestUserInput') {
      for (const question of p.questions) {
        const label = document.createElement('label'); label.textContent = question.question;
        let input;
        if (question.options?.length) {
          input = document.createElement('select');
          const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Choose an answer'; input.append(placeholder);
          for (const option of question.options) { const node = document.createElement('option'); node.value = option.label; node.textContent = `${option.label}${option.description ? ` — ${option.description}` : ''}`; input.append(node); }
        } else { input = document.createElement('input'); input.type = question.isSecret ? 'password' : 'text'; }
        input.required = !question.isOther; label.append(input); form.append(label);
        let other;
        if (question.isOther) { other = document.createElement('input'); other.placeholder = 'Or enter another answer'; other.type = question.isSecret ? 'password' : 'text'; label.append(other); }
        fields.push({ id: question.id, input, other });
      }
      const send = document.createElement('button'); send.type = 'submit'; send.textContent = 'Send answer'; form.append(send);
      form.onsubmit = event => { event.preventDefault(); void submit({ answers: Object.fromEntries(fields.map(f => [f.id, f.other?.value || f.input.value])) }); };
    } else if (request.method === 'mcpServer/elicitation/request') {
      if (p.mode === 'form' && p._meta?.codex_approval_kind === 'mcp_tool_call' && Object.keys(p.requestedSchema?.properties || {}).length === 0) {
        const preview = document.createElement('pre'); preview.textContent = JSON.stringify(p._meta.tool_params, null, 2); form.append(preview);
        button('Allow once', { action: 'accept' }); button('Decline', { action: 'decline' });
      } else if (p.mode === 'url' && /^https:\/\//.test(p.url)) {
        const link = document.createElement('a'); link.href = p.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Open connector verification'; form.append(link);
        button('I completed verification', { action: 'accept' });
      } else {
        const text = document.createElement('p'); text.textContent = 'This connector requested a form this minimal client cannot render. Cancel it and use the normal Codex client for that flow.'; form.append(text);
      }
      button('Cancel connector request', { action: 'cancel' });
    } else {
      const preview = document.createElement('pre');
      const change = work.items.find(i => i.id === p.itemId)?.changes;
      preview.textContent = p.command ? `${p.command}\nWorking directory: ${p.cwd || ''}` : JSON.stringify(change || p.permissions || p.networkApprovalContext || p, null, 2);
      form.append(preview);
      const choices = p.availableDecisions;
      if (!choices || choices.includes('accept')) button('Allow once', { decision: 'accept' });
      if (!choices || choices.includes('decline')) button('Decline', { decision: 'decline' });
      else if (choices.includes('cancel')) button('Cancel', { decision: 'cancel' });
    }
    $('approvals').append(form);
  }
}
function renderOrchestration(view) {
  const pending = view.tasks.flatMap(task => task.attention.filter(a => !a.ackedAt));
  $('attention-title').textContent = pending.length ? `✋ ${pending.length} item${pending.length === 1 ? ' needs' : 's need'} your attention` : 'No pending worker attention';
  $('controller-status').textContent = view.error ? `Controller needs attention: ${view.error}` : `Local controller running independently of voice.${view.maxConcurrent?` Up to ${view.maxConcurrent} workers run at once.`:''}`;
  const terminal=new Set(['completed','failed','stopped','paused','disposed','canceled','cancelled']);
  const visible=[...view.tasks.filter(task=>!terminal.has(task.status)),...view.tasks.filter(task=>terminal.has(task.status)).slice(-3)];
  $('worker-state').replaceChildren(...visible.map(task => {
    const section = document.createElement('div');
    const title = document.createElement('p'); title.textContent = `${task.ticket} · ${task.id} — ${task.status}`; section.append(title);
    const progress = document.createElement('p'); progress.className = 'hint'; progress.textContent = task.result?.message || task.failure || task.progress || task.brief; section.append(progress);
    if(task.execution?.startedAt){const timing=document.createElement('p');timing.className='hint';const end=task.execution.endedAt?Date.parse(task.execution.endedAt):task.execution.live?Date.now():Date.parse(task.updatedAt);const seconds=Math.max(0,Math.floor((end-Date.parse(task.execution.startedAt))/1000));timing.textContent=`${task.execution.live?'Execution live':'Execution ended'} · this run ${seconds}s${task.environment?.status?` · environment ${task.environment.status}`:''}`;section.append(timing);}

    for (const item of task.attention.filter(a => !a.ackedAt)) {
      const p = document.createElement('p'); p.textContent = item.message; section.append(p);
      const button = document.createElement('button'); button.textContent = 'Review with manager';
      button.onclick = async () => {
        button.disabled = true;
        try { await api('discuss-attention', { taskId: task.id, attentionId: item.id }); }
        catch (error) { showError(error); }
        finally { button.disabled = false; }
      };
      section.append(button);
    }
    return section;
  }));
}
$('stop-work').onclick = async () => {
  try { await api('stop-work'); }
  catch (error) { $('work-notice').hidden = false; $('work-notice').textContent = error.message; }
};
