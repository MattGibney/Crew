import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';
import { openUnifiedRegistry } from '../src/desktop/unified-registry.mts';
import { startDesktopRenderer } from '../src/desktop/unified-renderer.mts';
import { createAgentImages } from '../src/application/agent-images.mts';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'crew-desktop-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('project registration preserves identity and presentation origin without modifying source', async t => {
  const root = await fixture(t), source = join(root, 'source'), state = join(root, 'state');
  await mkdir(source);
  await writeFile(join(source, 'README.md'), 'Unchanged source\n');
  const registry = await openUnifiedRegistry(state);
  const project = await registry.create({ name: 'Project', directory: source });
  await registry.saveRendererPort(51001);
  await registry.selectVoice(project.id, 'catalogue-voice');
  await registry.rename(project.id, 'Renamed');
  const reopened = await openUnifiedRegistry(state);
  assert.deepEqual(reopened.snapshot(), registry.snapshot());
  assert.equal(reopened.snapshot().selectedId, project.id);
  assert.deepEqual(await readdir(source), ['README.md']);
  assert.equal(await readFile(join(source, 'README.md'), 'utf8'), 'Unchanged source\n');
  await assert.rejects(reopened.saveRendererPort(51002), /retain/);
  await symlink(source, join(root, 'alias'));
  await assert.rejects(reopened.create({ name: 'Duplicate', directory: join(root, 'alias') }), /already registered/);
  await assert.rejects(reopened.create({ name: 'Unsafe overlap', directory: root }), /separate folders/);
});

test('a redirected registry cannot silently select another application state', async t => {
  const root = await fixture(t), actual = join(root, 'actual'), redirected = join(root, 'redirected');
  await mkdir(actual);
  await symlink(actual, redirected);
  await assert.rejects(openUnifiedRegistry(redirected), /private directory/);
  await writeFile(join(actual, 'projects.json'), '{malformed');
  await assert.rejects(openUnifiedRegistry(actual));
  assert.equal(await readFile(join(actual, 'projects.json'), 'utf8'), '{malformed');
});

test('desktop HTTP serves presentation only and rejects foreign origins and replaced assets', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), 'Legacy entry');
  await writeFile(join(root, 'agents.html'), '<title>Crew</title>');
  await writeFile(join(root, 'assets', 'app.js'), '/* renderer */');
  await writeFile(join(root, 'private.json'), '{"fixture":"private"}');
  const server = await startDesktopRenderer(root);
  try {
    const page = await fetch(server.origin);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(await page.text(), '<title>Crew</title>');
    assert.equal((await fetch(server.origin + '/assets/app.js')).status, 200);
    for (const path of ['/api/state', '/private.json', '/agents.html', '/assets/app.js?private.json']) {
      assert.equal((await fetch(server.origin + path)).status, 404);
    }
    assert.equal((await fetch(server.origin, { headers: { origin: 'https://foreign.invalid' } })).status, 403);
    assert.equal((await fetch(server.origin, { method: 'POST' })).status, 403);
    // Fetch owns its Host header, so use the HTTP client to send this exact value.
    const foreignHostStatus = await new Promise((resolve, reject) => {
      get(server.origin, { headers: { host: 'foreign.invalid' } }, response => {
        response.resume();
        resolve(response.statusCode);
      }).on('error', reject);
    });
    assert.equal(foreignHostStatus, 403);
    await rename(join(root, 'agents.html'), join(root, 'old.html'));
    await writeFile(join(root, 'agents.html'), 'Substituted entry');
    assert.equal((await fetch(server.origin)).status, 503);
    await rename(join(root, 'assets', 'app.js'), join(root, 'old.js'));
    await symlink(join(root, 'private.json'), join(root, 'assets', 'app.js'));
    const substituted = await fetch(server.origin + '/assets/app.js');
    assert.equal(substituted.status, 503);
    assert.doesNotMatch(await substituted.text(), /fixture/);
  } finally { await server.close(); }
});

test('private profile images survive reload but cannot cross project identity or follow links', async t => {
  const root = await fixture(t), directory = join(root, 'images');
  const picture = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  const images = createAgentImages({ directory, projectId: 'a' });
  const { imageRef } = await images.save(picture);
  assert.deepEqual(await createAgentImages({ directory, projectId: 'a' }).read(imageRef), { picture });
  const other = createAgentImages({ directory, projectId: 'b' });
  assert.equal(await other.read(imageRef), null);
  await assert.rejects(other.save(picture), /unavailable/);
  assert.equal(await images.read('../outside'), null);
  await assert.rejects(images.save('data:image/svg+xml;base64,PHN2Zz4='));
  const file = (await readdir(directory)).find(name => name !== 'identity.json');
  await rename(join(directory, file), join(root, 'original.json'));
  await symlink(join(root, 'original.json'), join(directory, file));
  await assert.rejects(images.read(imageRef), /unavailable/);
});
