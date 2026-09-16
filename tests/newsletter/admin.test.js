import test from 'node:test';
import assert from 'node:assert/strict';
import { signToken } from '../../lib/auth.js';
import { requireAdmin } from '../../lib/newsletter/admin.js';

test('administrator guard rejects a fallback-signed cookie without SESSION_SECRET', async () => {
  const fallbackSecret = 'dev-insecure-secret-change-me';
  const token = await signToken({ uid: 7, exp: Date.now() + 60_000 }, fallbackSecret);
  const request = new Request('https://site.test/api/admin/newsletters', {
    headers: { Cookie: `ailit_session=${encodeURIComponent(token)}` },
  });
  const env = {
    DB: {
      prepare(sql) {
        assert.match(sql, /SELECT \* FROM users WHERE id = \?/);
        return {
          bind(id) {
            assert.equal(id, 7);
            return { first: async () => ({ id: 7, is_admin: 1 }) };
          },
        };
      },
    },
  };

  const result = await requireAdmin(request, env);
  assert.equal('response' in result, true);
  assert.equal(result.response.status, 503);
});
