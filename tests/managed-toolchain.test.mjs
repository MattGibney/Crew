import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { discoverToolRequirements, resolveManagedToolchain, validateManagedToolchain, satisfiesToolVersion, SYSTEM_TOOL_PATH } from '../runtime/toolchains/managed.mjs';
const run = promisify(execFile);

const source = (path, content) => ({ path, content });
test('discovers existing Node/npm instructions and intersects all sources', () => {
  const result = discoverToolRequirements({ sources: [source('AGENTS.md', 'Use Node 22 and npm 11.11.'), source('package.json', JSON.stringify({ engines: { node: '>=22 <23' }, packageManager: 'npm@11.11.0' })), source('.node-version', '22.20.0'), source('.tool-versions', 'nodejs 22.20.0\n'), source('.claude/skills/tools/SKILL.md', 'Requires Node v22+ and npm 11.11')] });
  assert.deepEqual(result.node, ['22', '>=22 <23', '22.20.0', '>=22']);
  assert.deepEqual(result.npm, ['11.11', '11.11.0']);
  assert.equal(result.sources.length, 8);
  assert.equal(satisfiesToolVersion('22.20.0', '>=22 <23'), true);
  assert.equal(satisfiesToolVersion('24.0.0', '22'), false);
  assert.equal(satisfiesToolVersion('22.20.0', '^20.17.0 || >=22.9.0'), true);
  assert.throws(() => discoverToolRequirements({ sources: [source('.nvmrc', 'lts/*')] }), { code: 'TOOL_REQUIREMENT_UNSUPPORTED' });
  assert.throws(() => satisfiesToolVersion('22.0.0', '24 unsupported'), { code: 'TOOL_REQUIREMENT_UNSUPPORTED' });
  assert.throws(() => satisfiesToolVersion('22.0.0', '22 || unsupported'), { code: 'TOOL_REQUIREMENT_UNSUPPORTED' });
  assert.throws(() => discoverToolRequirements({ sources: [source('package.json', JSON.stringify({ packageManager: 'pnpm@10.0.0' }))] }), { code: 'TOOL_REQUIREMENT_UNSUPPORTED' });
});
test('non-Node projects retain inherited environment alongside system launch defaults', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'crew-system-tool-test-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const result = await resolveManagedToolchain({ cacheRoot: temporary, env: { PATH: '/personal/nvm', NODE_OPTIONS: '--require secret', OTHER: 'kept' } });
  assert.equal(result.PATH, SYSTEM_TOOL_PATH);
  assert.equal(result.nodeVersion, null);
  assert.equal(result.env.OTHER, 'kept');
  assert.equal(result.env.NODE_OPTIONS, '--require secret');
  assert.equal(result.env.PATH.endsWith('/personal/nvm'), true);
  assert.equal(result.env.ZDOTDIR, undefined);
  await assert.rejects(resolveManagedToolchain({ requirements: { npm: ['11'] } }), { code: 'TOOL_REQUIREMENT_MISSING' });
});
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'crew-tool-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const nodeDir = path.join(root, 'node-v22.20.0-linux-x64');
  await fs.mkdir(path.join(nodeDir, 'bin'), { recursive: true });
  await fs.writeFile(path.join(nodeDir, 'bin', 'node'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo v22.20.0; else echo 11.11.0; fi\n', { mode: 0o755 });
  await run('/usr/bin/tar', ['-czf', path.join(root, 'node.tar.gz'), '-C', root, path.basename(nodeDir)]);
  const npmDir = path.join(root, 'package', 'bin'); await fs.mkdir(npmDir, { recursive: true });
  for (const name of ['npm-cli.js', 'npx-cli.js']) await fs.writeFile(path.join(npmDir, name), '#!/usr/bin/env node\n', { mode: 0o755 });
  await run('/usr/bin/tar', ['-czf', path.join(root, 'npm.tar.gz'), '-C', root, 'package']);
  const node = await fs.readFile(path.join(root, 'node.tar.gz')); const npm = await fs.readFile(path.join(root, 'npm.tar.gz'));
  const integrity = `sha512-${crypto.createHash('sha512').update(npm).digest('base64')}`;
  const metadata = { versions: { '11.11.0': { version: '11.11.0', engines: { node: '^20.17.0 || >=22.9.0' }, dist: { tarball: 'https://registry.npmjs.org/npm/-/npm-11.11.0.tgz', integrity } } } };
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url.endsWith('/index.json')) return new Response(JSON.stringify([{ version: 'v22.20.0', npm: '11.11.0', files: ['linux-x64-tar'] }]));
    if (url === 'https://registry.npmjs.org/npm') return new Response(JSON.stringify(metadata));
    if (url.endsWith('SHASUMS256.txt')) return new Response(`${crypto.createHash('sha256').update(node).digest('hex')}  node-v22.20.0-linux-x64.tar.gz\n`);
    if (url.endsWith('.tar.gz')) return new Response(node);
    if (url.endsWith('.tgz')) return new Response(npm);
    return new Response('', { status: 404 });
  };
  return { root, calls, fetchImpl, options: { requirements: { node: ['22', '>=22 <23'], npm: ['11.11'] }, cacheRoot: path.join(root, 'cache with spaces'), env: { PATH: '/user/nvm', HOME: root }, fetchImpl, platform: 'linux', arch: 'x64' } };
}
test('verified atomic cache is shared across concurrent installs and exact resume', async t => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([resolveManagedToolchain(f.options), resolveManagedToolchain(f.options)]);
  assert.equal(first.directory, second.directory);
  assert.equal(first.nodeVersion, '22.20.0'); assert.equal(first.npmVersion, '11.11.0');
  assert.equal(f.calls.filter(u => u.endsWith('/index.json')).length, 1);
  assert.equal(first.PATH.startsWith(`${first.directory}/bin:`), true);
  assert.equal(first.PATH.includes('/user/nvm'), false);
  assert.equal((await run(first.nodePath, ['--version'], { env: first.env })).stdout.trim(), 'v22.20.0');
  const retained = await resolveManagedToolchain({ ...f.options, install: false, fetchImpl: () => { throw new Error('must not download'); } });
  assert.equal(retained.directory, first.directory);
  const manifest = JSON.parse(await fs.readFile(path.join(first.directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.nodeSha256.length, 64);
  assert.equal((await fs.readdir(f.options.cacheRoot)).some(n => n.startsWith('.staging')), false);
});
test('conflicting versions and missing cached runtime fail without replay or state deletion', async t => {
  const f = await fixture(t);
  await assert.rejects(resolveManagedToolchain({ ...f.options, requirements: { node: ['22', '24'] } }), { code: 'TOOL_REQUIREMENT_CONFLICT' });
  await assert.rejects(resolveManagedToolchain({ ...f.options, install: false }), { code: 'TOOL_CACHE_MISSING' });
  const marker = path.join(f.root, 'retained-project-state'); await fs.writeFile(marker, 'partial database state');
  await assert.rejects(resolveManagedToolchain({ ...f.options, fetchImpl: async () => new Response('', { status: 503 }) }), { code: 'TOOL_DOWNLOAD_FAILED' });
  assert.equal(await fs.readFile(marker, 'utf8'), 'partial database state');
  assert.deepEqual(await fs.readdir(f.options.cacheRoot), []);
});
test('checksum failures never publish executables', async t => {
  const f = await fixture(t);
  await assert.rejects(resolveManagedToolchain({ ...f.options, fetchImpl: url => url.endsWith('SHASUMS256.txt') ? new Response(`${'0'.repeat(64)}  node-v22.20.0-linux-x64.tar.gz`) : f.fetchImpl(url) }), { code: 'TOOL_CHECKSUM_MISMATCH' });
  assert.deepEqual(await fs.readdir(f.options.cacheRoot), []);
});
test('npm integrity failure preserves an empty cache', async t => {
  const f = await fixture(t);
  await assert.rejects(resolveManagedToolchain({ ...f.options, fetchImpl: url => url.endsWith('.tgz') ? new Response('damaged archive') : f.fetchImpl(url) }), { code: 'TOOL_CHECKSUM_MISMATCH' });
  assert.deepEqual(await fs.readdir(f.options.cacheRoot), []);
});
test('damaged owned cache is repaired and retained without serving staging paths', async t => {
  const f = await fixture(t); const first = await resolveManagedToolchain(f.options);
  await fs.writeFile(first.nodePath, '#!/bin/sh\necho wrong\n', { mode: 0o755 });
  await assert.rejects(resolveManagedToolchain({ ...f.options, install: false }), { code: 'TOOL_CACHE_MISSING' });
  const repaired = await resolveManagedToolchain(f.options);
  assert.equal(repaired.directory, first.directory);
  assert.equal(repaired.directory.includes('.staging'), false);
  assert.equal((await fs.readdir(f.options.cacheRoot)).some(name => name.startsWith('.retained-invalid-')), true);
});
test('Node package without a declared version fails honestly', async () => {
  const requirements = discoverToolRequirements({ sources: [source('package.json', '{}')] });
  await assert.rejects(resolveManagedToolchain({ requirements }), { code: 'TOOL_REQUIREMENT_MISSING' });
});
test('login zsh respects explicit personal startup choices over managed defaults', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t); const resolved = await resolveManagedToolchain(f.options);
  const marker = path.join(f.root, 'personal-startup-ran');
  await fs.writeFile(path.join(f.root, '.zprofile'), `export PATH=/personal/nvm\n/usr/bin/touch '${marker}'\n`);
  const child = await run('/bin/zsh', ['-lc', 'printf "%s" "$PATH"'], { env: { ...resolved.env, ZDOTDIR: f.root } });
  assert.equal(child.stdout, '/personal/nvm');
  await fs.access(marker);
  assert.equal(resolved.env.ZDOTDIR, undefined);
  assert.equal(resolved.shellDirectory, undefined);
});

test('non-installing preflight never creates shell/cache state', async t => {
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'crew-preflight-readonly-'));t.after(()=>fs.rm(temporary,{recursive:true,force:true}));const cacheRoot=path.join(temporary,'missing');
 const result=await resolveManagedToolchain({cacheRoot,requirements:{},install:false});assert.equal(result.nodeVersion,null);assert.equal(result.shellDirectory,undefined);
 await assert.rejects(fs.stat(cacheRoot),{code:'ENOENT'});
});
