// Only build-time-discovered renderer files are eligible for loopback serving.
import { constants } from 'node:fs';
import { lstat, readdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';

const types = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.png', 'image/png'], ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.woff', 'font/woff'], ['.woff2', 'font/woff2'],
]);
const maximumSize = 20 * 1024 * 1024;
const missing = () => new Error('Compiled renderer is missing or invalid. Run npm run renderer:build before starting Crew.');

export async function createRendererAssets(directory) {
  const requestedRoot = path.resolve(directory);
  const directoryInfo = await lstat(requestedRoot).catch(() => null);
  if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()) throw missing();
  const root = await realpath(requestedRoot);
  const records = new Map();
  async function record(file, url, required = false) {
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink() || info.size > maximumSize || await realpath(file).catch(() => null) !== file) {
      if (required) throw missing();
      return;
    }
    const type = types.get(path.extname(file).toLowerCase());
    if (!type) return;
    if (records.size >= 512) throw new Error('Compiled renderer contains too many assets. Rebuild the renderer.');
    records.set(url, { file, type, dev: info.dev, ino: info.ino });
  }
  await record(path.join(root, 'index.html'), '/', true);
  async function walk(folder, url, depth = 0) {
    if (depth > 8) throw new Error('Compiled renderer asset nesting exceeds the supported limit.');
    const info = await lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(folder) !== folder) return;
    const entries = await readdir(folder, { withFileTypes: true });
    for (const entry of entries) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(entry.name) || entry.isSymbolicLink()) continue;
      const file = path.join(folder, entry.name), target = `${url}/${entry.name}`;
      if (entry.isDirectory()) await walk(file, target, depth + 1);
      else if (entry.isFile()) await record(file, target);
    }
  }
  const assets = path.join(root, 'assets');
  const assetInfo = await lstat(assets).catch(() => null);
  if (assetInfo?.isDirectory() && !assetInfo.isSymbolicLink()) await walk(assets, '/assets');
  return {
    async read(url) {
      // Deliberately no decoding or URL normalization: encoded paths and queries
      // cannot turn into filesystem paths, nor can setup.html become public.
      const item = records.get(url);
      if (!item) return null;
      let handle;
      try {
        handle = await open(item.file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const info = await handle.stat();
        // Pin the file identity from discovery, including after parent-directory
        // replacement. A substituted link/file must never expose local config.
        if (!info.isFile() || info.dev !== item.dev || info.ino !== item.ino || info.size > maximumSize) throw new Error('changed');
        const body = await handle.readFile();
        if (body.length > maximumSize) throw new Error('changed');
        return { type: item.type, body };
      } catch { throw new Error('A compiled renderer asset changed or became unavailable. Rebuild and restart Crew.'); }
      finally { await handle?.close(); }
    },
  };
}
