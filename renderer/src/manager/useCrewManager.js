import { useCallback, useEffect, useRef, useState } from 'react';
import { api, endVoiceBeacon, errorText } from './api.js';
import { chooseVoice, EMPTY_WORK } from './state.js';
import { useVoiceSession } from './useVoiceSession.js';
import { workerActionRequest } from './worker-model.js';
import { createSounds } from './sounds.js';
import { createAttentionSounds } from './attention-sounds.js';
const VOICE_KEY = 'crew.voice.v3';

// Backend state and transcript events remain evidence; they never initiate work or microphone capture.
export function useCrewManager() {
  const [error, setError] = useState('');
  const [updates, setUpdates] = useState(null);
  const [settings, setSettings] = useState(null), [settingsError, setSettingsError] = useState('');
  const [managerLifecycle, setManagerLifecycle] = useState({ state: 'loading' });
  const lifecycleLock = useRef(false);
  const managerEnabled = managerLifecycle.state === 'running';
  const nativeAttentionSound = useRef(null);
  const [soundUnavailable, setSoundUnavailable] = useState(false);
  const soundRef = useRef(null);
  if (!soundRef.current) soundRef.current = createSounds({ onUnavailable: setSoundUnavailable });
  const sounds = soundRef.current;
  const attentionRef = useRef(null);
  if (!attentionRef.current) {
    let storage; try { storage = window.localStorage; } catch { /* In-memory dedup. */ }
    attentionRef.current = createAttentionSounds(kind => sounds.play(kind), storage);
  }
  const voice = useVoiceSession(setError, sounds);
  const [prepared, setPrepared] = useState(false), [eventReady, setEventReady] = useState(false);
  const [account, setAccount] = useState('Checking ChatGPT sign-in…');
  const [project, setProject] = useState('Loading this instance’s project…');
  const [projectInfo, setProjectInfo] = useState(null);
  const [sending, setSending] = useState(false);
  const requestLock = useRef(false);
  const retryRequests = useRef(new Map());
  const [work, setWork] = useState(EMPTY_WORK), [workNotice, setWorkNotice] = useState('');
  const [orchestration, setOrchestration] = useState({ tasks: [], loading: true });
  const [workerApprovals, setWorkerApprovals] = useState([]);
  const [catalog, setCatalog] = useState(null), [selectedVoice, setSelectedVoice] = useState('');
  const [voiceLoading, setVoiceLoading] = useState(true), [voiceNotice, setVoiceNotice] = useState('Loading available Codex voices. Microphone stays off.');
  useEffect(() => {
    const unlock = () => sounds.unlock();
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    return () => { window.removeEventListener('pointerdown', unlock, true); window.removeEventListener('keydown', unlock, true); sounds.dispose(); };
  }, [sounds]);
  useEffect(() => { if (nativeAttentionSound.current === false) attentionRef.current(work, orchestration, workerApprovals); }, [work, orchestration, workerApprovals, projectInfo]);
  const showError = useCallback(value => setError(errorText(value)), []);
  const loadVoices = useCallback(async () => {
    setVoiceLoading(true); setVoiceNotice('Loading available Codex voices. Microphone stays off.');
    try {
      const next = await api('voices');
      let saved;
      try { saved = localStorage.getItem(VOICE_KEY) || localStorage.getItem('relay.voice.v3') || localStorage.getItem('ai-manager.voice.v3'); } catch { /* Storage can be unavailable. */ }
      const selected = chooseVoice(next, saved);
      setCatalog(next); setSelectedVoice(selected);
      try { if (saved) localStorage.setItem(VOICE_KEY, selected); } catch { /* Selection still applies to this call. */ }
      setVoiceNotice(saved && saved !== selected ? 'Your saved voice is no longer available. Codex default selected for the next call.' : '');
    } catch (failure) { setCatalog(null); setVoiceNotice(`Could not load Codex voices: ${errorText(failure)} Retry before connecting.`); }
    finally { setVoiceLoading(false); }
  }, []);
  const changeVoice = useCallback(value => {
    setSelectedVoice(value);
    try { localStorage.setItem(VOICE_KEY, value); setVoiceNotice(''); }
    catch { setVoiceNotice('Selected for your next call. Browser storage is unavailable, so this choice will not survive a refresh.'); }
  }, []);
  useEffect(() => {
    let canceled = false;
    const events = new EventSource('/events');
    events.onopen = () => { if (!canceled) setEventReady(true); };
    events.onerror = () => { if (!canceled) { setEventReady(false); voice.transportLost(); } };
    events.onmessage = event => {
      if (canceled) return;
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'update-state') setUpdates(message.status);
        if (message.type === 'work-state') { setWork(message.state); if (message.state.managerLifecycle) setManagerLifecycle(message.state.managerLifecycle); }
        if (message.type === 'manager-lifecycle') {
          setManagerLifecycle(message.state);
          if ('activeVersion' in message.state) setSettings(previous => previous ? ({ ...previous, manager: { ...previous.manager, activeVersion: message.state.activeVersion, retainedVersion: message.state.retainedVersion, pendingRestart: previous.manager.saved.version !== (message.state.activeVersion || message.state.retainedVersion) } }) : previous);
          if (message.state.state !== 'running') voice.dispose();
        }
        if(message.type==='update-plan-state')setUpdates(previous=>({...previous,plan:message.plan}));
        if (message.type === 'orchestration-state') setOrchestration(message.state);
        if (message.type === 'worker-approval-state') setWorkerApprovals(message.requests);
        if (message.type === 'notice') setWorkNotice(message.message);
        voice.handleEvent(message);
      } catch (failure) { showError(`Could not read a live update: ${errorText(failure)}`); }
    };
    void (async () => {
      let bootstrapRunning = false;
      try {
        const config = await api('config');
        if (!canceled) { nativeAttentionSound.current = config.nativeAttentionSound === true; setProjectInfo(config.project); setProject(`${config.project.name} · ${config.project.mode === 'fixture' ? 'disposable fixture' : 'configured project'}${config.project.readiness.ready ? '' : ' · setup needed: ' + config.project.readiness.issues.join('; ')}`); }
      } catch (failure) { if (!canceled) setProject(`Project configuration unavailable: ${errorText(failure)}`); }
      if (canceled) return;
      try {
        const nextSettings = await api('settings', {}, { method: 'GET' });
        bootstrapRunning = nextSettings.managerLifecycle.state === 'running';
        if (!canceled) { setSettings(nextSettings); setManagerLifecycle(nextSettings.managerLifecycle); }
        const result = nextSettings.managerLifecycle.state === 'running' ? await api('prepare') : { state: await api('state') };
        if (!canceled) { setPrepared(nextSettings.managerLifecycle.state === 'running'); setAccount(nextSettings.managerLifecycle.state === 'running' ? `Signed in with ChatGPT · ${result.plan || 'subscription'}. No API key used.` : 'Manager stopped. Start explicitly to reconnect the saved conversation.'); if (result.state) setWork(result.state); }
        const refreshed = await api('settings', {}, { method: 'GET' });
        if (!canceled) { setSettings(refreshed); setManagerLifecycle(refreshed.managerLifecycle); }
      } catch (failure) {
        if (!canceled) { setSettingsError(errorText(failure)); setAccount(failure.account?.auth === 'chatgpt' ? `Signed in with ChatGPT · ${failure.account.plan || 'subscription'}. Saved chat could not be prepared.` : 'Could not prepare the Codex connection.'); showError(failure); }
      }
      if (canceled) return;
      if (bootstrapRunning) await loadVoices();
      else { setVoiceLoading(false); setVoiceNotice('Start your manager to load available voices.'); }
      if (canceled) return;
      try { const result = await api('orchestration'); if (!canceled) setOrchestration(result); }
      catch (failure) { if (!canceled) setOrchestration(previous => ({ ...previous, loading: false, error: errorText(failure) })); }
    })();
    const pagehide = () => { voice.dispose(); events.close(); endVoiceBeacon(); };
    window.addEventListener('pagehide', pagehide);
    return () => { canceled = true; events.close(); window.removeEventListener('pagehide', pagehide); endVoiceBeacon(); };
  }, [loadVoices, showError, voice.transportLost, voice.handleEvent, voice.dispose]);
  const connect = useCallback(() => {
    if (!managerEnabled || !prepared || !eventReady || !catalog || voice.busy || voice.allocated) return;
    setError(''); void voice.connect(selectedVoice);
  }, [managerEnabled, prepared, eventReady, catalog, voice.busy, voice.allocated, voice.connect, selectedVoice]);
  const reviewAttention = useCallback(async (taskId, attentionId) => {
    try { await api('discuss-attention', { taskId, attentionId }); } catch (failure) { showError(failure); throw failure; }
  }, [showError]);
  const answerApproval = useCallback(async (id, response) => {
    try { await api('approval', { id, response }); } catch (failure) { setWorkNotice(errorText(failure)); }
  }, []);
  const answerWorkerApproval = useCallback(async (request, response) => {
    const { taskId, runId, approvalId, threadId, turnId, requestId } = request;
    try { await api('worker-approval', { taskId, runId, approvalId, threadId, turnId, requestId, response }); }
    catch (failure) { setWorkNotice(errorText(failure)); throw failure; }
  }, []);
  const interruptManager = useCallback(async () => {
    try { await api('stop-work'); } catch (failure) { setWorkNotice(errorText(failure)); }
  }, []);
  const retryConnection = useCallback(async () => {
    setError(''); setAccount('Reconnecting your saved chat…');
    try { const result = await api('prepare'); setPrepared(true); setAccount(`Signed in with ChatGPT · ${result.plan || 'subscription'}.`); if (result.state) setWork(result.state); const refreshed = await api('settings', {}, { method: 'GET' }); setSettings(refreshed); setManagerLifecycle(refreshed.managerLifecycle); setSettingsError(''); await loadVoices(); }
    catch (failure) { setPrepared(false); showError(failure); }
  }, [loadVoices, showError]);
  const sendRequest = useCallback(async request => {
    if (!managerEnabled) throw new Error('Start your manager before sending a message or action.');
    if (requestLock.current) throw new Error('A message is already being sent.');
    requestLock.current = true; setSending(true); setWorkNotice('');
    try { return await api('work', request); }
    catch (failure) { setWorkNotice(errorText(failure)); throw failure; }
    finally { requestLock.current = false; setSending(false); }
  }, [managerEnabled]);
  const correlatedRequest = useCallback(async (key, create) => {
    const request = retryRequests.current.get(key) || create();
    retryRequests.current.set(key, request);
    const result = await sendRequest(request);
    retryRequests.current.delete(key);
    return result;
  }, [sendRequest]);
  const sendMessage = useCallback(text => correlatedRequest(`message:${text}`, () => ({ text, requestId: `message-${crypto.randomUUID()}` })), [correlatedRequest]);
  const workerAction = useCallback((task, action) => correlatedRequest(`worker:${task.id}:${task.runId}:${action}`, () => workerActionRequest(task, action)), [correlatedRequest]);
  const loadSettings = useCallback(async () => {
    try { const result = await api('settings', {}, { method: 'GET' }); setSettings(result); setManagerLifecycle(result.managerLifecycle); setSettingsError(''); return result; }
    catch (failure) { setSettingsError(errorText(failure)); throw failure; }
  }, []);
  const savePrompt = useCallback(async (role, text, expectedVersion) => {
    await api('settings/prompts', { role, text, expectedVersion }, { method: 'PUT' });
    return await loadSettings();
  }, [loadSettings]);
  const changeManagerLifecycle = useCallback(async action => {
    if (lifecycleLock.current) return;
    lifecycleLock.current = true;
    setManagerLifecycle(previous => ({ ...previous, state: action === 'start' ? 'starting' : action === 'stop' ? 'stopping' : 'restarting', error: '' }));
    try {
      if (action !== 'start') { voice.dispose(); await voice.disconnect('Manager stopped. Microphone off.'); }
      const result = await api('manager/lifecycle', { action });
      if (result.managerLifecycle) setManagerLifecycle(result.managerLifecycle);
      if (result.state) setWork(result.state);
      await loadSettings();
      if (action !== 'stop') { setError(''); const preparedResult = await api('prepare'); setPrepared(true); setAccount(`Signed in with ChatGPT · ${preparedResult.plan || 'subscription'}. No API key used.`); if (preparedResult.state) setWork(preparedResult.state); await loadSettings(); await loadVoices(); }
      else setAccount('Manager stopped. Start explicitly to reconnect the saved conversation.');
    } catch (failure) {
      try { await loadSettings(); } catch { setManagerLifecycle(previous => ({ ...previous, state: 'error', error: errorText(failure) })); }
      setSettingsError(errorText(failure));
      throw failure;
    } finally { lifecycleLock.current = false; }
  }, [loadSettings, loadVoices, voice.dispose, voice.disconnect]);
  return { settings, settingsError, loadSettings, savePrompt, managerLifecycle, managerEnabled, changeManagerLifecycle, error, soundUnavailable, updates, project, projectInfo, account, prepared, eventReady, work, workNotice, orchestration, workerApprovals, answerWorkerApproval, catalog, selectedVoice, voiceLoading, voiceNotice, changeVoice, loadVoices, voice, connect, reviewAttention, answerApproval, interruptManager, sending, sendMessage, workerAction, retryConnection };
}
