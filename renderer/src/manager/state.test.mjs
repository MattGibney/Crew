import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseVoice, connectorVerificationURL } from './state.js';

test('saved voice is used only while advertised; unavailable and absent choices resolve to actual catalog default', () => {
  const catalog = { defaultVoice: 'cove', voices: [{ id: 'cove' }, { id: 'juniper' }] };
  assert.equal(chooseVoice(catalog, 'juniper'), 'juniper');
  assert.equal(chooseVoice(catalog, 'removed-voice'), 'cove');
  assert.equal(chooseVoice(catalog, null), 'cove');
});
test('connector verification accepts only credential-free HTTPS destinations', () => {
  assert.equal(connectorVerificationURL('https://example.com/verify?code=one'), 'https://example.com/verify?code=one');
  for (const value of ['javascript:alert(1)', 'data:text/html,test', 'file:///tmp/config', 'http://example.com', 'https://user:secret@example.com', '//example.com', undefined]) assert.equal(connectorVerificationURL(value), null);
});
