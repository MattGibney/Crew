import { useCallback, useEffect, useRef, useState } from 'react';
import { collectConfig, environmentChoices } from './model.js';

export function useSetup(api = window.crewSetup) {
  const [snapshot, setSnapshot] = useState(null);
  const [draft, setDraft] = useState(null);
  const [environment, setEnvironment] = useState('none');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [discoveryProgress, setDiscoveryProgress] = useState('');
  const [needsReload, setNeedsReload] = useState(false);
  const [repositoryOptions, setRepositoryOptions] = useState([]);
  const busyRef = useRef(false);
  const snapshotRef = useRef(null);
  const draftRef = useRef(null);
  const environmentRef = useRef('none');
  const needsReloadRef = useRef(false);
  const mounted = useRef(true);

  const accept = useCallback((next, fill = false) => {
    if (!mounted.current) return;
    const changed = snapshotRef.current?.revision && next?.revision !== snapshotRef.current.revision;
    if (!fill && changed) { needsReloadRef.current = true; setNeedsReload(true); }
    snapshotRef.current = next;
    setSnapshot(next);
    if (fill) {
      const value = next.config ? structuredClone(next.config) : null;
      draftRef.current = value; setDraft(value);
      const selected = environmentChoices(next).selected;
      environmentRef.current = selected; setEnvironment(selected);
      setRepositoryOptions(next.repositoryOptions || []);
      needsReloadRef.current = false; setNeedsReload(false);
    }
  }, []);

  const run = useCallback(async (label, work) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(label); setError(''); setNotice(`${label}…`);
    try {
      const result = await work();
      if (mounted.current) setNotice(result?.notice || `${label} finished.`);
      return result;
    } catch (cause) {
      if (mounted.current) {
        try { accept(await api.snapshot()); } catch { /* Keep the last known setup on connection failure. */ }
        setNotice(''); setError(cause.message || String(cause));
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy('');
    }
  }, [api, accept]);

  const refresh = useCallback(() => run('Reload setup', async () => {
    const next = await api.snapshot(); accept(next, true);
    if (next.error) throw new Error(next.error);
  }), [api, accept, run]);

  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; }; }, [refresh]);

  function edit(path, value) {
    if (!draftRef.current) return null;
    const next = structuredClone(draftRef.current);
    const keys = path.split('.');
    let target = next;
    for (const key of keys.slice(0, -1)) target = target[key];
    target[keys.at(-1)] = value;
    draftRef.current = next; setDraft(next); return next;
  }

  async function persist(next = draftRef.current, selection = environmentRef.current) {
    if (needsReloadRef.current) throw new Error('Saved settings changed. Reload saved settings before saving; your unsaved fields have been kept on screen.');
    const current = snapshotRef.current;
    const saved = await api.save({ config: collectConfig(next, current, selection), revision: current?.revision });
    accept(saved, true);
    return { notice: 'Project settings saved. No worker started.' };
  }
  const save = (label = 'Save project settings', next, selection) => run(label, () => persist(next, selection));
  const check = (method, label) => run(label, async () => { accept(await api[method]()); });

  function chooseEnvironment(value) {
    environmentRef.current = value; setEnvironment(value);
    return save('Save worker environment', undefined, value);
  }
  function chooseTeam(value) {
    const team = snapshotRef.current?.linearOptions?.teams?.find(item => item.id === value);
    const linear = { ...draftRef.current.project.linear, teamId: team?.id || '', teamKey: team?.key || '', projectId: '' };
    return save('Save Linear team', edit('project.linear', linear));
  }
  function deferLinear() {
    return save('Connect Linear later', edit('project.linear', { ...draftRef.current.project.linear, teamId: '', teamKey: '', projectId: '' }));
  }
  async function pickRepository(index = null) {
    return run(index === null ? 'Choose another project folder' : 'Choose folder', async () => {
      const selected = await api.chooseRepository();
      if (!selected) return { notice: 'Folder selection canceled.' };
      const choice = await api.repositoryOptions(selected);
      setRepositoryOptions(items => [...items.filter(item => item.path !== choice.path), choice]);
      const repositories = [...draftRef.current.project.repositories];
      const previous = index === null ? { components: [] } : repositories[index];
      const repo = { ...previous, id: choice.id, name: choice.name, path: choice.path, baseRef: choice.baseRef };
      if (index === null) repositories.push(repo); else repositories[index] = repo;
      const next = edit('project.repositories', repositories);
      if (index !== null) return persist(next);
      return { notice: 'Folder added. Save changes to keep it.' };
    });
  }
  function chooseBranch(index, value) {
    const repositories = draftRef.current.project.repositories.map((repo, i) => i === index ? { ...repo, baseRef: value || null } : repo);
    return save('Save starting branch', edit('project.repositories', repositories));
  }
  function discover() {
    return run('Set up project', async () => {
      setAnalyzing(true);
      setDiscoveryProgress('Reading project files and finding branches and Linear teams. Your saved setup stays available until the new settings are validated.');
      try {
        const next = await api.discover(); accept(next, true);
        setDiscoveryProgress(next.notice || 'Project set up and saved. You can change any setting here.');
        return { notice: next.notice || 'Your project settings are saved. Continue when ready.' };
      } catch (cause) {
        setDiscoveryProgress('Setup did not finish. Your saved settings are unchanged; try again.'); throw cause;
      } finally { setAnalyzing(false); }
    });
  }
  async function cancelDiscovery() {
    try { const result = await api.cancelDiscovery(); setDiscoveryProgress(result.notice); }
    catch (cause) { setError(cause.message || String(cause)); }
  }

  return { api, snapshot, draft, edit, environment, chooseEnvironment, busy, notice, error, analyzing, discoveryProgress, needsReload, repositoryOptions,
    run, accept, refresh, save, check, chooseTeam, deferLinear, chooseBranch, pickRepository, discover, cancelDiscovery, setNotice };
}
