// Project-owned manager preferences, independent of prompt activation and browser storage.
import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { validatePrompt, promptSnapshot } from './prompt-settings.mjs';

const defaults = { name: '', picture: null, personality: '' };
export function validateProfilePicture(picture) {
  if (picture === null) return picture;
  if (typeof picture !== 'string' || picture.length > 700000) throw Error('Choose a PNG, JPEG or WebP picture up to 512 KiB.');
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(picture);
  if (!match) throw Error('Choose a PNG, JPEG or WebP picture.');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > 512 * 1024 || bytes.toString('base64') !== match[2]) throw Error('Picture must be valid base64 and at most 512 KiB.');
  let width, height;
  if (match[1] === 'png' && bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii',12,16) === 'IHDR') {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (match[1] === 'jpeg' && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) break;
      const marker = bytes[offset++];
      if (marker === 218 || marker === 217) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && length >= 8) { height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break; }
      offset += length;
    }
  } else if (match[1] === 'webp' && bytes.length >= 30 && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP') {
    const format = bytes.toString('ascii',12,16);
    if (format === 'VP8X') { width = 1 + bytes.readUIntLE(24,3); height = 1 + bytes.readUIntLE(27,3); }
    else if (format === 'VP8 ' && bytes.subarray(23,26).equals(Buffer.from([157,1,42]))) { width = bytes.readUInt16LE(26) & 16383; height = bytes.readUInt16LE(28) & 16383; }
    else if (format === 'VP8L' && bytes[20] === 47) { const bits = bytes.readUInt32LE(21); width = 1 + (bits & 16383); height = 1 + ((bits >>> 14) & 16383); }
  }
  if (!width || !height || width > 2048 || height > 2048) throw Error('Picture must be a valid PNG, JPEG or WebP no larger than 2048 × 2048 pixels.');
  return picture;
}
function validateDetails(input) {
  if (typeof input.name !== 'string' || input.name.length > 80 || /[\x00-\x1f\x7f]/.test(input.name)) throw Error('Manager name must be at most 80 characters without control characters.');
  if (typeof input.personality !== 'string' || input.personality.length > 8000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.personality)) throw Error('Personality must be at most 8,000 characters without control characters.');
  if (input.name.trim()) validatePrompt(input.name);
  if (input.personality.trim()) validatePrompt(input.personality);
  return { name: input.name.trim(), personality: input.personality, picture: validateProfilePicture(input.picture) };
}
// Explicit, user-editable profile preferences supplement the unchanged replacement prompt.
// Empty profiles preserve the exact original snapshot, including legacy lifecycles.
export function managerProfileSnapshot(text, profile = defaults) {
  const parts = [];
  if (profile.name) parts.push(`Manager name: ${JSON.stringify(profile.name)}. You are still an AI manager. When introducing yourself by name, use this configured manager name rather than the selected audio voice name.`);
  if (profile.personality?.trim()) parts.push(`Personality and communication preferences:\n${profile.personality}`);
  return promptSnapshot(parts.length ? `${text}\n\n# Configured manager profile (editable in Settings)\n${parts.join('\n\n')}` : text);
}

export function createManagerProfile({ stateDir, projectId }) {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(projectId)) throw Error('Invalid manager profile project.');
  const directory = path.join(stateDir, 'manager-profiles'), file = path.join(directory, `${projectId}.json`);
  let pending = Promise.resolve();
  const validVoice = voice => voice === null || typeof voice === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(voice);
  const view = (voice, configured = true, details = defaults) => ({ voice, ...details, configured, version: createHash('sha256').update(JSON.stringify({ projectId, voice, voiceConfigured: configured, ...details })).digest('hex') });
  async function read() {
    let data;
    try { data = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return view(null, false); throw Error('Cannot read manager profile. Existing settings are preserved.'); }
    if (![1, 2].includes(data.schemaVersion) || data.projectId !== projectId || !validVoice(data.voice)) throw Error('Invalid manager profile. Existing settings are preserved.');
    if (data.schemaVersion === 2 && data.voiceConfigured !== undefined && typeof data.voiceConfigured !== 'boolean') throw Error('Invalid manager voice selection state. Existing settings are preserved.');
    return view(data.voice, data.schemaVersion === 1 || data.voiceConfigured !== false, validateDetails({ ...defaults, ...(data.schemaVersion === 2 ? { name: data.name, picture: data.picture, personality: data.personality } : {}) }));
  }
  function save(input, validate = () => {}) {
    const result = pending.then(async () => {
      if (!input || Object.keys(input).some(key => !['voice', 'name', 'picture', 'personality', 'expectedVersion'].includes(key)) || (Object.hasOwn(input, 'voice') && !validVoice(input.voice))) throw Error('Invalid manager profile update.');
      const current = await read();
      if (input.expectedVersion !== current.version) throw Error('Manager profile changed elsewhere. Reload Settings before saving.');
      const voice = Object.hasOwn(input, 'voice') ? input.voice : current.voice;
      const details = validateDetails({ ...defaults, ...current, ...input });
      // Saving identity must not suppress the one-time legacy voice migration.
      const configured = Object.hasOwn(input, 'voice') || current.configured;
      await validate(view(voice, configured, details));
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ schemaVersion: 2, projectId, voice, voiceConfigured: configured, ...details }) + '\n', { flag: 'wx', mode: 0o600 });
        await rename(temporary, file);
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      return view(voice, configured, details);
    });
    pending = result.catch(() => {});
    return result;
  }
  return { read, save };
}
