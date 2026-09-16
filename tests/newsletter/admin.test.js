import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { signToken } from '../../lib/auth.js';
import { onRequestPost as createDraft } from '../../functions/api/admin/newsletters/index.js';
import { onRequestPut as updateDraft } from '../../functions/api/admin/newsletters/[id].js';
import { onRequestPost as sendTest } from '../../functions/api/admin/newsletters/[id]/test-send.js';
import { onRequestGet as listSubscribers } from '../../functions/api/admin/newsletter-subscribers.js';
import { onRequestGet as listSends } from '../../functions/api/admin/newsletter-sends.js';
import { requireAdmin } from '../../lib/newsletter/admin.js';

const SECRET = 'test-secret-at-least-32-characters';
const validBlocks = [{ id: 'body-1', type: 'paragraph', data: { text: '안녕하세요' } }];

function result(rows) { return { results: rows }; }

test('administrator guard rejects a fallback-signed cookie without SESSION_SECRET', async () => {
  const token = await signToken({ uid: 7, exp: Date.now() + 60_000 }, 'dev-insecure-secret-change-me');
  const request = new Request('https://site.test/api/admin/newsletters', {
    headers: { Cookie: `ailit_session=${encodeURIComponent(token)}` },
  });
  const env = { DB: { prepare() { throw new Error('guard must fail before querying'); } } };
  const result = await requireAdmin(request, env);
  assert.equal(result.response.status, 503);
});

async function makeAdminContext({
  isAdmin = true,
  body = {},
  params = {},
  newsletterStatus = 'draft',
  newsletter = null,
  subscribers = [],
  sends = [],
  deliveries = [],
  activeSubscriberCount = 0,
  path = '/api/admin/newsletters',
} = {}) {
  const queries = [];
  const writes = [];
  const user = { id: 7, email: 'admin@site.test', is_admin: isAdmin ? 1 : 0 };
  const storedNewsletter = newsletter || {
    id: 12, subject: '기존 제목', preview_text: '기존 미리보기', content_json: JSON.stringify(validBlocks),
    status: newsletterStatus, created_by: 7, created_at: '2026-09-16 00:00:00', updated_at: '2026-09-16 00:00:00', sent_at: null,
  };
  const DB = {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              queries.push({ sql, params, method: 'first' });
              if (sql.includes('SELECT * FROM users')) return user;
              if (sql.includes('COUNT(*) AS active_count') && sql.includes("status = 'active'")) return { active_count: activeSubscriberCount };
              if (sql.includes('FROM newsletters') && sql.includes('WHERE id = ?')) return storedNewsletter;
              if (sql.includes('INSERT INTO newsletters')) return { id: 22 };
              return null;
            },
            async all() {
              queries.push({ sql, params, method: 'all' });
              if (sql.includes('FROM newsletter_subscribers')) return result(subscribers);
              if (sql.includes('FROM newsletter_sends')) return result(sends);
              if (sql.includes('FROM newsletter_deliveries')) return result(deliveries);
              if (sql.includes('FROM newsletters')) return result([storedNewsletter]);
              return result([]);
            },
            async run() {
              queries.push({ sql, params, method: 'run' });
              writes.push({ sql, params });
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  const token = await signToken({ uid: user.id, exp: Date.now() + 60_000 }, SECRET);
  const request = new Request(`https://site.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `ailit_session=${encodeURIComponent(token)}` },
    body: JSON.stringify(body),
  });
  return { request, env: { DB, SESSION_SECRET: SECRET, NEWSLETTER_FROM: 'AILIT <newsletter@site.test>', RESEND_API_KEY: 're_test_key' }, params, queries, writes };
}

test('non-admin cannot create a newsletter', async () => {
  const ctx = await makeAdminContext({ isAdmin: false, body: { subject: '제목', previewText: '미리보기', blocks: validBlocks } });
  assert.equal((await createDraft(ctx)).status, 403);
  assert.equal(ctx.queries.filter(({ sql }) => sql.includes('INSERT INTO newsletters')).length, 0);
});

test('sent or sending newsletter is immutable', async () => {
  const ctx = await makeAdminContext({ params: { id: '12' }, newsletterStatus: 'sending', body: { subject: '변경', previewText: '미리보기', blocks: validBlocks } });
  assert.equal((await updateDraft(ctx)).status, 409);
  assert.equal(ctx.writes.length, 0);
});

test('draft creation validates the complete block document before storing it', async () => {
  const ctx = await makeAdminContext({ body: {
    subject: '제목', previewText: '미리보기',
    blocks: [{ id: 'bad-image', type: 'image', data: { url: 'http://cdn.example.com/a.jpg', alt: '표지', width: 640 } }],
  } });
  const response = await createDraft(ctx);
  assert.equal(response.status, 400);
  assert.equal(ctx.writes.length, 0);
});

test('test send delivers one escaped test message without creating bulk-send rows', async () => {
  const ctx = await makeAdminContext({
    path: '/api/admin/newsletters/12/test-send', params: { id: '12' },
    newsletter: {
      id: 12, subject: '<새 소식>', preview_text: '미리보기',
      content_json: JSON.stringify([{ id: 'copy', type: 'paragraph', data: { text: '<b>안전한 본문</b>' } }]),
      status: 'draft', created_by: 7, created_at: '2026-09-16', updated_at: '2026-09-16', sent_at: null,
    },
    body: { email: 'reader@example.com' },
  });
  const originalFetch = globalThis.fetch;
  let message;
  globalThis.fetch = async (_url, init) => {
    message = JSON.parse(init.body);
    return new Response(JSON.stringify({ id: 'test-message' }), { status: 200 });
  };
  try {
    assert.equal((await sendTest(ctx)).status, 202);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(message.to, 'reader@example.com');
  assert.equal(message.subject, '[테스트] <새 소식>');
  assert.match(message.html, /테스트 발송/);
  assert.match(message.html, /&lt;b&gt;안전한 본문&lt;\/b&gt;/);
  assert.equal(ctx.writes.some(({ sql }) => /newsletter_(sends|deliveries)/.test(sql)), false);
});

test('test send accepts exactly one destination field', async () => {
  const ctx = await makeAdminContext({
    path: '/api/admin/newsletters/12/test-send', params: { id: '12' },
    body: { email: 'reader@example.com', recipients: ['second@example.com'] },
  });
  assert.equal((await sendTest(ctx)).status, 400);
});

test('subscriber and send listings validate pagination and do not expose secret columns', async () => {
  const subscriberCtx = await makeAdminContext({
    path: '/api/admin/newsletter-subscribers?limit=101',
    subscribers: [{ id: 1, email: 'reader@example.com', status: 'active', confirmation_token_hash: 'never-return', action_token: 'never-return' }],
  });
  assert.equal((await listSubscribers(subscriberCtx)).status, 400);

  const validSubscriberCtx = await makeAdminContext({
    path: '/api/admin/newsletter-subscribers?limit=10&offset=0',
    subscribers: [{ id: 1, email: 'reader@example.com', status: 'active', confirmation_token_hash: 'never-return' }],
  });
  const listed = await listSubscribers(validSubscriberCtx);
  assert.equal(listed.status, 200);
  assert.equal(JSON.stringify(await listed.json()).includes('never-return'), false);

  const sendsCtx = await makeAdminContext({ path: '/api/admin/newsletter-sends?offset=-1' });
  assert.equal((await listSends(sendsCtx)).status, 400);

  const invalidDeliveryCtx = await makeAdminContext({ path: '/api/admin/newsletter-sends?sendId=not-an-id' });
  assert.equal((await listSends(invalidDeliveryCtx)).status, 400);
});

test('send listing distinguishes retryable known failures from indeterminate delivery outcomes', async () => {
  const ctx = await makeAdminContext({
    path: '/api/admin/newsletter-sends?limit=10&offset=0',
    sends: [{
      id: 41, newsletter_id: 12, subject: '발송', status: 'partial', target_count: 3, success_count: 1, failure_count: 2,
      retryable_failure_count: 1, indeterminate_count: 1, started_at: '2026-09-16', completed_at: '2026-09-16',
    }],
  });
  const response = await listSends(ctx);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.sends[0].retryableFailureCount, 1);
  assert.deepEqual(body.sends[0].indeterminateCount, 1);
  const query = ctx.queries.find(({ sql }) => sql.includes('FROM newsletter_sends'))?.sql || '';
  assert.match(query, /delivery_certainty/);
  assert.match(query, /retryable_failure_count/);
  assert.doesNotMatch(query, /request_body|provider_key|provider_result/);
});

test('subscriber summary returns the current active recipient count for send confirmation', async () => {
  const ctx = await makeAdminContext({ path: '/api/admin/newsletter-subscribers?summary=active', activeSubscriberCount: 37 });
  const response = await listSubscribers(ctx);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { activeCount: 37 });
});

test('admin page keeps member and answer panels while loading the accessible editorial room', async () => {
  const [html, script, sendStatus] = await Promise.all([
    readFile(new URL('../../admin.html', import.meta.url), 'utf8'),
    readFile(new URL('../../js/admin-editorial.js', import.meta.url), 'utf8'),
    readFile(new URL('../../js/admin-editorial-send-status.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /에이릿 편집실/);
  assert.match(html, /회원 목록/);
  assert.match(html, /답변 목록/);
  assert.match(html, /뉴스레터/);
  assert.match(html, /구독자/);
  assert.match(html, /발송 기록/);
  assert.match(html, /js\/admin-editorial\.js/);
  assert.match(script, /aria-label/);
  assert.match(script, /desktop/);
  assert.match(script, /mobile/);
  assert.match(script, /800/);
  assert.match(script, /function setDirty\(render\)/);
  assert.doesNotMatch(script, /contenteditable/);
  assert.doesNotMatch(html, /role="tab/);
  assert.match(script, /aria-pressed/);
  assert.match(script, /function refreshDerived\(/);
  assert.match(script, /function paginationControls\(/);
  assert.match(script, /function loadDeliveries\(/);
  assert.match(script, /requestNavigation/);
  assert.match(script, /newsletter-subscribers\?summary=active/);
  assert.match(script, /\/api\/admin\/newsletters\/.*\/send/);
  assert.match(script, /\/api\/admin\/newsletters\/.*\/retry/);
  assert.match(script, /sendOutcome/);
  assert.match(sendStatus, /retryableFailureCount/);
  assert.match(sendStatus, /indeterminateCount/);
  assert.match(script, /제공업체 확인/);
  assert.match(script, /알려진 실패 수신자 재시도/);
  assert.match(script, /Idempotency-Key/);
  assert.match(script, /function loadNewsletters\(offset\)/);
  assert.match(script, /bindInitialPageLoader\(tabs\.newsletters, loadNewsletters\)/);
  assert.match(script, /createSendConfirmationController/);
});
