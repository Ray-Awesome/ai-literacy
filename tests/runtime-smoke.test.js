import test from 'node:test';
import assert from 'node:assert/strict';
import { publicUser } from '../lib/auth.js';

test('publicUser never exposes password or guardian details', () => {
  const result = publicUser({
    id: 7,
    email: 'reader@example.com',
    is_minor: 0,
    is_admin: 1,
    created_at: '2026-09-16 00:00:00',
    password_hash: 'secret',
    guardian_contact: 'hidden',
  });

  assert.deepEqual(result, {
    id: 7,
    email: 'reader@example.com',
    isMinor: false,
    isAdmin: true,
    createdAt: '2026-09-16 00:00:00',
  });
  assert.equal('password_hash' in result, false);
  assert.equal('guardian_contact' in result, false);
});
