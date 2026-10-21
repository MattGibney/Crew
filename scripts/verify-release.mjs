import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactNames } from './release-policy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const output = path.resolve(process.argv[2] || path.join(root, 'dist/desktop/release', version));
const names = artifactNames(version, true);
const existing = await readdir(output);
for (const name of names) if (!existing.includes(name)) throw new Error(`Release verification blocked: missing ${name}.`);
const manifest = await readFile(path.join(output, 'latest-mac.yml'), 'utf8');
const zip = `Crew-${version}-arm64.zip`;
const zipHash = createHash('sha512').update(await readFile(path.join(output, zip))).digest('base64');
if (!manifest.includes(`version: ${version}\n`) || !manifest.includes(zip) || !manifest.includes(zipHash)) throw new Error('Update manifest does not match the release version and ZIP SHA512.');
function command(name, args, { capture = false } = {}) {
  const result = spawnSync(name, args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`Release verification failed: ${name}. No release may be published.`);
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}
const app = path.join(output, 'mac-arm64/Crew.app');
command('codesign', ['--verify', '--deep', '--strict', app]);
const signature = command('codesign', ['--display', '--verbose=4', app], { capture: true });
if (!signature.includes('Authority=Developer ID Application:') || !signature.includes(`TeamIdentifier=${process.env.APPLE_TEAM_ID}`) || !signature.includes('runtime')) throw new Error('Release requires a hardened Developer ID Application signature from APPLE_TEAM_ID.');
command('xcrun', ['stapler', 'validate', app]);
command('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
command('hdiutil', ['verify', path.join(output, `Crew-${version}-arm64.dmg`)]);
console.log('Signed release verified: Developer ID, hardened runtime, notarization ticket, Gatekeeper, DMG and update ZIP metadata.');
