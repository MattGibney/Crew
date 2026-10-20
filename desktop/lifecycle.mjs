// AI-007: pure desktop lifecycle rules, shared with focused tests.
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
export function instanceKey(configPath) {
  return createHash('sha256').update(resolve(configPath)).digest('hex').slice(0, 24);
}
export function summarizeTasks(view) {
  if (!view || view.error || !Array.isArray(view.tasks)) return { active: null, pending: null };
  return {
    active: view.tasks.filter(task => !['completed', 'failed', 'canceled', 'cancelled'].includes(task.status)).length,
    pending: view.tasks.reduce((count, task) => count + (task.attention || []).filter(item => !item.ackedAt).length, 0)
  };
}
export function isAppURL(url, origin) {
  try { const parsed = new URL(url); return parsed.origin === origin && parsed.username === '' && parsed.password === ''; }
  catch { return false; }
}
export function isExternalHTTPS(url) {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && parsed.hostname !== '' && parsed.username === '' && parsed.password === ''; }
  catch { return false; }
}
export function permitsAudio(permission, details, origin) {
  if (permission !== 'media' || !isAppURL(details.requestingUrl || details.securityOrigin || '', origin)) return false;
  if (Array.isArray(details.mediaTypes)) return details.mediaTypes.length > 0 && details.mediaTypes.every(type => type === 'audio');
  return details.mediaType === 'audio';
}
export function childEnvironment(configPath, parent = process.env) {
  const env = { ...parent, ELECTRON_RUN_AS_NODE: '1', AI_MANAGER_CONFIG: configPath };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL']) delete env[key];
  const paths = String(env.PATH || '').split(':').filter(Boolean);
  env.PATH = [...new Set([...paths, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
  return env;
}
