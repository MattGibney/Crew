import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('This release command builds the tested Apple Silicon macOS artifact. Run on an arm64 Mac.');
}
const renderer = spawnSync(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: root, stdio: 'inherit' });
if (renderer.error) throw renderer.error;
if (renderer.status !== 0) process.exit(renderer.status ?? 1);
const result = spawnSync(process.execPath, [
  path.join(root, 'node_modules/electron-builder/out/cli/cli.js'),
  '--config', 'electron-builder.yml', '--mac', '--arm64', '--publish', 'never',
], {
  cwd: root, stdio: 'inherit',
  env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const output = path.join(root, 'dist/desktop');
const artifacts = (await readdir(output)).filter(name => /\.(dmg|zip)$/.test(name)).sort();
const manifest = [];
for (const name of artifacts) {
  manifest.push(`${createHash('sha256').update(await readFile(path.join(output, name))).digest('hex')}  ${name}`);
}
await writeFile(path.join(output, 'SHA256SUMS.txt'), `${manifest.join('\n')}\n`);
console.log(`Built unsigned local macOS arm64 artifacts with SHA256SUMS.txt in ${output}`);
