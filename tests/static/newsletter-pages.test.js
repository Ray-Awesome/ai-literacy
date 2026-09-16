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

test('public pages use accessible form controls and status only uses known states', async () => {
  const [subscribe, privacy, status, script] = await Promise.all([
    readFile(new URL('../../newsletter.html', import.meta.url), 'utf8'),
    readFile(new URL('../../newsletter-privacy.html', import.meta.url), 'utf8'),
    readFile(new URL('../../newsletter-status.html', import.meta.url), 'utf8'),
    readFile(new URL('../../js/newsletter.js', import.meta.url), 'utf8'),
  ]);
  assert.match(subscribe, /<label[^>]*for="newsletter-email"/);
  assert.match(subscribe, /name="company"/);
  assert.match(subscribe, /aria-live="polite"/);
  assert.match(privacy, /이메일 주소/);
  assert.match(privacy, /Resend/);
  assert.match(status, /aria-live="polite"/);
  assert.match(script, /confirmed/);
  assert.doesNotMatch(script, /innerHTML\s*=/);
});

test('newsletter dark mode keeps labels and every newsletter action readable', async () => {
  const css = await readFile(new URL('../../css/style.css', import.meta.url), 'utf8');
  assert.match(css, /html\[data-theme="dark"\] \.newsletter-privacy dt \{ color: #BFDBFE; \}/);
  assert.match(css, /html\[data-theme="dark"\] \.newsletter-status \.btn-outline \{ color: #BFDBFE; border-color: #93C5FD; \}/);
  assert.match(css, /html\[data-theme="dark"\] \.newsletter-status \.btn-outline:hover \{ background: #BFDBFE; color: #0F172A; \}/);
  assert.match(css, /html\[data-theme="dark"\] \.newsletter-card \.form-check a \{ color: #93C5FD; \}/);
});
