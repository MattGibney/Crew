import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const SYSTEM_TOOL_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
const fail = (code, message) => Object.assign(new Error(message), { code });
const version = value => String(value).replace(/^v/, '');
const tuple = value => version(value).split('.').map(Number);
const compare = (a, b) => { const x = tuple(a), y = tuple(b); return (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]); };

// Intentionally bounded semver grammar: unsupported expressions must be clarified,
// never interpreted as permission to install an arbitrary newest version.
export function satisfiesToolVersion(candidate, range) {
  if (!/^\d+\.\d+\.\d+$/.test(version(candidate))) return false;
  const branches = String(range).trim().split(/\s*\|\|\s*/).map(branch => {
    if (branch.trim() === '*' || branch.trim() === 'x') return [];
    return branch.trim().split(/\s+/).map(token => {
      const match = token.match(/^(>=|<=|>|<|=|\^|~)?v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/i);
      if (!match) throw fail('TOOL_REQUIREMENT_UNSUPPORTED', `Unsupported tool version requirement "${range}". Specify a numeric version or a supported semver range.`);
      return match;
    });
  });
  return branches.some(tokens => tokens.every(match => {
      const [, op = '', major, minor, patch] = match;
      const floor = `${major}.${/^\d+$/.test(minor) ? minor : 0}.${/^\d+$/.test(patch) ? patch : 0}`;
      const n = compare(candidate, floor);
      if (op === '>=') return n >= 0;
      if (op === '<=') return n <= 0;
      if (op === '>') return n > 0;
      if (op === '<') return n < 0;
      if (op === '^') {
        const upper = Number(major) ? `${Number(major) + 1}.0.0` : Number(minor || 0) ? `0.${Number(minor) + 1}.0` : `0.0.${Number(patch || 0) + 1}`;
        return n >= 0 && compare(candidate, upper) < 0;
      }
      if (op === '~') return n >= 0 && compare(candidate, minor == null ? `${Number(major) + 1}.0.0` : `${major}.${Number(minor) + 1}.0`) < 0;
      const c = tuple(candidate);
      return c[0] === Number(major) && (!/^\d+$/.test(minor) || c[1] === Number(minor)) && (!/^\d+$/.test(patch) || c[2] === Number(patch));
  }));
}

export function discoverToolRequirements({ sources = [] } = {}) {
  const result = { node: [], npm: [], sources: [], nodeProject: false };
  const add = (tool, range, source) => {
    range = String(range).trim();
    satisfiesToolVersion('22.0.0', range); // validate even when no release currently matches
    if (!result[tool].includes(range)) result[tool].push(range);
    result.sources.push({ tool, requirement: range, path: source });
  };
  for (const source of sources) {
    const name = path.basename(source.path || '');
    const content = String(source.content || '');
    if (content.length > 262144) throw fail('TOOL_REQUIREMENT_TOO_LARGE', `Tool requirements source is too large: ${source.path}`);
    if (name === 'package.json') {
      result.nodeProject = true;
      let json; try { json = JSON.parse(content); } catch { throw fail('TOOL_REQUIREMENT_INVALID', `Cannot read tool requirements from invalid JSON: ${source.path}`); }
      for (const tool of ['node', 'npm']) if (json.engines?.[tool]) add(tool, json.engines[tool], source.path);
      if (json.packageManager) {
        const match = json.packageManager.match(/^npm@([^+]+)(?:\+.*)?$/);
        if (!match) throw fail('TOOL_REQUIREMENT_UNSUPPORTED', `Crew currently manages Node/npm only. The packageManager declaration in ${source.path} requires a different package manager; resolve that project requirement before execution.`);
        add('npm', match[1], source.path);
      }
      if (json.volta?.node) add('node', json.volta.node, source.path);
      if (json.volta?.npm) add('npm', json.volta.npm, source.path);
    } else if (['.nvmrc', '.node-version'].includes(name)) add('node', content.trim(), source.path);
    else if (name === '.tool-versions') {
      for (const line of content.split('\n')) { const match = line.match(/^\s*(nodejs|node|npm)\s+([^#]+?)(?:\s*#.*)?$/); if (match) add(match[1] === 'npm' ? 'npm' : 'node', match[2].trim(), source.path); }
    } else if (/^(AGENTS|CLAUDE|SKILL)\.md$/i.test(name)) {
      // Only explicit version instructions; prose mentioning a tool alone is not a requirement.
      for (const match of content.matchAll(/\b(Node(?:\.js)?|npm)\s*(?:version\s*|v)?(\d+(?:\.\d+){0,2})(?:\.x)?(\+)?(?=$|[^\w.]|\.(?!\d))/gi)) add(match[1].toLowerCase().startsWith('node') ? 'node' : 'npm', `${match[3] ? '>=' : ''}${match[2]}`, source.path);
    }
  }
  return result;
}

function requirementsFor(requirements, tool) {
  const input = requirements?.[tool];
  return input == null ? [] : Array.isArray(input) ? input : [typeof input === 'object' ? input.requirement : input];
}
const compatible = (v, ranges) => ranges.every(r => satisfiesToolVersion(v, r));
const defaultRoot = () => path.join(os.homedir(), ...(process.platform === 'darwin' ? ['Library', 'Application Support', 'Crew', 'toolchains'] : ['.crew', 'toolchains']));
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
async function managedShellEnvironment(cacheRoot, PATH, env, create = true) {
  const shellDirectory = path.join(path.resolve(cacheRoot), `.shell-${crypto.createHash('sha256').update(PATH).digest('hex').slice(0, 20)}`);
  if(create)await fs.mkdir(shellDirectory, { recursive: true, mode: 0o700 });
  const initialization = `# Crew-owned shell environment. Personal startup files are intentionally skipped.\nunsetopt RCS\nexport PATH=${shellQuote(PATH)}\n`;
  const target = path.join(shellDirectory, '.zshenv');
  let existing; try { existing = await fs.readFile(target, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing !== initialization) {
    if(!create)throw fail('TOOL_CACHE_MISSING','The Crew-managed shell environment is missing or damaged. Prepare the environment before starting work; retained setup was not replayed.');
    const temporary = path.join(shellDirectory, `.init-${crypto.randomUUID()}`);
    await fs.writeFile(temporary, initialization, { mode: 0o600 });
    await fs.rename(temporary, target);
  }
  return { shellDirectory, env: { ...env, PATH, ZDOTDIR: shellDirectory, ...(process.platform === 'darwin' ? { SHELL: '/bin/zsh' } : {}) } };
}
const cleanEnv = env => { const out = { ...env, PATH: SYSTEM_TOOL_PATH }; delete out.NODE_OPTIONS; delete out.NODE_PATH; delete out.NPM_CONFIG_PREFIX; delete out.npm_config_prefix; return out; };

async function jsonFetch(url, fetchImpl) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(60000), redirect: 'error' });
  if (!response.ok) throw fail('TOOL_DOWNLOAD_FAILED', `Managed tool download failed (${response.status}) from ${new URL(url).hostname}. Check network access and retry.`);
  const data = await response.text();
  if (data.length > 64000000) throw fail('TOOL_DOWNLOAD_FAILED', 'Managed tool metadata exceeds the supported size.');
  return JSON.parse(data);
}
async function bytesFetch(url, fetchImpl, maxBytes = 150000000) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(120000), redirect: 'error' });
  if (!response.ok) throw fail('TOOL_DOWNLOAD_FAILED', `Managed tool download failed (${response.status}) from ${new URL(url).hostname}. Check network access and retry.`);
  const chunks = []; let length = 0;
  for await (const chunk of response.body) { length += chunk.length; if (length > maxBytes) throw fail('TOOL_DOWNLOAD_FAILED', 'Managed tool download exceeds the supported size.'); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}
async function withLock(root, action) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const lock = path.join(root, '.install-lock'); const deadline = Date.now() + 300000;
  while (true) {
    try { await fs.mkdir(lock); await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, created: Date.now() })); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Never reclaim another process's lock by guessing its identity.
      if (Date.now() >= deadline) throw fail('TOOL_CACHE_BUSY', 'Crew tool installation is still locked by another process. Retry when that installation finishes.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  try { return await action(); } finally { await fs.rm(lock, { recursive: true, force: true }); }
}
async function extract(archive, destination, strip = 1) {
  const { stdout } = await run('/usr/bin/tar', ['-tzf', archive], { maxBuffer: 8000000 });
  if (stdout.split('\n').some(entry => entry.startsWith('/') || entry.split('/').includes('..'))) throw fail('TOOL_ARCHIVE_INVALID', 'Managed tool archive contains an unsafe path.');
  await run('/usr/bin/tar', ['-xzf', archive, '--strip-components', String(strip), '-C', destination], { maxBuffer: 1000000 });
}
async function cached(root, ranges, platform, arch) {
  let entries; try { entries = await fs.readdir(root); } catch { return null; }
  const candidates = [];
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    try {
      const directory = path.join(root, entry); const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
      if (manifest.platform !== platform || manifest.arch !== arch || !compatible(manifest.nodeVersion, ranges.node) || !compatible(manifest.npmVersion, ranges.npm)) continue;
      const nodePath = path.join(directory, 'bin', 'node'); const npmPath = path.join(directory, 'bin', 'npm');
      const env = { PATH: `${path.join(directory, 'bin')}:${SYSTEM_TOOL_PATH}` };
      const actualNode = (await run(nodePath, ['--version'], { env, timeout: 10000 })).stdout.trim().replace(/^v/, '');
      const actualNpm = (await run(nodePath, [path.join(directory, 'npm', 'bin', 'npm-cli.js'), '--version'], { env, timeout: 10000 })).stdout.trim();
      await fs.access(npmPath, 1);
      if (actualNode === manifest.nodeVersion && actualNpm === manifest.npmVersion) candidates.push({ ...manifest, directory, nodePath, npmPath });
    } catch {}
  }
  return candidates.sort((a, b) => compare(b.nodeVersion, a.nodeVersion) || compare(b.npmVersion, a.npmVersion))[0] || null;
}

export async function resolveManagedToolchain({ requirements = {}, cacheRoot = defaultRoot(), env = process.env, install = true, fetchImpl = globalThis.fetch, platform = process.platform, arch = process.arch } = {}) {
  const ranges = { node: requirementsFor(requirements, 'node'), npm: requirementsFor(requirements, 'npm') };
  for (const r of [...ranges.node, ...ranges.npm]) satisfiesToolVersion('22.0.0', r);
  const baseEnv = cleanEnv(env);
  if (!ranges.node.length && requirements.nodeProject) throw fail('TOOL_REQUIREMENT_MISSING', 'This Node project does not declare its Node version. Add the intended version to its existing configuration or instructions.');
  if (!ranges.node.length && !ranges.npm.length) return { ...(await managedShellEnvironment(cacheRoot, baseEnv.PATH, baseEnv, install)), PATH: baseEnv.PATH, nodeVersion: null, npmVersion: null, requirements, cacheRoot };
  if (!ranges.node.length) throw fail('TOOL_REQUIREMENT_MISSING', 'This project specifies npm but no Node version. Add the intended Node requirement to the existing project configuration.');
  if (!['darwin', 'linux'].includes(platform) || !['arm64', 'x64'].includes(arch)) throw fail('TOOL_PLATFORM_UNSUPPORTED', `Crew managed Node is not supported on ${platform}/${arch}.`);
  cacheRoot = path.resolve(cacheRoot);
  const finish = async selected => { const PATH = `${path.join(selected.directory, 'bin')}:${SYSTEM_TOOL_PATH}`; return { ...selected, PATH, ...(await managedShellEnvironment(cacheRoot, PATH, baseEnv, install)), cacheRoot, requirements }; };
  let selected = await cached(cacheRoot, ranges, platform, arch);
  if (selected) return finish(selected);
  if (!install) throw fail('TOOL_CACHE_MISSING', 'The required Crew-managed Node/npm version is missing or damaged. Run environment preparation to install it; retained setup was not replayed.');
  try {
    return await withLock(cacheRoot, async () => {
      selected = await cached(cacheRoot, ranges, platform, arch); if (selected) return finish(selected);
      const releases = await jsonFetch('https://nodejs.org/dist/index.json', fetchImpl);
      const node = releases.filter(r => /^v\d+\.\d+\.\d+$/.test(r.version) && compatible(version(r.version), ranges.node) && r.files?.includes(`${platform === 'darwin' ? 'osx' : 'linux'}-${arch}-tar`)).sort((a, b) => compare(b.version, a.version))[0];
      if (!node) throw fail('TOOL_REQUIREMENT_CONFLICT', `No supported Node release satisfies all project requirements: ${ranges.node.join(', ')}.`);
      const npmMetadata = ranges.npm.length ? await jsonFetch('https://registry.npmjs.org/npm', fetchImpl) : { versions: { [node.npm]: await jsonFetch(`https://registry.npmjs.org/npm/${node.npm}`, fetchImpl) } };
      const npm = Object.values(npmMetadata.versions || {}).filter(r => { try { return /^\d+\.\d+\.\d+$/.test(r.version) && compatible(r.version, ranges.npm) && (!r.engines?.node || satisfiesToolVersion(version(node.version), r.engines.node)); } catch { return false; } }).sort((a, b) => compare(b.version, a.version))[0];
      if (!npm) throw fail('TOOL_REQUIREMENT_CONFLICT', `No npm release satisfies the project requirements and Node ${version(node.version)}.`);
      // With no npm requirement, retain the release's known bundled npm version.
      const npmVersion = ranges.npm.length ? npm.version : node.npm;
      const npmRelease = npmMetadata.versions[npmVersion];
      if (!npmRelease?.dist?.integrity?.startsWith('sha512-')) throw fail('TOOL_DOWNLOAD_INVALID', 'npm registry did not supply the required SHA-512 package integrity.');
      const directory = path.join(cacheRoot, `node-${version(node.version)}-npm-${npmVersion}-${platform}-${arch}`);
      const staging = await fs.mkdtemp(path.join(cacheRoot, '.staging-'));
      try {
        const filename = `node-${node.version}-${platform}-${arch}.tar.gz`;
        const origin = `https://nodejs.org/dist/${node.version}`;
        const checksums = (await bytesFetch(`${origin}/SHASUMS256.txt`, fetchImpl, 1000000)).toString('utf8');
        const checksum = checksums.split('\n').map(line => line.trim().split(/\s+/)).find(parts => parts[1] === filename)?.[0];
        if (!/^[a-f0-9]{64}$/.test(checksum || '')) throw fail('TOOL_DOWNLOAD_INVALID', 'Official Node checksum is unavailable for this release.');
        const data = await bytesFetch(`${origin}/${filename}`, fetchImpl);
        if (crypto.createHash('sha256').update(data).digest('hex') !== checksum) throw fail('TOOL_CHECKSUM_MISMATCH', 'Node download failed checksum verification. Retry preparation.');
        const archive = path.join(staging, 'node.tar.gz'); await fs.writeFile(archive, data); await extract(archive, staging); await fs.unlink(archive);
        const npmUrl = npmRelease.dist.tarball;
        if (new URL(npmUrl).origin !== 'https://registry.npmjs.org') throw fail('TOOL_DOWNLOAD_INVALID', 'npm package download must use the official registry.');
        const npmData = await bytesFetch(npmUrl, fetchImpl);
        if (`sha512-${crypto.createHash('sha512').update(npmData).digest('base64')}` !== npmRelease.dist.integrity) throw fail('TOOL_CHECKSUM_MISMATCH', 'npm download failed integrity verification. Retry preparation.');
        await fs.mkdir(path.join(staging, 'npm')); const npmArchive = path.join(staging, 'npm.tar.gz'); await fs.writeFile(npmArchive, npmData); await extract(npmArchive, path.join(staging, 'npm')); await fs.unlink(npmArchive);
        for (const [name, script] of [['npm', 'npm-cli.js'], ['npx', 'npx-cli.js']]) { await fs.rm(path.join(staging, 'bin', name), { force: true }); await fs.symlink(`../npm/bin/${script}`, path.join(staging, 'bin', name)); }
        await fs.writeFile(path.join(staging, 'manifest.json'), JSON.stringify({ nodeVersion: version(node.version), npmVersion, platform, arch, nodeSha256: checksum, npmIntegrity: npmRelease.dist.integrity }));
        // Validate before publishing; readers only see a complete executable cache entry.
        const stagingEnv = { PATH: `${path.join(staging, 'bin')}:${SYSTEM_TOOL_PATH}` };
        const actualNode = (await run(path.join(staging, 'bin', 'node'), ['--version'], { env: stagingEnv, timeout: 10000 })).stdout.trim().replace(/^v/, '');
        const actualNpm = (await run(path.join(staging, 'bin', 'node'), [path.join(staging, 'npm', 'bin', 'npm-cli.js'), '--version'], { env: stagingEnv, timeout: 10000 })).stdout.trim();
        if (actualNode !== version(node.version) || actualNpm !== npmVersion) throw fail('TOOL_INSTALL_INVALID', 'Downloaded tool executables do not match the selected versions.');
        try {
          const retained = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
          if (retained.nodeVersion !== version(node.version) || retained.npmVersion !== npmVersion || retained.platform !== platform || retained.arch !== arch) throw fail('TOOL_CACHE_CONFLICT', 'The managed tool cache destination has unexpected ownership metadata. Preserve it and inspect the cache before retrying.');
          await fs.rename(directory, path.join(cacheRoot, `.retained-invalid-${crypto.randomUUID()}`));
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await fs.rename(staging, directory);
        selected = await cached(cacheRoot, ranges, platform, arch);
        if (!selected) { await fs.rm(directory, { recursive: true, force: true }); throw fail('TOOL_INSTALL_INVALID', 'Installed Node/npm could not execute. Check architecture, filesystem permissions and retry.'); }
        return finish(selected);
      } finally { await fs.rm(staging, { recursive: true, force: true }); }
    });
  } catch (error) {
    if (error.code?.startsWith('TOOL_')) throw error;
    throw fail('TOOL_INSTALL_FAILED', `Crew could not prepare managed Node/npm (${error.code || error.name}). Check network access and write permission for ${cacheRoot}, then retry.`);
  }
}

export async function validateManagedToolchain(snapshot, { env = process.env } = {}) {
  if (!snapshot?.nodeVersion) return resolveManagedToolchain({ requirements: {}, cacheRoot: snapshot?.cacheRoot, env, install: false });
  return resolveManagedToolchain({ requirements: { node: [snapshot.nodeVersion], npm: [snapshot.npmVersion] }, cacheRoot: snapshot.cacheRoot, env, install: false });
}
