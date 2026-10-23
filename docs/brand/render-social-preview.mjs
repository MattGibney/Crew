// Export the editable SVG without duplicating or redrawing the approved mark.
// Requires librsvg's rsvg-convert; no application dependencies are installed.
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const source = new URL('./social-preview.svg', import.meta.url);
const mark = await readFile(new URL('../../build/crew-mark.png', import.meta.url));
const svg = (await readFile(source, 'utf8')).replace(
  '../../build/crew-mark.png',
  `data:image/png;base64,${mark.toString('base64')}`,
);
const output = fileURLToPath(new URL('./social-preview.png', import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), 'crew-social-preview-'));
try {
  const { writeFile } = await import('node:fs/promises');
  const input = path.join(temporary, 'preview.svg');
  await writeFile(input, svg);
  execFileSync('rsvg-convert', [input, '-o', output], { stdio: 'inherit' });
  console.log(output);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
