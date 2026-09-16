# AILIT Newsletter Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add double-opt-in newsletter subscription, privacy notice, unsubscribe, block-based authoring, and reliable Resend delivery to the existing AILIT site.

**Architecture:** Keep the existing static AILIT site on Cloudflare Pages, add Pages Functions backed by the existing D1 database, and enqueue bulk sends to a dedicated Cloudflare Queue consumer Worker. Resend handles email delivery; D1 remains the source of truth for consent, content, send jobs, and per-recipient outcomes.

**Tech Stack:** Static HTML/CSS/vanilla JavaScript, Cloudflare Pages Functions, Cloudflare Workers, D1, Queues, Web Crypto, Resend HTTP API, Node.js built-in test runner, Wrangler 4.104.0.

**Spec:** `docs/superpowers/specs/2026-09-16-ailit-newsletter-service-design.md`

## Global Constraints

- Collect only the subscriber's email address.
- Require double opt-in; confirmation links expire after 24 hours.
- Send only to subscribers whose status is `active`.
- Do not add open tracking or click tracking.
- Keep newsletter management inside the existing administrator page, renamed `에이릿 편집실`.
- Support only `heading`, `paragraph`, `image`, `button`, and `divider` content blocks.
- Lock newsletter content once a send starts.
- Render both HTML and plain-text email bodies.
- Add visible unsubscribe copy plus `List-Unsubscribe` and `List-Unsubscribe-Post` headers.
- Never expose `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `SESSION_SECRET`, or raw confirmation tokens to browser code or logs.
- Preserve all current public URLs and existing member/answer behavior.

---

## File Map

### Runtime and configuration

- `package.json` — pinned scripts and Wrangler dependency.
- `package-lock.json` — reproducible dependency lock.
- `wrangler.toml` — Pages output, D1 binding, Queue producer binding, non-secret variables.
- `worker/wrangler.toml` — Queue consumer Worker configuration.
- `scripts/build-static.mjs` — copies only public website assets into `dist/`.
- `.gitignore` — excludes generated output, local D1 state, and local secrets.
- `.dev.vars.example` — documents required local secret names without values.

### Shared server modules

- `lib/auth.js` — existing password/session/current-user helpers.
- `lib/newsletter/config.js` — constants, status enums, URLs, and environment validation.
- `lib/newsletter/tokens.js` — opaque confirmation tokens and signed action tokens.
- `lib/newsletter/content.js` — block validation plus HTML/text rendering.
- `lib/newsletter/resend.js` — Resend fetch client and payload builders.
- `lib/newsletter/rate-limit.js` — D1-backed request throttling using hashed keys.
- `lib/newsletter/admin.js` — reusable administrator guard.

### Public and administrator APIs

- `functions/api/newsletter/subscribe.js` — create/restart pending subscription and send confirmation.
- `functions/api/newsletter/confirm.js` — consume a confirmation token.
- `functions/api/newsletter/resend-confirmation.js` — issue a replacement confirmation token.
- `functions/api/newsletter/unsubscribe.js` — signed-link and one-click unsubscribe.
- `functions/api/newsletter/webhook.js` — verified Resend bounce/complaint webhook.
- `functions/api/admin/newsletters/index.js` — list and create drafts.
- `functions/api/admin/newsletters/[id].js` — fetch and update one draft.
- `functions/api/admin/newsletters/[id]/test-send.js` — send one marked test email.
- `functions/api/admin/newsletters/[id]/send.js` — freeze recipients and enqueue batches.
- `functions/api/admin/newsletters/[id]/retry.js` — enqueue failed recipients only.
- `functions/api/admin/newsletter-subscribers.js` — list subscriber states.
- `functions/api/admin/newsletter-sends.js` — list send summaries and deliveries.

### Queue consumer

- `worker/src/newsletter-worker.js` — consumes one batch message, calls Resend, and updates D1.

### Browser UI

- `newsletter.html` — minimal subscription form.
- `newsletter-privacy.html` — newsletter-specific privacy collection notice.
- `newsletter-status.html` — confirmation, expiry, error, and unsubscribe result UI.
- `js/newsletter.js` — subscription form and public status interactions.
- `admin.html` — AILIT editorial-room shell and panels.
- `js/admin-editorial.js` — member/answer/newsletter/subscriber/send views and block editor.
- `css/style.css` — responsive public and editorial-room styles.
- `index.html` — adds the newsletter entry point without changing existing navigation URLs.

### Tests

- `tests/helpers/fake-d1.js` — deterministic D1 test double.
- `tests/helpers/fixtures.js` — requests, environments, users, subscribers, and newsletters.
- `tests/newsletter/tokens.test.js` — token expiry, purpose, tampering, and hashing.
- `tests/newsletter/content.test.js` — block validation and safe rendering.
- `tests/newsletter/subscription.test.js` — subscribe, confirm, repeat, expiry, and unsubscribe.
- `tests/newsletter/admin.test.js` — authorization, draft CRUD, lock, and validation.
- `tests/newsletter/send.test.js` — recipient snapshot, idempotency, batching, retry.
- `tests/newsletter/worker.test.js` — Resend batch processing and result updates.
- `tests/newsletter/webhook.test.js` — signature, replay window, bounce, complaint.
- `tests/static/newsletter-pages.test.js` — required copy, privacy link, forms, and assets.

---

### Task 1: Put the existing Cloudflare runtime under source control

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `wrangler.toml`
- Create: `schema.sql`
- Create: `.gitignore`
- Create: `.dev.vars.example`
- Create: `scripts/build-static.mjs`
- Create: `lib/auth.js`
- Create: `functions/api/signup.js`
- Create: `functions/api/login.js`
- Create: `functions/api/logout.js`
- Create: `functions/api/me.js`
- Create: `functions/api/answers.js`
- Create: `functions/api/admin/users.js`
- Create: `functions/api/admin/answers.js`
- Test: `tests/runtime-smoke.test.js`

**Interfaces:**
- Consumes: Existing browser calls to `/api/signup`, `/api/login`, `/api/logout`, `/api/me`, `/api/answers`, `/api/admin/users`, and `/api/admin/answers`.
- Produces: `currentUser(request, env)`, `json(data, status, headers)`, and a configured `env.DB` binding used by every later task.

- [ ] **Step 1: Write the failing runtime smoke test**

```js
// tests/runtime-smoke.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { publicUser } from '../lib/auth.js';

test('publicUser never exposes password or guardian details', () => {
  const result = publicUser({
    id: 7, email: 'reader@example.com', is_minor: 0, is_admin: 1,
    created_at: '2026-09-16 00:00:00', password_hash: 'secret', guardian_contact: 'hidden',
  });
  assert.deepEqual(result, {
    id: 7, email: 'reader@example.com', isMinor: false, isAdmin: true,
    createdAt: '2026-09-16 00:00:00',
  });
  assert.equal('password_hash' in result, false);
  assert.equal('guardian_contact' in result, false);
});
```

- [ ] **Step 2: Run the test and verify the repository is missing the runtime**

Run: `node --test tests/runtime-smoke.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/auth.js`.

- [ ] **Step 3: Add the runtime and build configuration**

Use the existing implementations from the approved working copy at the repository parent for `lib/auth.js`, `functions/api/**`, and the membership portion of `schema.sql`. Add this package definition:

```json
{
  "name": "ailit-cloudflare",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node scripts/build-static.mjs",
    "test": "node --test tests",
    "dev": "npm run build && wrangler pages dev dist",
    "deploy": "npm run build && wrangler pages deploy",
    "db:init:local": "wrangler d1 execute ailit-db --local --file=./schema.sql",
    "db:init:remote": "wrangler d1 execute ailit-db --remote --file=./schema.sql"
  },
  "devDependencies": { "wrangler": "4.104.0" }
}
```

Configure `wrangler.toml` with `pages_build_output_dir = "./dist"`, D1 database name `ailit-db`, database ID `814df798-02f0-46d0-be2f-773980be4076`, and `ADMIN_EMAIL = ""`. The build script must copy these public paths only: root `*.html`, `css/`, `js/`, `images/`, `elementary/`, `middle/`, `high/`, `teacher/`, and `thinking-tools/`.

- [ ] **Step 4: Install the pinned dependency and generate the lockfile**

Run: `npm install`

Expected: `package-lock.json` is created and `npm audit` reports no unresolved critical vulnerability.

- [ ] **Step 5: Run the baseline checks**

Run: `npm test && npm run build`

Expected: the smoke test passes; `dist/index.html`, `dist/admin.html`, `dist/css/style.css`, and `dist/js/auth.js` exist; `dist/package.json` does not exist.

- [ ] **Step 6: Commit the runtime baseline**

```bash
git add package.json package-lock.json wrangler.toml schema.sql .gitignore .dev.vars.example scripts lib functions tests/runtime-smoke.test.js
git commit -m "chore: track existing Cloudflare runtime"
```

---

### Task 2: Add newsletter schema and token primitives

**Files:**
- Modify: `schema.sql`
- Create: `lib/newsletter/config.js`
- Create: `lib/newsletter/tokens.js`
- Create: `lib/newsletter/rate-limit.js`
- Create: `lib/newsletter/admin.js`
- Create: `tests/newsletter/tokens.test.js`

**Interfaces:**
- Consumes: `env.DB`, `env.SESSION_SECRET`, and `currentUser(request, env)`.
- Produces: `newConfirmationToken() -> Promise<{raw:string, hash:string}>`, `signActionToken(payload, secret) -> Promise<string>`, `verifyActionToken(token, purpose, secret, now?) -> Promise<object|null>`, `consumeRateLimit(db, scope, key, limit, windowSeconds) -> Promise<boolean>`, and `requireAdmin(request, env) -> Promise<{user}|{response}>`.

- [ ] **Step 1: Write token behavior tests**

```js
// tests/newsletter/tokens.test.js
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
```

- [ ] **Step 2: Run the token tests and verify failure**

Run: `node --test tests/newsletter/tokens.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement schema and security primitives**

Append tables `newsletter_subscribers`, `newsletters`, `newsletter_sends`, `newsletter_deliveries`, and `newsletter_rate_limits` exactly as defined by the spec. Add these constraints:

```sql
UNIQUE(email)
CHECK(status IN ('pending','active','unsubscribed','bounced','complained'))
UNIQUE(send_id, subscriber_id)
UNIQUE(idempotency_key)
```

Use `crypto.getRandomValues(new Uint8Array(32))` for confirmation tokens, SHA-256 hex for stored hashes, and HMAC-SHA256 for action tokens. `verifyActionToken` must compare signatures in constant time and reject a token before returning its payload when `purpose` differs or `exp < now`.

- [ ] **Step 4: Run schema and token checks**

Run: `npm run db:init:local && node --test tests/newsletter/tokens.test.js`

Expected: D1 applies the full schema without error and both token tests pass.

- [ ] **Step 5: Commit the newsletter foundation**

```bash
git add schema.sql lib/newsletter tests/newsletter/tokens.test.js
git commit -m "feat: add newsletter data and token foundation"
```

---

### Task 3: Implement double opt-in and unsubscribe APIs

**Files:**
- Create: `lib/newsletter/resend.js`
- Create: `functions/api/newsletter/subscribe.js`
- Create: `functions/api/newsletter/confirm.js`
- Create: `functions/api/newsletter/resend-confirmation.js`
- Create: `functions/api/newsletter/unsubscribe.js`
- Create: `tests/helpers/fake-d1.js`
- Create: `tests/helpers/fixtures.js`
- Create: `tests/newsletter/subscription.test.js`

**Interfaces:**
- Consumes: token and rate-limit helpers from Task 2; `env.RESEND_API_KEY`, `env.NEWSLETTER_FROM`, `env.PUBLIC_SITE_URL`, and `env.SESSION_SECRET`.
- Produces: `sendEmail(env, message) -> Promise<{id:string}>` and public JSON/redirect endpoints for subscribe, confirm, resend confirmation, and unsubscribe.

- [ ] **Step 1: Write failing lifecycle tests**

```js
// tests/newsletter/subscription.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost as subscribe } from '../../functions/api/newsletter/subscribe.js';
import { onRequestGet as confirm } from '../../functions/api/newsletter/confirm.js';
import { makeEnv, jsonRequest } from '../helpers/fixtures.js';

test('subscribe requires consent and stores pending email only', async () => {
  const env = makeEnv();
  const denied = await subscribe({ request: jsonRequest('/api/newsletter/subscribe', { email: 'a@example.com', consent: false }), env });
  assert.equal(denied.status, 400);
  const accepted = await subscribe({ request: jsonRequest('/api/newsletter/subscribe', { email: ' A@Example.com ', consent: true }), env });
  assert.equal(accepted.status, 202);
  assert.equal(env.rows.subscribers[0].email, 'a@example.com');
  assert.equal(env.rows.subscribers[0].status, 'pending');
  assert.equal('raw_confirmation_token' in env.rows.subscribers[0], false);
});

test('confirmation is one-time and activates a pending subscriber', async () => {
  const env = makeEnv();
  const raw = await env.seedPending('a@example.com');
  const first = await confirm({ request: new Request(`https://site.test/api/newsletter/confirm?token=${raw}`), env });
  assert.equal(first.status, 302);
  assert.match(first.headers.get('Location'), /newsletter-status\.html\?state=confirmed/);
  assert.equal(env.rows.subscribers[0].status, 'active');
  const replay = await confirm({ request: new Request(`https://site.test/api/newsletter/confirm?token=${raw}`), env });
  assert.match(replay.headers.get('Location'), /state=invalid/);
});
```

- [ ] **Step 2: Run the lifecycle tests and verify failure**

Run: `node --test tests/newsletter/subscription.test.js`

Expected: FAIL because the public handlers and fixtures do not exist.

- [ ] **Step 3: Implement subscription handlers and Resend client**

Normalize emails with `trim().toLowerCase()`, require `consent === true`, and treat the honeypot field `company` as an accepted no-op. Hash the IP and email before rate-limit storage. Return the same 202 copy for new, pending, and active addresses: `확인할 수 있는 경우 구독 안내 메일을 보냈습니다.`

`subscribe.js` and `resend-confirmation.js` must set a fresh token hash and `confirmation_expires_at = datetime('now', '+24 hours')`. `confirm.js` must update only a `pending` row whose hash matches and expiry is in the future, clearing the token hash in the same statement. `unsubscribe.js` must accept both GET and RFC 8058 POST, be idempotent, and set `status='unsubscribed'` plus `unsubscribed_at`.

Use `fetch('https://api.resend.com/emails', ...)` in `sendEmail`; set `X-Entity-Ref-ID` from the operation idempotency key and throw a typed `ResendError(status, code, message)` for non-2xx responses.

- [ ] **Step 4: Run the lifecycle tests**

Run: `node --test tests/newsletter/subscription.test.js`

Expected: PASS for consent, normalization, pending storage, one-time confirmation, expiry, active duplicate, unsubscribe, and re-subscribe cases.

- [ ] **Step 5: Commit the public subscription flow**

```bash
git add lib/newsletter/resend.js functions/api/newsletter tests/helpers tests/newsletter/subscription.test.js
git commit -m "feat: add double opt-in newsletter subscription"
```

---

### Task 4: Render safe emails and build the minimal public UI

**Files:**
- Create: `lib/newsletter/content.js`
- Create: `newsletter.html`
- Create: `newsletter-privacy.html`
- Create: `newsletter-status.html`
- Create: `js/newsletter.js`
- Modify: `index.html`
- Modify: `css/style.css`
- Create: `tests/newsletter/content.test.js`
- Create: `tests/static/newsletter-pages.test.js`

**Interfaces:**
- Consumes: a block array `{id:string,type:'heading'|'paragraph'|'image'|'button'|'divider',data:object}[]` and subscriber-specific unsubscribe URL.
- Produces: `validateBlocks(blocks) -> {ok:true, blocks}|{ok:false, errors:string[]}` and `renderNewsletter({subject, previewText, blocks, unsubscribeUrl}) -> {html:string, text:string}`.

- [ ] **Step 1: Write failing renderer and page tests**

```js
// tests/newsletter/content.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderNewsletter, validateBlocks } from '../../lib/newsletter/content.js';

test('renderer escapes copy and rejects unsafe links', () => {
  const blocks = [
    { id: 'h1', type: 'heading', data: { text: '<script>alert(1)</script>' } },
    { id: 'b1', type: 'button', data: { label: '읽기', url: 'javascript:alert(1)' } },
  ];
  assert.equal(validateBlocks(blocks).ok, false);
  const safe = renderNewsletter({
    subject: '제목', previewText: '미리보기',
    blocks: [{ id: 'p1', type: 'paragraph', data: { text: '<b>본문</b>' } }],
    unsubscribeUrl: 'https://ailiteracy.or.kr/api/newsletter/unsubscribe?token=x',
  });
  assert.match(safe.html, /&lt;b&gt;본문&lt;\/b&gt;/);
  assert.match(safe.html, /구독 취소/);
  assert.match(safe.text, /구독 취소/);
});
```

```js
// tests/static/newsletter-pages.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('subscription page stays minimal and links the dedicated notice', async () => {
  const html = await readFile(new URL('../../newsletter.html', import.meta.url), 'utf8');
  assert.match(html, /이메일 주소/);
  assert.match(html, /newsletter-privacy\.html/);
  assert.match(html, /확인 링크/);
  assert.doesNotMatch(html, /한 가지 쟁점|한 가지 판단|한 가지 도구/);
});
```

- [ ] **Step 2: Run both tests and verify failure**

Run: `node --test tests/newsletter/content.test.js tests/static/newsletter-pages.test.js`

Expected: FAIL because the renderer and pages do not exist.

- [ ] **Step 3: Implement safe rendering and public pages**

Allow only `http:` and `https:` URLs, escape all copy, require HTTPS for images in production, and add width/alt text to image blocks. Render a table-based, inline-styled email no wider than 640px with a plain-text equivalent. Automatically add sender reason, site URL, and unsubscribe link.

Build `newsletter.html` with only the approved heading, one-sentence description, email input, consent checkbox, privacy link, confirmation note, hidden `company` field, and submit button. `newsletter-privacy.html` must state email-only collection, purpose, retention, right to refuse, and Resend processing. `newsletter-status.html` reads only a known `state` enum and never renders arbitrary query-string HTML.

- [ ] **Step 4: Run renderer, static, and build checks**

Run: `node --test tests/newsletter/content.test.js tests/static/newsletter-pages.test.js && npm run build`

Expected: all tests pass and the three newsletter pages plus `js/newsletter.js` exist in `dist/`.

- [ ] **Step 5: Commit the public experience**

```bash
git add lib/newsletter/content.js newsletter.html newsletter-privacy.html newsletter-status.html js/newsletter.js index.html css/style.css tests/newsletter/content.test.js tests/static/newsletter-pages.test.js
git commit -m "feat: add minimal newsletter subscription experience"
```

---

### Task 5: Add editorial-room draft management and block editor

**Files:**
- Create: `functions/api/admin/newsletters/index.js`
- Create: `functions/api/admin/newsletters/[id].js`
- Create: `functions/api/admin/newsletters/[id]/test-send.js`
- Create: `functions/api/admin/newsletter-subscribers.js`
- Create: `functions/api/admin/newsletter-sends.js`
- Modify: `admin.html`
- Create: `js/admin-editorial.js`
- Modify: `css/style.css`
- Create: `tests/newsletter/admin.test.js`

**Interfaces:**
- Consumes: `requireAdmin`, `validateBlocks`, `renderNewsletter`, existing member/answer APIs, and `sendEmail`.
- Produces: JSON draft CRUD, test sending, subscriber/send listings, and an AILIT editorial-room UI.

- [ ] **Step 1: Write failing authorization and draft tests**

```js
// tests/newsletter/admin.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost as createDraft } from '../../functions/api/admin/newsletters/index.js';
import { onRequestPut as updateDraft } from '../../functions/api/admin/newsletters/[id].js';
import { makeAdminContext } from '../helpers/fixtures.js';

test('non-admin cannot create a newsletter', async () => {
  const ctx = makeAdminContext({ isAdmin: false, body: { subject: '제목', blocks: [] } });
  assert.equal((await createDraft(ctx)).status, 403);
});

test('sent or sending newsletter is immutable', async () => {
  const ctx = makeAdminContext({ isAdmin: true, params: { id: '12' }, newsletterStatus: 'sending', body: { subject: '변경' } });
  assert.equal((await updateDraft(ctx)).status, 409);
});
```

- [ ] **Step 2: Run the admin tests and verify failure**

Run: `node --test tests/newsletter/admin.test.js`

Expected: FAIL because the admin handlers do not exist.

- [ ] **Step 3: Implement admin APIs**

Every handler must call `requireAdmin` first. Store `content_json` only after `validateBlocks` succeeds. Permit updates only while `status='draft'`. Test sends accept exactly one valid destination, prefix the subject with `[테스트]`, include a visible test banner, and never create a `newsletter_send` or `newsletter_delivery` row.

List subscribers without exposing confirmation hashes or action tokens. Paginate subscriber and delivery tables with `limit <= 100` and an integer `offset >= 0`.

- [ ] **Step 4: Implement the AILIT editorial-room UI**

Rename the page heading to `에이릿 편집실`. Keep existing 회원 and 답변 panels, and add 뉴스레터, 구독자, 발송 기록. In the editor, represent state as:

```js
{
  id: null,
  subject: '',
  previewText: '',
  blocks: [],
  status: 'draft',
  dirty: false
}
```

Support add, edit, move up/down, and delete for the five approved block types. Debounce autosave by 800ms; show `저장 중`, `저장됨`, or a retryable error. Use text fields/textareas rather than `contenteditable`, and render previews through escaped DOM text or the server renderer output.

Add desktop and mobile preview toggles that constrain the preview canvas to 640px and 375px. Disable test and full-send actions while an autosave is pending or the draft has validation errors.

- [ ] **Step 5: Run admin tests and build**

Run: `node --test tests/newsletter/admin.test.js && npm run build`

Expected: authorization and immutability tests pass, and the built admin page references `js/admin-editorial.js`.

- [ ] **Step 6: Commit the editorial room**

```bash
git add functions/api/admin admin.html js/admin-editorial.js css/style.css tests/newsletter/admin.test.js
git commit -m "feat: integrate newsletter CMS into AILIT editorial room"
```

---

### Task 6: Queue and deliver idempotent bulk sends

**Files:**
- Modify: `wrangler.toml`
- Create: `worker/wrangler.toml`
- Create: `worker/src/newsletter-worker.js`
- Create: `functions/api/admin/newsletters/[id]/send.js`
- Create: `functions/api/admin/newsletters/[id]/retry.js`
- Create: `tests/newsletter/send.test.js`
- Create: `tests/newsletter/worker.test.js`

**Interfaces:**
- Consumes: validated frozen newsletter content, active subscribers, `env.NEWSLETTER_QUEUE`, `env.DB`, and Resend Batch API.
- Produces: queue messages `{sendId:number, deliveryIds:number[]}`, send states `queued|sending|completed|partial|failed`, and delivery states `pending|sent|failed|bounced|complained`.

- [ ] **Step 1: Write failing send snapshot and idempotency tests**

```js
// tests/newsletter/send.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost as startSend } from '../../functions/api/admin/newsletters/[id]/send.js';
import { makeAdminContext } from '../helpers/fixtures.js';

test('send snapshots active recipients into batches of at most 100', async () => {
  const ctx = makeAdminContext({ isAdmin: true, params: { id: '4' }, activeSubscribers: 205, newsletterStatus: 'draft' });
  const response = await startSend(ctx);
  assert.equal(response.status, 202);
  assert.deepEqual(ctx.env.queueMessages.map((m) => m.deliveryIds.length), [100, 100, 5]);
  assert.equal(ctx.env.rows.newsletters[0].status, 'sending');
});

test('repeating the same idempotency key does not create deliveries twice', async () => {
  const ctx = makeAdminContext({ isAdmin: true, params: { id: '4' }, activeSubscribers: 3, newsletterStatus: 'draft', idempotencyKey: 'fixed-key' });
  await startSend(ctx);
  await startSend(ctx);
  assert.equal(ctx.env.rows.deliveries.length, 3);
});
```

- [ ] **Step 2: Run send tests and verify failure**

Run: `node --test tests/newsletter/send.test.js tests/newsletter/worker.test.js`

Expected: FAIL because producer and consumer handlers do not exist.

- [ ] **Step 3: Implement the atomic send producer**

Require an `Idempotency-Key` header. In one D1 batch, change the newsletter from `draft` to `sending`, insert the send row, snapshot all active subscribers into delivery rows, and reject the operation when the newsletter is not a valid draft. Query the newly created delivery IDs and enqueue arrays of no more than 100. Retry creates a new send job containing only failed deliveries from the selected prior send and excludes any subscriber who is no longer active.

If any queue enqueue call fails, mark that send `failed`, keep unqueued deliveries `pending`, and return a retryable 503 response. A repeated request with the same idempotency key must resume only pending, unqueued deliveries rather than duplicating rows.

- [ ] **Step 4: Implement the Queue consumer**

For each message, fetch the frozen newsletter and pending deliveries, generate a unique unsubscribe URL per subscriber, and call `POST https://api.resend.com/emails/batch` with no more than 100 messages. Add these headers to every message:

```js
headers: {
  'List-Unsubscribe': `<${unsubscribeUrl}>`,
  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
}
```

Map returned IDs by request order and update deliveries to `sent`. On a permanent 4xx payload problem, mark the affected batch `failed`; on 429 or 5xx, throw so Queues retries. Recompute send totals after every batch and set the final state to `completed`, `partial`, or `failed`.

- [ ] **Step 5: Configure producer, consumer, and dead-letter queue**

Add `NEWSLETTER_QUEUE` as a producer binding in root `wrangler.toml`. Configure `worker/wrangler.toml` with `main = "src/newsletter-worker.js"`, the same D1 database ID, queue `ailit-newsletter-send`, `max_batch_size = 1`, `max_retries = 3`, and dead-letter queue `ailit-newsletter-dead-letter`.

- [ ] **Step 6: Run send and worker tests**

Run: `node --test tests/newsletter/send.test.js tests/newsletter/worker.test.js`

Expected: batching, idempotency, active-only delivery, successful result mapping, transient retry, permanent failure, aggregate counts, and failed-only retry all pass.

- [ ] **Step 7: Commit reliable sending**

```bash
git add wrangler.toml worker functions/api/admin/newsletters tests/newsletter/send.test.js tests/newsletter/worker.test.js
git commit -m "feat: deliver newsletters through Cloudflare Queues"
```

---

### Task 7: Process verified Resend delivery events

**Files:**
- Create: `functions/api/newsletter/webhook.js`
- Create: `tests/newsletter/webhook.test.js`
- Modify: `.dev.vars.example`

**Interfaces:**
- Consumes: raw request body, `svix-id`, `svix-timestamp`, `svix-signature`, `env.RESEND_WEBHOOK_SECRET`, and `resend_message_id` delivery lookup.
- Produces: verified, idempotent updates for permanent bounce and spam complaint events.

- [ ] **Step 1: Write failing signature and suppression tests**

```js
// tests/newsletter/webhook.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost } from '../../functions/api/newsletter/webhook.js';
import { makeWebhookContext } from '../helpers/fixtures.js';

test('rejects an invalid webhook signature before changing data', async () => {
  const ctx = makeWebhookContext({ signature: 'v1,bad', event: 'email.bounced' });
  assert.equal((await onRequestPost(ctx)).status, 400);
  assert.equal(ctx.env.rows.subscribers[0].status, 'active');
});

test('permanent bounce suppresses future sends', async () => {
  const ctx = makeWebhookContext({ valid: true, event: 'email.bounced', bounceType: 'Permanent' });
  assert.equal((await onRequestPost(ctx)).status, 200);
  assert.equal(ctx.env.rows.subscribers[0].status, 'bounced');
  assert.equal(ctx.env.rows.deliveries[0].status, 'bounced');
});
```

- [ ] **Step 2: Run webhook tests and verify failure**

Run: `node --test tests/newsletter/webhook.test.js`

Expected: FAIL because the webhook handler does not exist.

- [ ] **Step 3: Implement raw-body signature verification and event handling**

Decode the base64 portion of the `whsec_` secret, calculate HMAC-SHA256 over `${svixId}.${svixTimestamp}.${rawBody}`, compare all supplied `v1` signatures in constant time, and reject timestamps outside a five-minute replay window. Read the body with `request.text()` before JSON parsing.

Handle permanent `email.bounced` as `bounced` and `email.complained` as `complained`; update both the delivery and subscriber. Return 200 for valid but unhandled event types. Store processed `svix-id` values in `newsletter_webhook_events` with a unique key so retries are idempotent.

- [ ] **Step 4: Run webhook tests**

Run: `node --test tests/newsletter/webhook.test.js`

Expected: invalid signature, stale timestamp, duplicate event, permanent bounce, complaint, and ignored-event tests pass.

- [ ] **Step 5: Commit webhook suppression**

```bash
git add functions/api/newsletter/webhook.js tests/newsletter/webhook.test.js .dev.vars.example schema.sql
git commit -m "feat: suppress bounced and complained newsletter addresses"
```

---

### Task 8: Verify the complete service and prepare deployment

**Files:**
- Verify: `docs/superpowers/specs/2026-09-16-ailit-newsletter-service-design.md`
- Create: `docs/newsletter-operations.md`
- Create: `README.md`

**Interfaces:**
- Consumes: all previous tasks and the approved design document.
- Produces: reproducible local checks, deployment commands, secret inventory, rollback steps, and an operations handoff.

- [ ] **Step 1: Verify the approved design is present and unchanged**

Run: `test -s docs/superpowers/specs/2026-09-16-ailit-newsletter-service-design.md && rg -n "이메일 주소 한 가지|열람 및 클릭 추적은 사용하지 않는다|에이릿 편집실" docs/superpowers/specs/2026-09-16-ailit-newsletter-service-design.md`

Expected: all three approved constraints are found.

- [ ] **Step 2: Write the operations guide with exact environment keys**

Document these secrets: `SESSION_SECRET`, `RESEND_API_KEY`, and `RESEND_WEBHOOK_SECRET`. Document these non-secret variables: `ADMIN_EMAIL`, `NEWSLETTER_FROM`, and `PUBLIC_SITE_URL=https://ailiteracy.or.kr`. Include creation commands:

```bash
npx wrangler queues create ailit-newsletter-send
npx wrangler queues create ailit-newsletter-dead-letter
npx wrangler pages secret put SESSION_SECRET
npx wrangler pages secret put RESEND_API_KEY
npx wrangler pages secret put RESEND_WEBHOOK_SECRET
npx wrangler secret put RESEND_API_KEY --config worker/wrangler.toml
npx wrangler secret put SESSION_SECRET --config worker/wrangler.toml
```

State that the Resend sending domain must be verified before a real send and that the webhook endpoint is `https://ailiteracy.or.kr/api/newsletter/webhook`.

- [ ] **Step 3: Run the full automated suite and clean build**

Run: `npm test && npm run build`

Expected: all tests pass; `dist/` contains only public assets; no `.dev.vars`, API key, webhook secret, raw confirmation token, or test subscriber address appears in `dist/`.

- [ ] **Step 4: Run local D1 and Pages smoke checks**

Run: `npm run db:init:local` and then `npm run dev`.

Verify with HTTP requests:

```bash
curl -i http://localhost:8788/newsletter.html
curl -i -X POST http://localhost:8788/api/newsletter/subscribe \
  -H 'Content-Type: application/json' \
  --data '{"email":"delivered@resend.dev","consent":true,"company":""}'
curl -i http://localhost:8788/api/admin/newsletters
```

Expected: page returns 200, subscribe returns 202 with non-enumerating copy, and unauthenticated admin API returns 401.

- [ ] **Step 5: Review D1 schema and Worker configuration before remote mutation**

Run: `npx wrangler d1 execute ailit-db --local --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"` and `npx wrangler deploy --config worker/wrangler.toml --dry-run`.

Expected: all five newsletter tables plus `newsletter_webhook_events` are present and the Worker dry run reports a queue consumer and D1 binding.

- [ ] **Step 6: Commit documentation and verification results**

```bash
git add docs README.md
git commit -m "docs: add newsletter deployment and operations guide"
```

- [ ] **Step 7: Push only after GitHub authentication is restored**

Run: `gh auth login -h github.com`, verify with `gh auth status`, then push the feature branch. Do not apply the remote D1 schema, create production queues, set production secrets, deploy, or send a real newsletter until those external changes are separately approved at execution time.
