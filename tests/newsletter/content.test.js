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

test('renderer supports only known blocks and produces a bounded email layout', () => {
  const result = validateBlocks([
    { id: 'image', type: 'image', data: { url: 'https://cdn.example.com/news.jpg', alt: '뉴스레터 표지', width: 640 } },
    { id: 'rule', type: 'divider', data: {} },
    { id: 'unknown', type: 'html', data: { text: '<p>unsafe</p>' } },
  ]);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /지원하지 않는 블록/);

  const rendered = renderNewsletter({
    subject: '<제목>', previewText: '<미리보기>',
    blocks: [{ id: 'h1', type: 'heading', data: { text: '안녕하세요' } }],
    unsubscribeUrl: 'https://ailiteracy.or.kr/api/newsletter/unsubscribe?token=x',
  });
  assert.match(rendered.html, /width="640"/);
  assert.match(rendered.html, /&lt;제목&gt;/);
  assert.match(rendered.text, /https:\/\/ailiteracy\.or\.kr/);
});

test('image blocks require a nonempty alt and http URLs', () => {
  const result = validateBlocks([
    { id: 'missing-alt', type: 'image', data: { url: 'https://cdn.example.com/news.jpg', alt: '' } },
    { id: 'file-url', type: 'image', data: { url: 'file:///private/news.jpg', alt: '표지' } },
  ]);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /대체 텍스트/);
  assert.match(result.errors.join(' '), /허용되지 않는 URL/);
});

test('production-safe validation rejects HTTP images without ambient runtime state', () => {
  const blocks = [
    { id: 'image', type: 'image', data: { url: 'http://cdn.example.com/news.jpg', alt: '뉴스레터 표지', width: 640 } },
  ];
  const strict = validateBlocks(blocks);
  assert.equal(strict.ok, false);
  assert.match(strict.errors.join(' '), /허용되지 않는 URL/);
  assert.equal(validateBlocks(blocks, { requireHttpsImages: false }).ok, true);
  assert.throws(() => renderNewsletter({
    subject: '제목', previewText: '미리보기', blocks,
    unsubscribeUrl: 'https://ailiteracy.or.kr/api/newsletter/unsubscribe?token=x',
  }), /허용되지 않는 URL/);
  assert.doesNotThrow(() => renderNewsletter({
    subject: '제목', previewText: '미리보기', blocks,
    unsubscribeUrl: 'https://ailiteracy.or.kr/api/newsletter/unsubscribe?token=x',
    requireHttpsImages: false,
  }));
});

test('validation rejects a block document whose UTF-8 bytes cannot fit a durable 100-recipient operation', () => {
  const oversized = Array.from({ length: 6 }, (_, index) => ({ id: `copy-${index}`, type: 'paragraph', data: { text: '가'.repeat(10_000) } }));
  const result = validateBlocks(oversized);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /용량/);
});
