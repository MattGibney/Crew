import { spawn } from 'node:child_process';
import { access, readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { attentionKeys } from '../attention-keys.mjs';

// One owner per desktop instance. Persist before playing so reloads, IPC replay
// and polling cannot repeat a sound. A ledger failure fails closed.
export function createNativeAttention({ ledgerPath, soundPath, spawnImpl = spawn, platform = process.platform, onStatus = () => {}, timeoutMs = 3000 }) {
  let seen = new Set(), work = {}, orchestration = {}, disposed = false, player, drain, scheduled = false;
  const pending = new Set();
  let status = { available: false, error: null, playing: false };
  const publish = change => { status = { ...status, ...change }; onStatus({ ...status }); };
  const ready = (async () => {
    if (platform !== 'darwin') throw new Error('Native attention sound is available on macOS only.');
    await access(soundPath);
    try {
      const raw = await readFile(ledgerPath, 'utf8');
      if (raw.length > 5_000_000) throw new Error('Attention sound history is too large.');
      const saved = JSON.parse(raw);
      if (saved.version !== 1 || !Array.isArray(saved.keys) || saved.keys.length > 20000 || saved.keys.some(key => typeof key !== 'string' || key.length > 1000)) throw new Error('Attention sound history is invalid.');
      seen = new Set(saved.keys);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    publish({ available: true });
    return true;
  })().catch(() => { publish({ available: false, error: 'Attention sound unavailable: check the sound asset and private sound history.' }); return false; });

  function play() {
    return new Promise((resolve, reject) => {
      let child, timer, cleanupTimer, settled = false, timedOut = false;
      const finish = error => {
        if (player === child) player = undefined;
        publish({ playing: false });
        if (settled) return;
        settled = true; clearTimeout(timer); clearTimeout(cleanupTimer);
        error ? reject(error) : resolve();
      };
      try { child = spawnImpl('/usr/bin/afplay', [soundPath], { stdio: 'ignore', shell: false }); player = child; }
      catch (error) { finish(error); return; }
      publish({ playing: true });
      child.once('error', finish);
      child.once('close', code => finish(code === 0 && !timedOut ? null : new Error('Attention sound playback failed.')));
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGKILL'); } catch { /* Report unavailable below. */ }
        // Keep ownership until close confirms exit. If confirmation is absent,
        // retain the player reference and truthfully expose uncertain activity.
        cleanupTimer = setTimeout(() => {
          if (settled) return;
          settled = true; publish({ available: false, error: 'Attention sound process exit could not be confirmed.', playing: true });
          reject(new Error('Attention sound process exit could not be confirmed.'));
        }, 1000);
      }, timeoutMs);
      if (disposed) { try { child.kill('SIGKILL'); } catch {} }
    });
  }
  async function flush() {
    if (!await ready || disposed || !status.available) return;
    while (pending.size && !disposed) {
      const next = [...pending].filter(key => !seen.has(key)); pending.clear();
      if (!next.length) continue;
      if (seen.size + next.length > 20000) throw new Error('Attention sound history is full.');
      const retained = new Set([...seen, ...next]);
      await mkdir(dirname(ledgerPath), { recursive: true, mode: 0o700 });
      const temporary = `${ledgerPath}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify({ version: 1, keys: [...retained] }) + '\n', { mode: 0o600 });
      await rename(temporary, ledgerPath); seen = retained;
      if (!disposed) await play();
    }
  }
  function schedule() {
    if (disposed || scheduled) return;
    scheduled = true;
    drain = (drain || Promise.resolve()).then(flush).catch(() => {
      pending.clear(); publish({ available: false, error: 'Attention sound unavailable: playback or private history could not be saved.' });
    }).finally(() => { scheduled = false; if (pending.size && !disposed && status.available) schedule(); });
  }
  function update(snapshot = {}) {
    if (disposed || status.error) return;
    if (snapshot.work && typeof snapshot.work === 'object' && !Array.isArray(snapshot.work)) work = snapshot.work;
    if (snapshot.orchestration && typeof snapshot.orchestration === 'object' && !Array.isArray(snapshot.orchestration)) orchestration = snapshot.orchestration;
    for (const key of attentionKeys(work, orchestration)) if (!seen.has(key)) pending.add(key);
    schedule();
  }
  return {
    ready, update, getStatus: () => ({ ...status }),
    async idle() { await ready; while (drain) { const active = drain; await active; if (active === drain) break; } },
    async dispose() {
      disposed = true; pending.clear();
      const child = player;
      if (child) {
        await new Promise(resolve => {
          let timer;
          const closed = () => { clearTimeout(timer); resolve(); };
          child.once('close', closed);
          timer = setTimeout(() => {
            child.removeListener('close', closed);
            publish({ available: false, error: 'Attention sound process exit could not be confirmed.', playing: true }); resolve();
          }, 1000);
          try { child.kill('SIGKILL'); } catch { /* Bounded exit confirmation still applies. */ }
        });
      }
      await drain;
    },
  };
}
