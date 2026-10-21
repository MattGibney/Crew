import test from 'node:test';
import assert from 'node:assert/strict';
import { assertReleaseVersion, assertSigningEnvironment, requiredSigningSecrets, artifactNames } from '../scripts/release-policy.mjs';

test('only the exact stable version tag can enter the production release path', () => {
  assert.doesNotThrow(() => assertReleaseVersion('0.9.0', 'v0.9.0'));
  for (const tag of ['main', 'v0.8.0', '0.9.0', 'v0.9.0\nother', 'v0.9.0;echo secret']) assert.throws(() => assertReleaseVersion('0.9.0', tag));
  assert.throws(() => assertReleaseVersion('0.9.0-beta.1', 'v0.9.0-beta.1'));
});

test('missing signing credentials fail with names only and cannot silently downgrade a release', () => {
  const secret = 'do-not-print-this-value';
  const env = Object.fromEntries(requiredSigningSecrets.map(name => [name, secret]));
  assert.doesNotThrow(() => assertSigningEnvironment(env));
  delete env.APPLE_API_KEY_ID;
  assert.throws(() => assertSigningEnvironment(env), error => error.message.includes('APPLE_API_KEY_ID') && !error.message.includes(secret));
  assert.throws(() => assertSigningEnvironment({}), /Unsigned candidates cannot be published/);
});

test('production update manifests are absent from unsigned candidate artifact sets', () => {
  assert.ok(artifactNames('0.9.0', true).includes('latest-mac.yml'));
  assert.ok(!artifactNames('0.9.0', false).includes('latest-mac.yml'));
  assert.ok(artifactNames('0.9.0', true).includes('Crew-0.9.0-arm64.zip'));
  assert.throws(() => artifactNames('../private', false));
});
