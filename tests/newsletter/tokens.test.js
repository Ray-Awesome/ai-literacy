import test from 'node:test';
import assert from 'node:assert/strict';
import { newConfirmationToken, sha256, signActionToken, verifyActionToken } from '../../lib/newsletter/tokens.js';

test('confirmation token stores only a matching hash', async () => {
  const token = await newConfirmationToken();
  assert.equal(token.raw.length >= 32, true);
  assert.equal(token.hash, await sha256(token.raw));
  assert.notEqual(token.raw, token.hash);
});

test('signed action token rejects tampering, wrong purpose, and expiry', async () => {
  const secret = 'test-secret-at-least-32-characters';
  const signed = await signActionToken({ sid: 9, purpose: 'unsubscribe', exp: 2000 }, secret);
  assert.equal((await verifyActionToken(signed, 'unsubscribe', secret, 1000)).sid, 9);
  assert.equal(await verifyActionToken(signed + 'x', 'unsubscribe', secret, 1000), null);
  assert.equal(await verifyActionToken(signed, 'confirm', secret, 1000), null);
  assert.equal(await verifyActionToken(signed, 'unsubscribe', secret, 2001), null);
});
