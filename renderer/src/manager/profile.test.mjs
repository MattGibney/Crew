import test from 'node:test';
import assert from 'node:assert/strict';
import { managerDisplayName, managerPicture, readProfilePicture, PROFILE_PICTURE_MAX_BYTES } from './profile.ts';

test('old projects and absent names retain Manager presentation', () => {
  for (const profile of [undefined, {}, { name: '' }, { name: '   ' }, { name: null }]) assert.equal(managerDisplayName(profile), 'Manager');
  assert.equal(managerDisplayName({ name: '  Alex  ' }), 'Alex');
});

test('renderer picture boundary permits only bounded embedded raster data', () => {
  for (const picture of ['https://example.com/a.png', 'file:///private/picture.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,!!!!', 'data:image/png;base64,AAAA\n', `data:image/png;base64,${'A'.repeat(PROFILE_PICTURE_MAX_BYTES * 2)}`]) assert.equal(managerPicture({ picture }), null);
  for (const type of ['png', 'jpeg', 'webp']) {
    const picture = `data:image/${type};base64,AAAA`;
    assert.equal(managerPicture({ picture }), picture);
  }
  assert.equal(managerPicture({ picture: null }), null);
});

test('local image selection rejects unsupported and oversized input before reading', async () => {
  await assert.rejects(readProfilePicture({ type: 'image/svg+xml', size: 1 }), /PNG, JPEG or WebP/);
  await assert.rejects(readProfilePicture({ type: 'image/png', size: PROFILE_PICTURE_MAX_BYTES + 1 }), /512 KB/);
  await assert.rejects(readProfilePicture({ type: 'image/png', size: 0 }), /512 KB/);
});

test('valid local image is decoded and closed; malformed and extreme dimensions fail', async t => {
  const previousReader = globalThis.FileReader, previousBitmap = globalThis.createImageBitmap;
  t.after(() => { globalThis.FileReader = previousReader; globalThis.createImageBitmap = previousBitmap; });
  globalThis.FileReader = class { readAsDataURL() { this.result = 'data:image/png;base64,AAAA'; this.onload(); } };
  let closed = 0;
  globalThis.createImageBitmap = async () => ({ width: 2048, height: 2048, close() { closed++; } });
  assert.equal(await readProfilePicture({ type: 'image/png', size: 3 }), 'data:image/png;base64,AAAA');
  assert.equal(closed, 1);
  globalThis.createImageBitmap = async () => ({ width: 2049, height: 1, close() { closed++; } });
  await assert.rejects(readProfilePicture({ type: 'image/png', size: 3 }), /2048/);
  assert.equal(closed, 2);
  globalThis.createImageBitmap = async () => { throw new Error('bad image'); };
  await assert.rejects(readProfilePicture({ type: 'image/png', size: 3 }), /could not be opened/);
});
