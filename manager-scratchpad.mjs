// Durable project working notes. This contains explicit commitments and concise
// observable context, never private reasoning or a replacement worker record.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withStateLock } from './orchestration-store.mjs';

const SECTIONS = ['commitments', 'notes', 'decisions', 'questions'];
const STATUSES = new Set(['pending', 'delegated', 'blocked', 'completed', 'cancelled']);
const MAX_BYTES = 256 * 1024;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw Error('Invalid manager scratchpad fields.');
}
function text(value, label, max = 4000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw Error(`Invalid scratchpad ${label}.`);
  return value;
}
function sections(value) {
  const result = {};
  for (const name of SECTIONS) {
    if (!Array.isArray(value[name]) || value[name].length > 200) throw Error(`Invalid scratchpad ${name}.`);
    result[name] = value[name].map(entry => {
      if (name !== 'commitments') return text(entry, name);
      keys(entry, ['id', 'title', 'status', 'outcome', 'nextAction', 'nextReviewAt', 'references']);
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(entry.id ?? '') || !STATUSES.has(entry.status)) throw Error('Invalid scratchpad commitment identity or status.');
      const item = { id: entry.id, title: text(entry.title, 'title', 1000), status: entry.status };
      for (const field of ['outcome', 'nextAction']) if (entry[field] !== undefined) item[field] = text(entry[field], field);
      if (entry.nextReviewAt !== undefined) {
        if (typeof entry.nextReviewAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(entry.nextReviewAt) || !Number.isFinite(Date.parse(entry.nextReviewAt))) throw Error('Invalid scratchpad next review time.');
        item.nextReviewAt = new Date(entry.nextReviewAt).toISOString();
      }
      if (entry.references !== undefined) {
        keys(entry.references, ['taskId', 'runId', 'ticketUrl']);
        item.references = {};
        for (const field of ['taskId', 'runId', 'ticketUrl']) {
          if (entry.references[field] === undefined) continue;
          const reference = text(entry.references[field], field, field === 'ticketUrl' ? 2000 : 160);
          if (field === 'ticketUrl') {
            let url; try { url = new URL(reference); } catch { throw Error('Invalid scratchpad ticket URL.'); }
            if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw Error('Invalid scratchpad ticket URL.');
          }
          item.references[field] = reference;
        }
        if (!Object.keys(item.references).length) delete item.references;
      }
      return item;
    });
  }
  if (new Set(result.commitments.map(item => item.id)).size !== result.commitments.length) throw Error('Duplicate scratchpad commitment ID.');
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES - 1024) throw Error('Manager scratchpad is too large.');
  return result;
}
const empty = () => ({ schemaVersion: 1, revision: 0, updatedAt: null, commitments: [], notes: [], decisions: [], questions: [] });

export class ManagerScratchpad {
  constructor({ stateDir, onChange = () => {}, now = () => new Date().toISOString() }) {
    if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) throw Error('An absolute project state directory is required.');
    this.stateDir = stateDir;
    this.file = path.join(stateDir, 'manager-scratchpad.json');
    this.onChange = onChange;
    this.now = now;
  }

  async snapshot() {
    let raw;
    try {
      const metadata = await fs.lstat(this.file);
      if (!metadata.isFile() || metadata.size > MAX_BYTES) throw Error('Invalid manager scratchpad file.');
      raw = await fs.readFile(this.file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return empty();
      throw Error('Cannot read manager scratchpad. Existing notes are preserved.', { cause: error });
    }
    try {
      if (Buffer.byteLength(raw) > MAX_BYTES) throw Error('Scratchpad is too large.');
      const saved = JSON.parse(raw);
      keys(saved, ['schemaVersion', 'revision', 'updatedAt', ...SECTIONS]);
      if (saved.schemaVersion !== 1 || !Number.isSafeInteger(saved.revision) || saved.revision < 1 || typeof saved.updatedAt !== 'string' || !Number.isFinite(Date.parse(saved.updatedAt))) throw Error('Invalid scratchpad metadata.');
      return { schemaVersion: 1, revision: saved.revision, updatedAt: saved.updatedAt, ...sections(saved) };
    } catch (error) {
      throw Error('Malformed manager scratchpad. Existing notes are preserved.', { cause: error });
    }
  }

  async update(input) {
    keys(input, ['expectedRevision', ...SECTIONS]);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw Error('An expected scratchpad revision is required.');
    const result = await withStateLock(this.stateDir, '.manager-scratchpad-lock', async () => {
      const current = await this.snapshot();
      if (current.revision !== input.expectedRevision) throw Error('Manager scratchpad changed. Read it again before updating.');
      const nextSections = sections(Object.fromEntries(SECTIONS.map(name => [name, input[name] === undefined ? current[name] : input[name]])));
      if (SECTIONS.every(name => JSON.stringify(current[name]) === JSON.stringify(nextSections[name]))) return { snapshot: current, changed: false };
      const updatedAt = new Date(this.now()).toISOString();
      const next = { schemaVersion: 1, revision: current.revision + 1, updatedAt, ...nextSections };
      if (!Number.isSafeInteger(next.revision)) throw Error('Scratchpad revision limit reached.');
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(`${JSON.stringify(next)}\n`); await handle.sync(); } finally { await handle.close(); }
        await fs.rename(temporary, this.file);
      } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      return { snapshot: next, changed: true };
    });
    // Observer failures cannot turn a committed save into an apparent failure.
    if (result.changed) { try { await this.onChange(structuredClone(result.snapshot)); } catch {} }
    return result.snapshot;
  }
}
