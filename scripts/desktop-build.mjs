import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertReleaseVersion, assertSigningEnvironment, artifactNames } from './release-policy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.some(value => !['--release'].includes(value))) throw new Error('Use desktop-build.mjs [--release]. Default builds an unsigned candidate with no update feed.');
const signed = args.includes('--release');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (signed) { assertReleaseVersion(version, process.env.RELEASE_TAG); assertSigningEnvironment(process.env); }
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Build on an Apple Silicon macOS runner.');
const output = path.join(root, 'dist/desktop', signed ? 'release' : 'candidate', version);
// Each mode/version owns its output. Never mix an unsigned artifact into a feed.
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(path.join(tmpdir(), 'crew-release-build-'));
function run(executable, argv, env = process.env) {
  const result = spawnSync(executable, argv, { cwd: root, stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Build command failed (${result.status ?? 'signal'}). Nothing was published.`);
}
try {
  const rendererEnv = { ...process.env };
  for (const name of Object.keys(rendererEnv)) if (/^(CSC_|APPLE_)/.test(name) || ['GH_TOKEN', 'GITHUB_TOKEN'].includes(name)) delete rendererEnv[name];
  run(process.execPath, [path.join(root, 'scripts/build.mjs')], rendererEnv);
  const env = { ...process.env };
  // This command NEVER publishes; a separate least-privilege job owns that step.
  delete env.GH_TOKEN; delete env.GITHUB_TOKEN;
  const overrides = { extends: path.join(root, 'electron-builder.yml'), directories: { output } };
  if (signed) {
    const key = path.join(scratch, 'notary-key.p8');
    const encoded = String(env.APPLE_API_KEY_BASE64);
    if (!/^[A-Za-z0-9+/=\r\n]+$/.test(encoded)) throw new Error('APPLE_API_KEY_BASE64 is not valid base64.');
    const contents = Buffer.from(encoded, 'base64');
    if (!contents.toString().includes('BEGIN PRIVATE KEY')) throw new Error('APPLE_API_KEY_BASE64 must contain an App Store Connect API private key.');
    await writeFile(key, contents, { mode: 0o600 });
    env.APPLE_API_KEY = key; delete env.APPLE_API_KEY_BASE64;
    env.CSC_IDENTITY_AUTO_DISCOVERY = 'true';
  } else {
    overrides.publish = null;
    overrides.forceCodeSigning = false;
    overrides.mac = { identity: null, hardenedRuntime: false, notarize: false };
    overrides.dmg = { sign: false };
    for (const name of Object.keys(env)) if (/^(CSC_|APPLE_)/.test(name)) delete env[name];
    env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  }
  const config = path.join(scratch, 'builder.json');
  await writeFile(config, JSON.stringify(overrides), { mode: 0o600 });
  run(process.execPath, [path.join(root, 'node_modules/electron-builder/out/cli/cli.js'), '--config', config, '--mac', '--arm64', '--publish', 'never'], env);
  const manifest = [];
  for (const name of artifactNames(version, signed).filter(name => name !== 'SHA256SUMS.txt')) {
    const bytes = await readFile(path.join(output, name));
    manifest.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
  }
  await writeFile(path.join(output, 'SHA256SUMS.txt'), `${manifest.join('\n')}\n`);
  if (signed) run(process.execPath, [path.join(root, 'scripts/verify-release.mjs'), output], process.env);
  console.log(`Built ${signed ? 'signed and notarized release' : 'unsigned candidate (no update feed)'}: ${output}. Nothing was published.`);
} finally { await rm(scratch, { recursive: true, force: true }); }
