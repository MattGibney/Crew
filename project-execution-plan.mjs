// Read committed project instructions and commands; never run project commands.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { posix, resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

const run = promisify(execFile);
const FILE_LIMIT = 128 * 1024;
const TOTAL_LIMIT = 512 * 1024;
const SOURCE_LIMIT = 20;
const digest = content => createHash('sha256').update(content).digest('hex');

// Deliberately bounded TOML subset: string/scalar metadata, [setup], [[actions]].
// Reject unsupported syntax rather than execute a guessed or partial command.
export function parseProjectEnvironmentToml(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > FILE_LIMIT || content.includes('\0')) {
    throw new Error('Environment TOML exceeds the supported text limit.');
  }
  const input = content.replace(/^\uFEFF/, '');
  let index = 0, section = null, setup = null;
  const actions = [], seen = new Set();
  function fail(detail) { throw new Error(`Environment TOML: ${detail} (line ${input.slice(0, index).split('\n').length}).`); }
  function horizontal() { while (input[index] === ' ' || input[index] === '\t' || input[index] === '\r') index++; }
  function endLine() {
    horizontal();
    if (input[index] === '#') while (index < input.length && input[index] !== '\n') index++;
    if (index < input.length && input[index] !== '\n') fail('unsupported trailing syntax');
    if (input[index] === '\n') index++;
  }
  function string() {
    const quote = input[index], multiline = input.slice(index, index + 3) === quote.repeat(3);
    index += multiline ? 3 : 1;
    if (multiline && input.slice(index, index + 2) === '\r\n') index += 2;
    else if (multiline && input[index] === '\n') index++;
    let value = '';
    while (index < input.length) {
      if (input.slice(index, index + (multiline ? 3 : 1)) === quote.repeat(multiline ? 3 : 1)) {
        index += multiline ? 3 : 1;
        return value;
      }
      const char = input[index++];
      if (!multiline && (char === '\n' || char === '\r')) fail('newline in a single-line string');
      if (char === '\r' && input[index] === '\n') continue;
      if (char === '\\' && quote === '"') {
        if (multiline && /^[ \t\r\n]/.test(input[index] || '')) {
          const whitespace = /^[ \t\r\n]+/.exec(input.slice(index))[0];
          if (!whitespace.includes('\n')) fail('invalid string escape');
          index += whitespace.length;
          continue;
        }
        const escaped = input[index++];
        const escapes = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
        if (Object.hasOwn(escapes, escaped)) value += escapes[escaped];
        else if (escaped === 'u' || escaped === 'U') {
          const length = escaped === 'u' ? 4 : 8, hex = input.slice(index, index + length);
          if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(hex)) fail('invalid Unicode escape');
          const code = parseInt(hex, 16);
          if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) fail('invalid Unicode code point');
          value += String.fromCodePoint(code); index += length;
        } else fail('unsupported string escape');
      } else {
        if ((char.charCodeAt(0) < 32 && !['\n', '\t', '\r'].includes(char)) || char === '\u007f') fail('control character in string');
        value += char;
      }
    }
    fail('unterminated string');
  }
  while (index < input.length) {
    horizontal();
    if (input[index] === '\n' || input[index] === '#' || index === input.length) { endLine(); continue; }
    if (input[index] === '[') {
      const end = input.indexOf('\n', index), line = input.slice(index, end < 0 ? input.length : end);
      const header = /^(\[\[?)([A-Za-z0-9_.-]+)(\]\]?)[ \t\r]*(?:#.*)?$/.exec(line);
      if (!header || header[1].length !== header[3].length) fail('unsupported table syntax');
      index += line.length;
      if (header[2] === 'setup' && header[1] === '[') {
        if (setup) fail('duplicate setup table');
        setup = {}; section = setup;
      } else if (header[2] === 'actions' && header[1] === '[[') {
        if (actions.length >= 32) fail('too many actions');
        section = {}; actions.push(section);
      } else fail('unsupported table; select a supported environment file or enter commands explicitly');
      endLine(); continue;
    }
    const match = /^([A-Za-z0-9_-]+)[ \t]*=[ \t]*/.exec(input.slice(index));
    if (!match) fail('unsupported assignment syntax');
    const key = match[1], scope = section || seen;
    if (section ? Object.hasOwn(section, key) : seen.has(key)) fail(`duplicate key ${key}`);
    index += match[0].length;
    let value;
    if (input[index] === '"' || input[index] === "'") value = string();
    else {
      const scalar = /^(?:true|false|[+-]?[0-9]+)(?=[ \t\r\n#]|$)/.exec(input.slice(index));
      if (!scalar) fail('unsupported value; only string and scalar metadata are supported');
      value = scalar[0]; index += scalar[0].length;
      if (key === 'script' || key === 'command' || key === 'name') fail(`${key} must be a string`);
    }
    if (section) scope[key] = value; else seen.add(key);
    endLine();
  }
  if (setup && (typeof setup.script !== 'string' || !setup.script.trim() || setup.script.includes('\0'))) throw new Error('Environment TOML setup.script must be a nonempty string.');
  for (const action of actions) {
    if (typeof action.name !== 'string' || !action.name.trim() || typeof action.command !== 'string' || !action.command.trim() || action.command.includes('\0')) {
      throw new Error('Environment TOML actions require nonempty name and command strings.');
    }
  }
  return { setup: setup ? { command: setup.script } : null, actions: actions.map(({ name, command }) => ({ name, command })) };
}

// Mask quoted strings and comments before inspecting this single permission.
// Strings spanning lines cannot spoof a section or setting inside their content.
export function parseProjectNetworkAccess(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > FILE_LIMIT || content.includes('\0')) {
    throw new Error('Codex permission config exceeds the supported text limit.');
  }
  let masked = '', quote = null, triple = false;
  for (let index = 0; index < content.length; index++) {
    const char = content[index];
    if (quote) {
      if (char === '\\' && quote === '"') {
        const next = content[++index];
        if (next === undefined || (!triple && (next === '\n' || next === '\r'))) throw new Error('Malformed quoted permission config.');
        masked += next === '\n' ? ' \n' : '  ';
      } else if (char === quote && (!triple || content.slice(index, index + 3) === quote.repeat(3))) {
        masked += triple ? '   ' : ' '; index += triple ? 2 : 0; quote = null;
      } else {
        if (!triple && (char === '\n' || char === '\r')) throw new Error('Malformed quoted permission config.');
        masked += char === '\n' ? '\n' : ' ';
      }
    } else if (char === '"' || char === "'") {
      quote = char; triple = content.slice(index, index + 3) === char.repeat(3);
      masked += triple ? '   ' : ' '; index += triple ? 2 : 0;
    } else if (char === '#') {
      while (index < content.length && content[index] !== '\n') index++;
      masked += '\n';
    } else masked += char;
  }
  if (quote) throw new Error('Unterminated string in Codex permission config.');
  let relevant = false, declared = false, result = null, sectionSeen = false;
  for (const line of masked.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    if (text.startsWith('[')) {
      const header = /^(\[\[?)([A-Za-z0-9_.-]+)(\]\]?)$/.exec(text);
      if (!header || header[1].length !== header[3].length) throw new Error('Unsupported permission config table syntax.');
      relevant = text === '[sandbox_workspace_write]';
      if (relevant && sectionSeen) throw new Error('Duplicate sandbox_workspace_write permission table.');
      if (relevant) sectionSeen = true;
      continue;
    }
    if (!relevant) continue;
    if (/^network_access(?:\s|=|$)/.test(text)) {
      const value = /^network_access\s*=\s*(true|false)$/.exec(text);
      if (!value || declared) throw new Error('network_access must be declared once as a TOML boolean.');
      declared = true; result = value[1] === 'true';
    }
  }
  return result;
}

export async function discoverProjectExecutionPlan({ path, ref, environmentPath, env = process.env } = {}) {
  if (typeof path !== 'string' || !path.trim() || path.includes('\0')) throw new Error('Choose a local Git repository.');
  if (typeof ref !== 'string' || !ref.trim() || ref.startsWith('-') || /[\u0000-\u001f\u007f]/.test(ref) || ref.length > 1024) {
    throw new Error('Choose an existing committed starting reference.');
  }
  const selected = await realpath(resolve(path));
  const git = async (args, maxBuffer = TOTAL_LIMIT) => (await run('git', ['-C', selected, ...args], {
    env: { ...env, GIT_OPTIONAL_LOCKS: '0' }, timeout: 10000, maxBuffer, encoding: 'buffer',
  })).stdout;
  let repositoryPath, commit;
  try {
    repositoryPath = await realpath((await git(['rev-parse', '--show-toplevel'])).toString().trim());
    commit = (await git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).toString().trim();
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error();
  } catch { throw new Error('The selected repository or committed starting reference is unavailable.'); }
  const plan = { schemaVersion: 1, status: 'incomplete', repository: { path: repositoryPath, ref, commit }, networkAccess: null, localPermissions: { networkAccess: null, source: null }, sources: [], setup: null, actions: [], instructions: [], issues: [] };
  const issueKeys = new Set();
  const issue = (file, detail) => {
    const key = `${file}\0${detail}`;
    if (issueKeys.has(key) || plan.issues.length >= 32) return;
    issueKeys.add(key); plan.issues.push({ path: file, detail });
  };
  const listing = (await git(['ls-tree', '--full-tree', '-r', '-z', '--long', commit], 8 * 1024 * 1024)).toString();
  const files = new Map();
  for (const record of listing.split('\0')) {
    const match = /^(\d+) blob ([a-f0-9]+)\s+(\d+)\t([\s\S]+)$/.exec(record);
    if (match) files.set(match[4], { mode: match[1], size: Number(match[3]), blob: match[2] });
  }
  let bytes = 0;
  async function read(file, kind) {
    const entry = files.get(file);
    if (!entry) return null;
    if (!['100644', '100755'].includes(entry.mode)) { issue(file, 'Only committed regular files can supply instructions or commands.'); return null; }
    if (entry.size > FILE_LIMIT || bytes + entry.size > TOTAL_LIMIT || plan.sources.length >= SOURCE_LIMIT) {
      issue(file, 'Discovery text limit reached. Review this source separately.'); return null;
    }
    const raw = await git(['cat-file', 'blob', entry.blob], FILE_LIMIT + 1024);
    const content = raw.toString('utf8');
    if (content.includes('\0') || !Buffer.from(content).equals(raw)) { issue(file, 'Source is not supported UTF-8 text.'); return null; }
    bytes += raw.length;
    const source = { path: file, sha256: digest(raw), kind };
    plan.sources.push(source);
    return { source, content };
  }
  // Local client permission choices are separate provenance, never Git command sources.
  const localPermissionPath = join(repositoryPath, '.codex', 'config.toml');
  let localHandle;
  try {
    const directory = await lstat(join(repositoryPath, '.codex'));
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Local Codex config directory must be a regular directory.');
    const metadata = await lstat(localPermissionPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Local Codex permission config must be a regular file, not a symlink.');
    localHandle = await open(localPermissionPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const owned = await localHandle.stat();
    if (!owned.isFile() || owned.size > FILE_LIMIT) throw new Error('Local Codex permission config exceeds the supported text limit.');
    const buffer = Buffer.alloc(FILE_LIMIT + 1);
    const { bytesRead } = await localHandle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > FILE_LIMIT) throw new Error('Local Codex permission config exceeds the supported text limit.');
    const raw = buffer.subarray(0, bytesRead), content = raw.toString('utf8');
    if (!Buffer.from(content).equals(raw) || content.includes('\0')) throw new Error('Local Codex permission config must be UTF-8 text.');
    if (await realpath(localPermissionPath) !== localPermissionPath) throw new Error('Local Codex permission config must remain inside the canonical project directory.');
    plan.localPermissions.source = { path: localPermissionPath, sha256: digest(raw) };
    plan.localPermissions.networkAccess = parseProjectNetworkAccess(content);
    if (plan.localPermissions.networkAccess === null) issue(localPermissionPath, 'No supported explicit network permission boolean was declared locally.');
  } catch (error) {
    if (error.code !== 'ENOENT') issue(localPermissionPath, error.message);
  } finally { await localHandle?.close(); }
  const permissionPath = '.codex/config.toml';
  const permissions = await read(permissionPath, 'permissions');
  if (permissions) {
    try {
      plan.networkAccess = parseProjectNetworkAccess(permissions.content);
      if (plan.networkAccess === null) issue(permissionPath, 'No supported explicit sandbox_workspace_write.network_access boolean was declared.');
    } catch (error) { issue(permissionPath, error.message); }
  } else if (!files.has(permissionPath)) issue(permissionPath, 'No committed Codex permission config was found; committed network policy is unknown. Explicit local client choices are reported separately.');
  const candidates = [...files.keys()].filter(file => /^\.codex\/environments\/[^/]+\.toml$/.test(file)).sort();
  let chosen = environmentPath;
  if (chosen !== undefined && (typeof chosen !== 'string' || !candidates.includes(chosen))) {
    issue(typeof chosen === 'string' ? chosen : '.codex/environments', 'Choose a committed environment TOML file from this reference.'); chosen = null;
  } else if (chosen === undefined) {
    if (candidates.length === 1) chosen = candidates[0];
    else { chosen = null; issue('.codex/environments', candidates.length ? 'Multiple environment files are available. Choose one explicitly.' : 'No committed environment TOML was found. Review project instructions for commands.'); }
  }
  if (chosen) {
    const file = await read(chosen, 'environment');
    if (file) {
      try {
        const parsed = parseProjectEnvironmentToml(file.content), source = { path: file.source.path, sha256: file.source.sha256 };
        plan.setup = parsed.setup ? { ...parsed.setup, role: 'setup', source } : null;
        plan.actions = parsed.actions.map(action => ({ ...action, role: null, source }));
        if (plan.setup || plan.actions.length) plan.status = 'discovered';
        else issue(chosen, 'No setup script or named actions were declared.');
      } catch (error) { issue(chosen, error.message); }
    }
  }
  const skillFiles = [...files.keys()].filter(file => /^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(file)).sort();
  if (skillFiles.length > 8) issue('.claude/skills', 'Only the first eight committed skill files were included. Review additional skills when applicable.');
  const queue = ['AGENTS.md', 'CLAUDE.md', ...skillFiles.slice(0, 8)];
  const visited = new Set();
  while (queue.length) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const result = await read(file, 'instruction');
    if (!result) continue;
    plan.instructions.push({ path: file, sha256: result.source.sha256, content: result.content });
    // Follow only explicit local Markdown/@ references. Never read a working-tree file.
    const references = [...result.content.matchAll(/\]\(([^)\s]+\.md)(?:#[^)]*)?\)|(?:^|\s)@([^\s]+\.md)/gm)].map(match => match[1] || match[2]);
    for (const reference of references) {
      if (reference.startsWith('/') || reference.includes(':') || reference.includes('\\')) continue;
      const relative = posix.normalize(posix.join(posix.dirname(file), reference));
      if (relative.startsWith('../') || !files.has(relative) || visited.has(relative) || queue.includes(relative)) continue;
      if (visited.size + queue.length >= SOURCE_LIMIT) { issue(relative, 'Instruction discovery file limit reached. Review this reference separately.'); continue; }
      queue.push(relative);
    }
  }
  return plan;
}
