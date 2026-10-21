import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { api, endVoiceBeacon, errorText } from './api.js';
import { chooseVoice, EMPTY_TRANSCRIPT, EMPTY_WORK, transcriptReducer } from './state.js';
import { useVoiceSession } from './useVoiceSession.js';
import { workerActionRequest } from './worker-model.js';
const VOICE_KEY = 'crew.voice.v3';

// Backend state and transcript events remain evidence; they never initiate work or microphone capture.
export function useCrewManager() {
  const [error, setError] = useState('');
  const voice = useVoiceSession(setError);
  const [prepared, setPrepared] = useState(false), [eventReady, setEventReady] = useState(false);
  const [account, setAccount] = useState('Checking ChatGPT sign-in…');
  const [project, setProject] = useState('Loading this instance’s project…');
  const [projectInfo, setProjectInfo] = useState(null);
  const [sending, setSending] = useState(false);
  const requestLock = useRef(false);
  const retryRequests = useRef(new Map());
  const [work, setWork] = useState(EMPTY_WORK), [workNotice, setWorkNotice] = useState('');
  const [orchestration, setOrchestration] = useState({ tasks: [], loading: true });
  const [transcript, dispatchTranscript] = useReducer(transcriptReducer, EMPTY_TRANSCRIPT);
  const [catalog, setCatalog] = useState(null), [selectedVoice, setSelectedVoice] = useState('');
  const [voiceLoading, setVoiceLoading] = useState(true), [voiceNotice, setVoiceNotice] = useState('Loading available Codex voices. Microphone stays off.');
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
        if (message.type === 'work-state') setWork(message.state);
        if (message.type === 'orchestration-state') setOrchestration(message.state);
        if (message.type === 'notice') setWorkNotice(message.message);
        if (message.type === 'transcript-delta' || message.type === 'transcript-done') dispatchTranscript({ role: message.role, text: message.text, done: message.type === 'transcript-done' });
        voice.handleEvent(message);
      } catch (failure) { showError(`Could not read a live update: ${errorText(failure)}`); }
    };
    void (async () => {
      try {
        const config = await api('config');
        if (!canceled) { setProjectInfo(config.project); setProject(`${config.project.name} · ${config.project.mode === 'fixture' ? 'disposable fixture' : 'configured project'}${config.project.readiness.ready ? '' : ' · setup needed: ' + config.project.readiness.issues.join('; ')}`); }
      } catch (failure) { if (!canceled) setProject(`Project configuration unavailable: ${errorText(failure)}`); }
      if (canceled) return;
      try {
        const result = await api('prepare');
        if (!canceled) { setPrepared(true); setAccount(`Signed in with ChatGPT · ${result.plan || 'subscription'}. No API key used.`); if (result.state) setWork(result.state); }
      } catch (failure) {
        if (!canceled) { setAccount(failure.account?.auth === 'chatgpt' ? `Signed in with ChatGPT · ${failure.account.plan || 'subscription'}. Saved chat could not be prepared.` : 'Could not prepare the Codex connection.'); showError(failure); }
      }
      if (canceled) return;
      await loadVoices();
      if (canceled) return;
      try { const result = await api('orchestration'); if (!canceled) setOrchestration(result); }
      catch (failure) { if (!canceled) setOrchestration(previous => ({ ...previous, loading: false, error: errorText(failure) })); }
    })();
    const pagehide = () => { voice.dispose(); events.close(); endVoiceBeacon(); };
    window.addEventListener('pagehide', pagehide);
    return () => { canceled = true; events.close(); window.removeEventListener('pagehide', pagehide); endVoiceBeacon(); };
  }, [loadVoices, showError, voice.transportLost, voice.handleEvent, voice.dispose]);
  const connect = useCallback(() => {
    if (!prepared || !eventReady || !catalog || voice.busy || voice.allocated) return;
    setError(''); dispatchTranscript({ type: 'reset' }); void voice.connect(selectedVoice);
  }, [prepared, eventReady, catalog, voice.busy, voice.allocated, voice.connect, selectedVoice]);
  const reviewAttention = useCallback(async (taskId, attentionId) => {
    try { await api('discuss-attention', { taskId, attentionId }); } catch (failure) { showError(failure); throw failure; }
  }, [showError]);
  const answerApproval = useCallback(async (id, response) => {
    try { await api('approval', { id, response }); } catch (failure) { setWorkNotice(errorText(failure)); }
  }, []);
  const stopManager = useCallback(async () => {
    try { await api('stop-work'); } catch (failure) { setWorkNotice(errorText(failure)); }
  }, []);
  const retryConnection = useCallback(async () => {
    setError(''); setAccount('Reconnecting your saved chat…');
    try { const result = await api('prepare'); setPrepared(true); setAccount(`Signed in with ChatGPT · ${result.plan || 'subscription'}.`); if (result.state) setWork(result.state); await loadVoices(); }
    catch (failure) { setPrepared(false); showError(failure); }
  }, [loadVoices, showError]);
  const sendRequest = useCallback(async request => {
    if (requestLock.current) throw new Error('A message is already being sent.');
    requestLock.current = true; setSending(true); setWorkNotice('');
    try { return await api('work', request); }
    catch (failure) { setWorkNotice(errorText(failure)); throw failure; }
    finally { requestLock.current = false; setSending(false); }
  }, []);
  const correlatedRequest = useCallback(async (key, create) => {
    const request = retryRequests.current.get(key) || create();
    retryRequests.current.set(key, request);
    const result = await sendRequest(request);
    retryRequests.current.delete(key);
    return result;
  }, [sendRequest]);
  const sendMessage = useCallback(text => correlatedRequest(`message:${text}`, () => ({ text, requestId: `message-${crypto.randomUUID()}` })), [correlatedRequest]);
  const workerAction = useCallback((task, action) => correlatedRequest(`worker:${task.id}:${task.runId}:${action}`, () => workerActionRequest(task, action)), [correlatedRequest]);
  return { error, project, projectInfo, account, prepared, eventReady, work, workNotice, orchestration, transcript: transcript.items, catalog, selectedVoice, voiceLoading, voiceNotice, changeVoice, loadVoices, voice, connect, reviewAttention, answerApproval, stopManager, sending, sendMessage, workerAction, retryConnection };
}
