const ALLOWED_TYPES = new Set(['heading', 'paragraph', 'image', 'button', 'divider']);
const MAX_TEXT_LENGTH = 10_000;
const MAX_IMAGE_WIDTH = 640;
// A send stores 100 complete rendered messages in one durable D1 operation.
// Keep the source document conservative enough for UTF-8/HTML expansion.
const MAX_BLOCK_DOCUMENT_BYTES = 1_024;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value, maximum = MAX_TEXT_LENGTH) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

function isAllowedUrl(value, { image = false, requireHttpsImages = true } = {}) {
  if (!hasText(value, 2_048)) return false;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    return !image || !requireHttpsImages || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function blockError(index, message) {
  return `블록 ${index + 1}: ${message}`;
}

export function validateBlocks(blocks, { requireHttpsImages = true } = {}) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return { ok: false, errors: ['본문 블록을 하나 이상 입력하세요.'] };
  }

  const errors = [];
  if (new TextEncoder().encode(JSON.stringify(blocks)).byteLength > MAX_BLOCK_DOCUMENT_BYTES) {
    errors.push('본문 용량이 전체 발송의 안전한 한도를 초과했습니다.');
  }
  const ids = new Set();
  blocks.forEach((block, index) => {
    if (!isPlainObject(block) || !hasText(block.id, 100)) {
      errors.push(blockError(index, '식별자가 필요합니다.'));
      return;
    }
    if (ids.has(block.id)) errors.push(blockError(index, '식별자가 중복되었습니다.'));
    ids.add(block.id);
    if (!ALLOWED_TYPES.has(block.type)) {
      errors.push(blockError(index, '지원하지 않는 블록입니다.'));
      return;
    }
    if (!isPlainObject(block.data)) {
      errors.push(blockError(index, '내용이 올바르지 않습니다.'));
      return;
    }

    const { data } = block;
    if (block.type === 'heading' || block.type === 'paragraph') {
      if (!hasText(data.text)) errors.push(blockError(index, '텍스트를 입력하세요.'));
    }
    if (block.type === 'button') {
      if (!hasText(data.label, 200)) errors.push(blockError(index, '버튼 문구를 입력하세요.'));
      if (!isAllowedUrl(data.url)) errors.push(blockError(index, '허용되지 않는 URL입니다.'));
    }
    if (block.type === 'image') {
      if (!isAllowedUrl(data.url, { image: true, requireHttpsImages })) errors.push(blockError(index, '허용되지 않는 URL입니다.'));
      if (!hasText(data.alt, 300)) errors.push(blockError(index, '이미지 대체 텍스트를 입력하세요.'));
      if (!Number.isInteger(data.width) || data.width < 1 || data.width > MAX_IMAGE_WIDTH) {
        errors.push(blockError(index, `이미지 너비는 1에서 ${MAX_IMAGE_WIDTH}px 사이여야 합니다.`));
      }
    }
  });

  return errors.length ? { ok: false, errors } : { ok: true, blocks };
}

function plainText(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function renderBlock(block) {
  const { data } = block;
  switch (block.type) {
    case 'heading':
      return {
        html: `<h1 style="margin:0 0 20px;color:#1E3A6E;font:700 28px/1.35 Arial,sans-serif;">${escapeHtml(data.text)}</h1>`,
        text: plainText(data.text),
      };
    case 'paragraph':
      return {
        html: `<p style="margin:0 0 18px;color:#1C2340;font:16px/1.7 Arial,sans-serif;white-space:pre-line;">${escapeHtml(data.text)}</p>`,
        text: plainText(data.text),
      };
    case 'image': {
      const width = Math.min(data.width, MAX_IMAGE_WIDTH);
      return {
        html: `<img src="${escapeHtml(data.url)}" alt="${escapeHtml(data.alt)}" width="${width}" style="display:block;width:100%;max-width:${width}px;height:auto;border:0;" />`,
        text: `[이미지: ${plainText(data.alt)}]`,
      };
    }
    case 'button':
      return {
        html: `<p style="margin:0 0 22px;"><a href="${escapeHtml(data.url)}" style="display:inline-block;padding:12px 20px;border-radius:6px;background:#F97316;color:#FFFFFF;font:700 15px/1 Arial,sans-serif;text-decoration:none;">${escapeHtml(data.label)}</a></p>`,
        text: `${plainText(data.label)}: ${data.url}`,
      };
    case 'divider':
      return {
        html: '<hr style="margin:28px 0;border:0;border-top:1px solid #E2E8F0;" />',
        text: '',
      };
    default:
      throw new Error('지원하지 않는 블록입니다.');
  }
}

function requireNewsletterText(value, name, maximum = 300) {
  if (!hasText(value, maximum)) throw new Error(`${name}을(를) 입력하세요.`);
  return value;
}

export function renderNewsletter({ subject, previewText, blocks, unsubscribeUrl, requireHttpsImages = true }) {
  requireNewsletterText(subject, '제목');
  requireNewsletterText(previewText, '미리보기 문구');
  if (!isAllowedUrl(unsubscribeUrl)) throw new Error('구독 취소 URL이 올바르지 않습니다.');
  const validated = validateBlocks(blocks, { requireHttpsImages });
  if (!validated.ok) throw new Error(validated.errors.join(' '));

  const renderedBlocks = validated.blocks.map(renderBlock);
  const bodyHtml = renderedBlocks.map((block) => block.html).join('\n');
  const bodyText = renderedBlocks.map((block) => block.text).filter(Boolean).join('\n\n');
  const siteUrl = 'https://ailiteracy.or.kr';
  const reason = '에이릿 뉴스레터 구독을 신청하셔서 이 메일을 보내드립니다.';
  const footerHtml = `<p style="margin:28px 0 0;padding-top:20px;border-top:1px solid #E2E8F0;color:#64748B;font:13px/1.65 Arial,sans-serif;">${reason}<br><a href="${siteUrl}" style="color:#1E3A6E;">${siteUrl}</a><br><a href="${escapeHtml(unsubscribeUrl)}" style="color:#1E3A6E;">구독 취소</a></p>`;
  const footerText = `${reason}\n${siteUrl}\n구독 취소: ${unsubscribeUrl}`;

  return {
    html: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(subject)}</title></head><body style="margin:0;padding:0;background:#F8FAFC;"><span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">${escapeHtml(previewText)}</span><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#F8FAFC;"><tr><td align="center" style="padding:24px 12px;"><table role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:640px;background:#FFFFFF;"><tr><td style="padding:36px 32px;"><p style="margin:0 0 24px;color:#F97316;font:700 13px/1 Arial,sans-serif;letter-spacing:1px;">AILIT NEWSLETTER</p>${bodyHtml}${footerHtml}</td></tr></table></td></tr></table></body></html>`,
    text: `${subject}\n\n${previewText}\n\n${bodyText}\n\n${footerText}`,
  };
}
