import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRendererAssets } from '../runtime/renderer-assets.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'crew-renderer-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const build = path.join(root, 'renderer-dist');
  await mkdir(path.join(build, 'assets'), { recursive:true });
  await writeFile(path.join(build, 'index.html'), '<h1>Manager</h1>');
  await writeFile(path.join(build, 'setup.html'), '<h1>Private setup</h1>');
  await writeFile(path.join(root, 'project.json'), 'private configuration');
  return { root, build, assets:path.join(build, 'assets') };
}

test('compiled index and discovered hashed assets have correct binary/text MIME', async t => {
  const { build, assets } = await fixture(t);
  await writeFile(path.join(assets, 'manager-aB12.js'), 'export const manager = true;');
  await writeFile(path.join(assets, 'manager-bC23.css'), 'body{color:blue}');
  await writeFile(path.join(assets, 'crew-cD34.png'), Buffer.from([137,80,78,71,0,255]));
  const renderer = await createRendererAssets(build);
  assert.equal((await renderer.read('/')).body.toString(), '<h1>Manager</h1>');
  assert.equal((await renderer.read('/assets/manager-aB12.js')).type, 'text/javascript; charset=utf-8');
  assert.equal((await renderer.read('/assets/manager-bC23.css')).type, 'text/css; charset=utf-8');
  const png = await renderer.read('/assets/crew-cD34.png');
  assert.equal(png.type, 'image/png');
  assert.deepEqual(png.body, Buffer.from([137,80,78,71,0,255]));
});

test('setup, private files, traversal, encoded aliases and undiscovered files stay unavailable', async t => {
  const { build, assets } = await fixture(t);
  await writeFile(path.join(assets, 'private.json'), 'private');
  const renderer = await createRendererAssets(build);
  await writeFile(path.join(assets, 'late.js'), 'late addition');
  for (const url of ['/setup.html', '/index.html', '/project.json', '/assets/private.json', '/assets/late.js', '/../project.json', '/assets/../../project.json', '/assets/%2e%2e/project.json', '/%73etup.html', '/assets\\private.json', '/?file=project.json']) {
    assert.equal(await renderer.read(url), null, url);
  }
});

test('symlink files/directories cannot expose project configuration or external scripts', async t => {
  const { root, build, assets } = await fixture(t);
  await symlink(path.join(root, 'project.json'), path.join(assets, 'leak.js'));
  await mkdir(path.join(root, 'outside'));
  await writeFile(path.join(root, 'outside', 'secret.js'), 'private');
  await symlink(path.join(root, 'outside'), path.join(assets, 'outside'));
  const renderer = await createRendererAssets(build);
  assert.equal(await renderer.read('/assets/leak.js'), null);
  assert.equal(await renderer.read('/assets/outside/secret.js'), null);
});

test('replacing an allowlisted file or its parent after startup cannot escape the build', async t => {
  const { root, build, assets } = await fixture(t);
  await writeFile(path.join(assets, 'manager-a.js'), 'manager');
  const renderer = await createRendererAssets(build);
  await rename(assets, path.join(build, 'old-assets'));
  await mkdir(path.join(root, 'outside'));
  await writeFile(path.join(root, 'outside', 'manager-a.js'), 'private configuration');
  await symlink(path.join(root, 'outside'), assets);
  await assert.rejects(renderer.read('/assets/manager-a.js'), /changed or became unavailable/);
});

test('missing build or linked index fails with the build command before serving', async t => {
  const { root, build } = await fixture(t);
  await assert.rejects(createRendererAssets(path.join(root, 'missing')), /npm run renderer:build/);
  await rm(path.join(build, 'index.html'));
  await symlink(path.join(root, 'project.json'), path.join(build, 'index.html'));
  await assert.rejects(createRendererAssets(build), /npm run renderer:build/);
});
