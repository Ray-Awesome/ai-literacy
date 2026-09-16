(function () {
  'use strict';

  var panel = document.getElementById('panel');
  var adminInfo = document.getElementById('adminInfo');
  var tabs = {};
  ['Users', 'Answers', 'Newsletters', 'Subscribers', 'Sends'].forEach(function (name) {
    tabs[name.toLowerCase()] = document.getElementById('tab' + name);
  });
  var state = { id: null, subject: '', previewText: '', blocks: [], status: 'draft', dirty: false };
  var saveTimer = null;
  var saving = false;
  var saveMessage = '';
  var activeTab = 'users';
  var previewMode = 'desktop';

  function el(name, props, children) {
    var node = document.createElement(name);
    Object.keys(props || {}).forEach(function (key) {
      if (key === 'text') node.textContent = props[key];
      else if (key === 'className') node.className = props[key];
      else if (key.indexOf('on') === 0) node.addEventListener(key.slice(2).toLowerCase(), props[key]);
      else if (props[key] !== null && props[key] !== undefined) node.setAttribute(key, props[key]);
    });
    (children || []).forEach(function (child) { node.append(child); });
    return node;
  }

  function empty() { panel.replaceChildren(); }
  function message(text, kind) { panel.replaceChildren(el('p', { className: 'newsletter-feedback ' + (kind || 'loading'), text: text })); }
  function api(path, options) {
    return fetch(path, Object.assign({ credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }, options || {}))
      .then(function (response) { return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) throw new Error(data.error || '요청을 처리하지 못했습니다.');
        return data;
      }); });
  }
  function validUrl(value, image) {
    try { var url = new URL(value); return (url.protocol === 'https:' || (!image && url.protocol === 'http:')); } catch (_) { return false; }
  }
  function validateDraft() {
    var errors = [];
    if (!state.subject.trim()) errors.push('제목을 입력하세요.');
    if (!state.previewText.trim()) errors.push('미리보기 문구를 입력하세요.');
    if (!state.blocks.length) errors.push('본문 블록을 하나 이상 추가하세요.');
    state.blocks.forEach(function (block, index) {
      var data = block.data || {};
      if ((block.type === 'heading' || block.type === 'paragraph') && !String(data.text || '').trim()) errors.push((index + 1) + '번 블록의 텍스트를 입력하세요.');
      if (block.type === 'image' && (!validUrl(data.url || '', true) || !String(data.alt || '').trim() || !Number.isInteger(Number(data.width)) || Number(data.width) < 1 || Number(data.width) > 640)) errors.push((index + 1) + '번 이미지의 URL, 대체 텍스트, 너비를 확인하세요.');
      if (block.type === 'button' && (!String(data.label || '').trim() || !validUrl(data.url || '', false))) errors.push((index + 1) + '번 버튼의 문구와 URL을 확인하세요.');
    });
    return errors;
  }
  function setDirty(render) {
    state.dirty = true;
    saveMessage = '';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDraft, 800);
    if (render !== false) renderEditor();
  }
  function blockTemplate(type) {
    var id = 'block-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    if (type === 'heading') return { id: id, type: type, data: { text: '' } };
    if (type === 'paragraph') return { id: id, type: type, data: { text: '' } };
    if (type === 'image') return { id: id, type: type, data: { url: '', alt: '', width: 640 } };
    if (type === 'button') return { id: id, type: type, data: { label: '', url: '' } };
    return { id: id, type: 'divider', data: {} };
  }
  function input(label, value, onChange, options) {
    options = options || {};
    var field = options.textarea ? el('textarea', { rows: options.rows || 3, 'aria-label': label }) : el('input', { type: options.type || 'text', 'aria-label': label });
    field.value = value || '';
    field.addEventListener('input', function () { onChange(field.value); });
    return el('label', { className: 'editorial-field' }, [el('span', { text: label }), field]);
  }
  function button(label, handler, disabled, className) {
    return el('button', { type: 'button', className: className || 'btn btn-outline btn-sm', disabled: disabled ? 'disabled' : null, onclick: handler, text: label });
  }
  function preview() {
    var frame = el('article', { className: 'newsletter-preview-canvas ' + previewMode, 'aria-label': previewMode === 'desktop' ? '데스크톱 이메일 미리보기' : '모바일 이메일 미리보기' });
    frame.append(el('p', { className: 'newsletter-preview-brand', text: 'AILIT NEWSLETTER' }));
    state.blocks.forEach(function (block) {
      var data = block.data || {};
      if (block.type === 'heading') frame.append(el('h2', { text: data.text || '제목' }));
      if (block.type === 'paragraph') frame.append(el('p', { className: 'newsletter-preview-copy', text: data.text || '본문을 입력하세요.' }));
      if (block.type === 'divider') frame.append(el('hr'));
      if (block.type === 'button') {
        var link = el('a', { className: 'newsletter-preview-button', text: data.label || '버튼' });
        if (validUrl(data.url || '', false)) link.href = data.url;
        frame.append(link);
      }
      if (block.type === 'image') {
        if (validUrl(data.url || '', true)) frame.append(el('img', { src: data.url, alt: data.alt || '', width: Math.min(Math.max(Number(data.width) || 1, 1), 640) }));
        else frame.append(el('p', { className: 'newsletter-preview-image', text: '이미지 URL을 입력하세요.' }));
      }
    });
    return frame;
  }
  function blockEditor(block, index) {
    var card = el('fieldset', { className: 'editorial-block' });
    card.append(el('legend', { text: (index + 1) + '. ' + ({ heading: '제목', paragraph: '본문', image: '이미지', button: '버튼', divider: '구분선' }[block.type]) }));
    if (block.type === 'heading' || block.type === 'paragraph') card.append(input(block.type === 'heading' ? '제목 텍스트' : '본문 텍스트', block.data.text, function (value) { block.data.text = value; setDirty(false); }, { textarea: true, rows: block.type === 'heading' ? 2 : 5 }));
    if (block.type === 'image') {
      card.append(input('이미지 HTTPS URL', block.data.url, function (value) { block.data.url = value; setDirty(false); }, { type: 'url' }));
      card.append(input('이미지 대체 텍스트', block.data.alt, function (value) { block.data.alt = value; setDirty(false); }));
      card.append(input('이미지 너비 (1–640px)', block.data.width, function (value) { block.data.width = Number(value); setDirty(false); }, { type: 'number' }));
    }
    if (block.type === 'button') {
      card.append(input('버튼 문구', block.data.label, function (value) { block.data.label = value; setDirty(false); }));
      card.append(input('버튼 링크 URL', block.data.url, function (value) { block.data.url = value; setDirty(false); }, { type: 'url' }));
    }
    if (block.type === 'divider') card.append(el('p', { className: 'editorial-help', text: '구분선은 별도 내용을 입력하지 않습니다.' }));
    var actions = el('div', { className: 'editorial-actions' });
    actions.append(button('위로', function () { if (index) { var prior = state.blocks[index - 1]; state.blocks[index - 1] = block; state.blocks[index] = prior; setDirty(); } }, index === 0));
    actions.append(button('아래로', function () { if (index < state.blocks.length - 1) { var next = state.blocks[index + 1]; state.blocks[index + 1] = block; state.blocks[index] = next; setDirty(); } }, index === state.blocks.length - 1));
    actions.append(button('삭제', function () { state.blocks.splice(index, 1); setDirty(); }, false, 'btn btn-outline btn-sm editorial-danger'));
    card.append(actions);
    return card;
  }
  function renderEditor() {
    var errors = validateDraft();
    var blocked = state.dirty || saving || errors.length || state.status !== 'draft';
    empty();
    var top = el('div', { className: 'editorial-heading' }, [el('h2', { text: state.id ? '뉴스레터 초안' : '새 뉴스레터' })]);
    top.append(button('목록으로', function () { clearTimeout(saveTimer); loadNewsletters(); }));
    panel.append(top);
    var grid = el('div', { className: 'editorial-grid' });
    var form = el('section', { className: 'editorial-editor', 'aria-label': '뉴스레터 편집기' });
    form.append(input('이메일 제목', state.subject, function (value) { state.subject = value; setDirty(false); }));
    form.append(input('받은편지함 미리보기 문구', state.previewText, function (value) { state.previewText = value; setDirty(false); }, { textarea: true, rows: 2 }));
    form.append(el('h3', { text: '본문 블록' }));
    var adds = el('div', { className: 'editorial-actions', 'aria-label': '블록 추가' });
    [['heading', '제목'], ['paragraph', '본문'], ['image', '이미지'], ['button', '버튼'], ['divider', '구분선']].forEach(function (item) { adds.append(button(item[1] + ' 추가', function () { state.blocks.push(blockTemplate(item[0])); setDirty(); })); });
    form.append(adds);
    state.blocks.forEach(function (block, index) { form.append(blockEditor(block, index)); });
    var status = el('p', { className: 'editorial-save-state ' + (saveMessage === '저장됨' ? 'success' : saveMessage ? 'error' : 'loading'), text: saving ? '저장 중' : (saveMessage || (state.dirty ? '저장 대기 중' : '저장됨')) });
    form.append(status);
    if (errors.length) form.append(el('p', { className: 'editorial-error', text: errors.join(' ') }));
    var testRow = el('div', { className: 'editorial-test' });
    var testEmail = el('input', { type: 'email', placeholder: '테스트 수신 이메일', 'aria-label': '테스트 수신 이메일' });
    testRow.append(testEmail);
    testRow.append(button('테스트 발송', function () {
      api('/api/admin/newsletters/' + state.id + '/test-send', { method: 'POST', body: JSON.stringify({ email: testEmail.value }) }).then(function (data) { status.textContent = data.message; }).catch(function (error) { status.textContent = error.message; });
    }, blocked || !state.id));
    testRow.append(button('전체 발송', function () { status.textContent = '전체 발송 기능은 준비 중입니다. 발송이 시작되었다고 처리하지 않았습니다.'; }, blocked || !state.id, 'btn btn-primary btn-sm'));
    form.append(testRow);
    grid.append(form);
    var previewPanel = el('aside', { className: 'editorial-preview' });
    previewPanel.append(el('h3', { text: '미리보기' }));
    var toggles = el('div', { className: 'editorial-actions', 'aria-label': '미리보기 너비' });
    toggles.append(button('데스크톱 640', function () { previewMode = 'desktop'; renderEditor(); }, false));
    toggles.append(button('모바일 375', function () { previewMode = 'mobile'; renderEditor(); }, false));
    previewPanel.append(toggles, preview());
    grid.append(previewPanel);
    panel.append(grid);
  }
  function saveDraft() {
    saveTimer = null;
    var errors = validateDraft();
    if (errors.length || !state.dirty || saving) { renderEditor(); return; }
    saving = true; renderEditor();
    var payload = { subject: state.subject, previewText: state.previewText, blocks: state.blocks };
    api(state.id ? '/api/admin/newsletters/' + state.id : '/api/admin/newsletters', { method: state.id ? 'PUT' : 'POST', body: JSON.stringify(payload) })
      .then(function (data) {
        Object.assign(state, data.newsletter, { dirty: false });
        saving = false; saveMessage = '저장됨'; renderEditor();
      }).catch(function (error) {
        saving = false; saveMessage = '저장 실패: ' + error.message + ' 다시 저장을 시도합니다.'; state.dirty = true; renderEditor();
      });
  }
  function newDraft() { state = { id: null, subject: '', previewText: '', blocks: [], status: 'draft', dirty: false }; saveMessage = ''; renderEditor(); }
  function table(headers, rows) {
    var t = el('table', { className: 'admin-table' });
    var head = el('thead'); var hrow = el('tr'); headers.forEach(function (header) { hrow.append(el('th', { text: header })); }); head.append(hrow); t.append(head);
    var body = el('tbody'); rows.forEach(function (row) { var tr = el('tr'); row.forEach(function (value) { var cell = el('td'); if (value instanceof Node) cell.append(value); else cell.textContent = value == null ? '' : String(value); tr.append(cell); }); body.append(tr); }); t.append(body); return t;
  }
  function selectTab(name) { activeTab = name; Object.keys(tabs).forEach(function (key) { tabs[key].setAttribute('aria-selected', String(key === name)); }); }
  function loadUsers() { selectTab('users'); message('불러오는 중...'); api('/api/admin/users').then(function (data) { empty(); var users = data.users || []; panel.append(users.length ? table(['ID', '이메일', '생년월일', '구분', '보호자(법정대리인)', '답변수', '가입일'], users.map(function (u) { return [u.id, u.email + (u.is_admin ? ' 🛡️' : ''), u.birth_date, u.is_minor ? '14세 미만' : '성인', u.is_minor ? [u.guardian_name, u.guardian_relation, u.guardian_contact, u.guardian_consent ? '동의' : '미동의'].filter(Boolean).join(' · ') : '-', u.answer_count, u.created_at]; })) : el('p', { text: '회원이 없습니다.' })); }).catch(function (error) { message(error.message, 'error'); }); }
  function loadAnswers() { selectTab('answers'); message('불러오는 중...'); api('/api/admin/answers').then(function (data) { empty(); var answers = data.answers || []; panel.append(answers.length ? table(['회원', '문항키', '질문', '답변', '페이지', '저장시각'], answers.map(function (a) { return [a.email, a.item_key, a.prompt, a.answer, a.page_url, a.updated_at]; })) : el('p', { text: '저장된 답변이 없습니다.' })); }).catch(function (error) { message(error.message, 'error'); }); }
  function loadNewsletters() { selectTab('newsletters'); message('불러오는 중...'); api('/api/admin/newsletters').then(function (data) { empty(); var heading = el('div', { className: 'editorial-heading' }, [el('h2', { text: '뉴스레터' })]); heading.append(button('새 뉴스레터 작성', newDraft, false, 'btn btn-primary btn-sm')); panel.append(heading); var rows = data.newsletters || []; panel.append(rows.length ? table(['제목', '상태', '최종 수정', '작성자', '발송 시각', '대상'], rows.map(function (item) { return [button(item.subject, function () { state = Object.assign({}, item, { dirty: false }); saveMessage = ''; renderEditor(); }, false, 'editorial-link'), item.status, item.updatedAt, item.authorEmail || '-', item.sentAt || '-', item.targetCount || 0]; })) : el('p', { text: '작성한 뉴스레터가 없습니다.' })); }).catch(function (error) { message(error.message, 'error'); }); }
  function loadSubscribers() { selectTab('subscribers'); message('불러오는 중...'); api('/api/admin/newsletter-subscribers?limit=100&offset=0').then(function (data) { empty(); var rows = data.subscribers || []; panel.append(rows.length ? table(['이메일', '상태', '동의 시각', '확인 시각', '취소 시각'], rows.map(function (s) { return [s.email, s.status, s.consentAt, s.confirmedAt || '-', s.unsubscribedAt || '-']; })) : el('p', { text: '구독자가 없습니다.' })); }).catch(function (error) { message(error.message, 'error'); }); }
  function loadSends() { selectTab('sends'); message('불러오는 중...'); api('/api/admin/newsletter-sends?limit=100&offset=0').then(function (data) { empty(); var rows = data.sends || []; panel.append(rows.length ? table(['뉴스레터', '상태', '대상', '성공', '실패', '시작', '완료'], rows.map(function (s) { return [s.subject, s.status, s.targetCount, s.successCount, s.failureCount, s.startedAt || '-', s.completedAt || '-']; })) : el('p', { text: '발송 기록이 없습니다.' })); }).catch(function (error) { message(error.message, 'error'); }); }
  tabs.users.addEventListener('click', loadUsers); tabs.answers.addEventListener('click', loadAnswers); tabs.newsletters.addEventListener('click', loadNewsletters); tabs.subscribers.addEventListener('click', loadSubscribers); tabs.sends.addEventListener('click', loadSends);
  window.AilitAuth.me().then(function (data) {
    if (!data.user.isAdmin) { adminInfo.textContent = '관리자 권한이 없습니다.'; message('이 페이지는 관리자만 볼 수 있습니다.', 'error'); return; }
    adminInfo.textContent = data.user.email + ' (관리자)'; loadUsers();
  }).catch(function () { location.href = 'login.html'; });
}());
