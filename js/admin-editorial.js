import { beginSave, canSend, createEditorState, markDirty, navigationPlan, resolveSaveFailure, resolveSaveSuccess } from './admin-editorial-state.js';
import { beginAction, createActionState, resolveAction } from './admin-editorial-actions.js';
import { bindInitialPageLoader, createSendConfirmationController } from './admin-editorial-controller.js';
import { sendOutcome } from './admin-editorial-send-status.js';

(function () {
  'use strict';

  var panel = document.getElementById('panel');
  var adminInfo = document.getElementById('adminInfo');
  var tabs = {};
  ['Users', 'Answers', 'Newsletters', 'Subscribers', 'Sends'].forEach(function (name) { tabs[name.toLowerCase()] = document.getElementById('tab' + name); });
  var sessionNumber = 0;
  var sendConfirmation = createSendConfirmationController();
  var editor = startEditor(blankDraft());
  var state = editor.draft;
  var saveTimer = null;
  var flushAfterSave = false;
  var previewMode = 'desktop';
  var editorRefs = null;
  var pendingNavigation = null;
  var discardNavigation = null;
  var actions = createActionState(function () { return crypto.randomUUID(); });

  function blankDraft() { return { id: null, subject: '', previewText: '', blocks: [], status: 'draft' }; }
  function startEditor(draft) {
    clearTimeout(saveTimer);
    flushAfterSave = false;
    sendConfirmation.invalidate();
    return createEditorState(draft, 'editor-' + (++sessionNumber));
  }
  function leaveEditor() { editor = startEditor(blankDraft()); state = editor.draft; editorRefs = null; }
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
  function button(label, handler, disabled, className, extra) {
    var props = Object.assign({ type: 'button', className: className || 'btn btn-outline btn-sm', disabled: disabled ? 'disabled' : null, onclick: handler, text: label }, extra || {});
    return el('button', props);
  }
  function empty() { panel.replaceChildren(); }
  function message(text, kind) { panel.replaceChildren(el('p', { className: 'newsletter-feedback ' + (kind || 'loading'), text: text })); }
  function api(path, options) {
    return fetch(path, Object.assign({ credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }, options || {})).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) { var error = new Error(data.error || '요청을 처리하지 못했습니다.'); error.status = response.status; throw error; }
        return data;
      });
    });
  }
  function validUrl(value, image) {
    try { var url = new URL(value); return url.protocol === 'https:' || (!image && url.protocol === 'http:'); } catch (_) { return false; }
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
  function statusText() {
    if (editor.saving) return editor.dirty ? '저장 중 · 변경사항 대기 중' : '저장 중';
    if (editor.saveStatus === 'error') return '저장 실패: ' + editor.error;
    if (editor.dirty) return '저장 대기 중';
    return '저장됨';
  }
  function queueSave(delay) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDraft, delay === undefined ? 800 : delay);
  }
  function setDirty(render) {
    invalidateSendConfirmation();
    markDirty(editor);
    queueSave(800);
    if (render !== false) renderEditor();
    else refreshDerived();
  }
  function refreshDerived() {
    if (!editorRefs) return;
    var errors = validateDraft();
    if (sendConfirmation.current() && !sendConfirmation.canSubmit(editor, errors.length === 0)) invalidateSendConfirmation();
    var enabled = canSend(editor, errors.length === 0);
    editorRefs.status.textContent = statusText();
    editorRefs.status.className = 'editorial-save-state ' + (editor.saveStatus === 'error' ? 'error' : editor.saving || editor.dirty ? 'loading' : 'success');
    editorRefs.validation.textContent = errors.join(' ');
    editorRefs.validation.hidden = !errors.length;
    editorRefs.retry.hidden = editor.saveStatus !== 'error';
    editorRefs.testButton.disabled = !enabled;
    editorRefs.fullButton.disabled = !enabled;
    editorRefs.desktopToggle.setAttribute('aria-pressed', String(previewMode === 'desktop'));
    editorRefs.mobileToggle.setAttribute('aria-pressed', String(previewMode === 'mobile'));
    editorRefs.preview.replaceChildren(preview());
  }
  function retrySave() {
    if (editor.saveStatus !== 'error' || !editor.dirty || editor.saving) return;
    queueSave(0);
    refreshDerived();
  }
  function invalidateSendConfirmation() {
    sendConfirmation.invalidate();
    if (editorRefs) editorRefs.sendConfirm.replaceChildren();
  }
  function requestNavigation(proceed) {
    var plan = navigationPlan(editor, validateDraft().length === 0);
    if (plan.kind === 'leave') { completeNavigation(proceed); return; }
    if (plan.kind === 'confirm-discard') { showDiscardDecision(proceed, editor.saveStatus === 'error' ? '저장에 실패했습니다. 변경사항을 버릴까요?' : '입력 내용을 확인해야 저장할 수 있습니다. 변경사항을 버릴까요?'); return; }
    pendingNavigation = { editor: editor, proceed: proceed };
    if (editor.saving) { flushAfterSave = flushAfterSave || editor.revision > editor.activeRevision; refreshDerived(); }
    else queueSave(0);
  }
  function completeNavigation(proceed) {
    pendingNavigation = null;
    discardNavigation = null;
    leaveEditor();
    proceed();
  }
  function continueNavigation(savedEditor) {
    if (!pendingNavigation || pendingNavigation.editor !== savedEditor || savedEditor.dirty || savedEditor.saving) return;
    var proceed = pendingNavigation.proceed;
    completeNavigation(proceed);
  }
  function showDiscardDecision(proceed, text) {
    discardNavigation = proceed;
    if (!editorRefs) return;
    editorRefs.leaveMessage.textContent = text;
    editorRefs.leaveGuard.hidden = false;
    editorRefs.continueEditing.focus();
  }
  function dismissDiscardDecision() {
    discardNavigation = null;
    pendingNavigation = null;
    if (editorRefs) editorRefs.leaveGuard.hidden = true;
  }
  function discardAndNavigate() {
    if (!discardNavigation) return;
    var proceed = discardNavigation;
    completeNavigation(proceed);
  }
  function actionStateText(action, label) {
    if (action.status === 'pending') return label + ' 요청 중…';
    if (action.status === 'success') return label + ' 요청을 대기열에 등록했습니다.';
    if (action.status === 'retryable-error') return label + ' 요청 상태를 확인하지 못했습니다. 같은 키로 다시 시도하세요: ' + action.error;
    return label + ' 요청을 시작하지 못했습니다: ' + action.error;
  }
  function runAction(slot, context, endpoint, body, label, onSuccess, onUpdate) {
    if (actions.actions.get(slot)?.status === 'pending') return;
    var action = beginAction(actions, slot, context);
    onUpdate(action);
    api(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': action.key }, body: JSON.stringify(body) }).then(function (data) {
      if (!resolveAction(actions, action, 'success')) return;
      onUpdate(action);
      onSuccess(data);
    }).catch(function (error) {
      var retryable = !error.status || error.status >= 500;
      if (!resolveAction(actions, action, retryable ? 'retryable-error' : 'definitive-error', error.message)) return;
      onUpdate(action);
    });
  }
  function showFullSendConfirmation() {
    if (!editorRefs) return;
    var request = sendConfirmation.begin(editor, validateDraft().length === 0);
    if (!request) return;
    editorRefs.sendConfirm.replaceChildren(el('p', { className: 'editorial-save-state loading', text: '현재 활성 구독자 수를 확인하는 중…' }));
    api('/api/admin/newsletter-subscribers?summary=active').then(function (data) {
      if (!editorRefs) return;
      var count = Number(data.activeCount || 0);
      var confirmation = sendConfirmation.resolve(request, count, editor, validateDraft().length === 0);
      if (!confirmation) { if (!sendConfirmation.current()) editorRefs.sendConfirm.replaceChildren(); return; }
      var confirm = el('section', { className: 'editorial-confirm', 'aria-label': '전체 발송 최종 확인' });
      confirm.append(el('p', { text: '제목: ' + confirmation.subject }), el('p', { text: '현재 활성 구독자 ' + confirmation.recipientCount + '명에게 발송을 시작합니다.' }));
      confirm.append(button('취소', invalidateSendConfirmation), button('최종 발송 시작', function () { startFullSend(confirmation); }, false, 'btn btn-primary btn-sm'));
      editorRefs.sendConfirm.replaceChildren(confirm);
    }).catch(function (error) {
      if (sendConfirmation.current() !== request || !editorRefs) return;
      sendConfirmation.invalidate();
      editorRefs.sendConfirm.replaceChildren(el('p', { className: 'editorial-error', text: error.message }));
    });
  }
  function startFullSend(confirmation) {
    var id;
    var actionEditor;
    var context;
    var allowed = confirmation && editorRefs && sendConfirmation.submit(editor, validateDraft().length === 0, confirmation, function (confirmed) {
      id = confirmed.draftId;
      actionEditor = editor;
      context = { newsletterId: id, recipientCount: confirmed.recipientCount, revision: confirmed.revision, subject: confirmed.subject };
    });
    if (!allowed) {
      if (sendConfirmation.current() === confirmation) invalidateSendConfirmation();
      refreshDerived();
      return;
    }
    runAction('send:' + id, context, '/api/admin/newsletters/' + id + '/send', {}, '전체 발송', function () {
      if (editor !== actionEditor || !editorRefs) { loadSends(0); return; }
      state.status = 'sending';
      invalidateSendConfirmation();
      refreshDerived();
      setTimeout(function () { loadSends(0); }, 400);
    }, function (action) {
      if (editor !== actionEditor || !editorRefs) return;
      editorRefs.actionStatus.textContent = actionStateText(action, '전체 발송');
      editorRefs.actionStatus.className = 'editorial-save-state ' + (action.status === 'success' ? 'success' : action.status === 'pending' ? 'loading' : 'error');
      editorRefs.actionRetry.hidden = action.status !== 'retryable-error';
      editorRefs.fullButton.disabled = action.status === 'pending';
      editorRefs.actionRetry.onclick = function () { startFullSend(confirmation); };
    });
  }
  function startFailedRecipientRetry(send) {
    if (!sendOutcome(send).canRetry) return;
    var slot = 'retry:' + send.newsletterId + ':' + send.id;
    message('알려진 실패 수신자 재시도 요청 중…');
    runAction(slot, { newsletterId: send.newsletterId, sendId: send.id }, '/api/admin/newsletters/' + send.newsletterId + '/retry', { sendId: send.id }, '알려진 실패 수신자 재시도', function () {
      loadSends(0);
    }, function (action) {
      if (action.status === 'pending') return;
      if (action.status === 'retryable-error') {
        empty();
        var retry = button('같은 키로 재시도', function () { startFailedRecipientRetry(send); }, false, 'btn btn-outline btn-sm');
        panel.append(el('p', { className: 'newsletter-feedback error', text: actionStateText(action, '알려진 실패 수신자 재시도') }), retry);
      } else if (action.status === 'definitive-error') {
        message(actionStateText(action, '알려진 실패 수신자 재시도'), 'error');
      }
    });
  }
  function saveDraft() {
    saveTimer = null;
    var errors = validateDraft();
    if (errors.length || !editor.dirty) { refreshDerived(); return; }
    if (editor.saving) { flushAfterSave = true; refreshDerived(); return; }
    var requestEditor = editor;
    invalidateSendConfirmation();
    var operation = beginSave(requestEditor);
    if (!operation) { refreshDerived(); return; }
    refreshDerived();
    var endpoint = operation.draftId ? '/api/admin/newsletters/' + operation.draftId : '/api/admin/newsletters';
    api(endpoint, { method: operation.draftId ? 'PUT' : 'POST', body: JSON.stringify(operation.payload) }).then(function (data) {
      if (editor !== requestEditor) return;
      var resolved = resolveSaveSuccess(requestEditor, operation, data.newsletter);
      if (!resolved.accepted) return;
      if (resolved.shouldFlush || flushAfterSave) { flushAfterSave = false; queueSave(0); }
      refreshDerived();
      continueNavigation(requestEditor);
    }).catch(function (error) {
      if (editor !== requestEditor) return;
      var resolved = resolveSaveFailure(requestEditor, operation, error.message);
      if (resolved.accepted) {
        refreshDerived();
        if (pendingNavigation?.editor === requestEditor) {
          var proceed = pendingNavigation.proceed;
          pendingNavigation = null;
          showDiscardDecision(proceed, '저장에 실패했습니다. 변경사항을 버릴까요?');
        }
      }
    });
  }
  function blockTemplate(type) {
    var id = 'block-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    if (type === 'heading' || type === 'paragraph') return { id: id, type: type, data: { text: '' } };
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
  function preview() {
    var frame = el('article', { className: 'newsletter-preview-canvas ' + previewMode, 'aria-label': previewMode === 'desktop' ? '데스크톱 이메일 미리보기' : '모바일 이메일 미리보기' });
    frame.append(el('p', { className: 'newsletter-preview-brand', text: 'AILIT NEWSLETTER' }));
    state.blocks.forEach(function (block) {
      var data = block.data || {};
      if (block.type === 'heading') frame.append(el('h2', { text: data.text || '제목' }));
      if (block.type === 'paragraph') frame.append(el('p', { className: 'newsletter-preview-copy', text: data.text || '본문을 입력하세요.' }));
      if (block.type === 'divider') frame.append(el('hr'));
      if (block.type === 'button') { var link = el('a', { className: 'newsletter-preview-button', text: data.label || '버튼' }); if (validUrl(data.url || '', false)) link.href = data.url; frame.append(link); }
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
    empty();
    var top = el('div', { className: 'editorial-heading' }, [el('h2', { text: state.id ? '뉴스레터 초안' : '새 뉴스레터' })]);
    top.append(button('목록으로', function () { requestNavigation(function () { loadNewslettersNow(0); }); })); panel.append(top);
    var grid = el('div', { className: 'editorial-grid' });
    var form = el('section', { className: 'editorial-editor', 'aria-label': '뉴스레터 편집기' });
    form.append(input('이메일 제목', state.subject, function (value) { state.subject = value; setDirty(false); }));
    form.append(input('받은편지함 미리보기 문구', state.previewText, function (value) { state.previewText = value; setDirty(false); }, { textarea: true, rows: 2 }));
    form.append(el('h3', { text: '본문 블록' }));
    var adds = el('div', { className: 'editorial-actions', 'aria-label': '블록 추가' });
    [['heading', '제목'], ['paragraph', '본문'], ['image', '이미지'], ['button', '버튼'], ['divider', '구분선']].forEach(function (item) { adds.append(button(item[1] + ' 추가', function () { state.blocks.push(blockTemplate(item[0])); setDirty(); })); });
    form.append(adds); state.blocks.forEach(function (block, index) { form.append(blockEditor(block, index)); });
    var status = el('p', { className: 'editorial-save-state', 'aria-live': 'polite' });
    var validation = el('p', { className: 'editorial-error', 'aria-live': 'polite', hidden: 'hidden' });
    var retry = button('저장 다시 시도', retrySave, false, 'btn btn-outline btn-sm', { hidden: 'hidden', 'aria-label': '뉴스레터 저장 다시 시도' });
    form.append(status, validation, retry);
    var leaveGuard = el('section', { className: 'editorial-confirm', role: 'alertdialog', 'aria-label': '저장되지 않은 변경사항', hidden: 'hidden' });
    var leaveMessage = el('p');
    var continueEditing = button('계속 편집', dismissDiscardDecision, false, 'btn btn-outline btn-sm');
    var discard = button('변경사항 버리기', discardAndNavigate, false, 'btn btn-outline btn-sm editorial-danger');
    leaveGuard.append(leaveMessage, continueEditing, discard);
    form.append(leaveGuard);
    var testRow = el('div', { className: 'editorial-test' });
    var testEmail = el('input', { type: 'email', placeholder: '테스트 수신 이메일', 'aria-label': '테스트 수신 이메일' });
    var testButton = button('테스트 발송', function () { api('/api/admin/newsletters/' + state.id + '/test-send', { method: 'POST', body: JSON.stringify({ email: testEmail.value }) }).then(function (data) { status.textContent = data.message; }).catch(function (error) { status.textContent = error.message; }); });
    var fullButton = button('전체 발송', showFullSendConfirmation, false, 'btn btn-primary btn-sm');
    testRow.append(testEmail, testButton, fullButton); form.append(testRow); grid.append(form);
    var actionStatus = el('p', { className: 'editorial-save-state', 'aria-live': 'polite' });
    var actionRetry = button('같은 키로 발송 재시도', function () {}, false, 'btn btn-outline btn-sm', { hidden: 'hidden' });
    var sendConfirm = el('div');
    form.append(actionStatus, actionRetry, sendConfirm);
    var previewPanel = el('aside', { className: 'editorial-preview' }); previewPanel.append(el('h3', { text: '미리보기' }));
    var toggles = el('div', { className: 'editorial-actions', 'aria-label': '미리보기 너비' });
    var desktopToggle = button('데스크톱 640', function () { previewMode = 'desktop'; refreshDerived(); }, false, undefined, { 'aria-pressed': String(previewMode === 'desktop') });
    var mobileToggle = button('모바일 375', function () { previewMode = 'mobile'; refreshDerived(); }, false, undefined, { 'aria-pressed': String(previewMode === 'mobile') });
    toggles.append(desktopToggle, mobileToggle);
    var previewHolder = el('div'); previewPanel.append(toggles, previewHolder); grid.append(previewPanel); panel.append(grid);
    editorRefs = { status: status, validation: validation, retry: retry, leaveGuard: leaveGuard, leaveMessage: leaveMessage, continueEditing: continueEditing, testButton: testButton, fullButton: fullButton, actionStatus: actionStatus, actionRetry: actionRetry, sendConfirm: sendConfirm, desktopToggle: desktopToggle, mobileToggle: mobileToggle, preview: previewHolder };
    refreshDerived();
  }
  function newDraft() { editor = startEditor(blankDraft()); state = editor.draft; renderEditor(); }
  function table(headers, rows) {
    var t = el('table', { className: 'admin-table' }); var head = el('thead'); var hrow = el('tr'); headers.forEach(function (header) { hrow.append(el('th', { text: header })); }); head.append(hrow); t.append(head);
    var body = el('tbody'); rows.forEach(function (row) { var tr = el('tr'); row.forEach(function (value) { var cell = el('td'); if (value instanceof Node) cell.append(value); else cell.textContent = value == null ? '' : String(value); tr.append(cell); }); body.append(tr); }); t.append(body); return t;
  }
  function paginationControls(offset, limit, hasNext, onPage) {
    var controls = el('nav', { className: 'editorial-actions editorial-pagination', 'aria-label': '목록 페이지 이동' });
    controls.append(button('이전', function () { onPage(Math.max(0, offset - limit)); }, offset === 0));
    controls.append(el('span', { text: Math.floor(offset / limit) + 1 + '쪽' }));
    controls.append(button('다음', function () { onPage(offset + limit); }, !hasNext));
    return controls;
  }
  function selectTab(name) { Object.keys(tabs).forEach(function (key) { tabs[key].classList.toggle('is-active', key === name); }); }
  function renderList(heading, content) { empty(); panel.append(el('h2', { className: 'editorial-list-title', text: heading }), content); }
  function loadUsers() { requestNavigation(loadUsersNow); }
  function loadUsersNow() { leaveEditor(); selectTab('users'); message('불러오는 중...'); api('/api/admin/users').then(function (data) { var users = data.users || []; renderList('회원 목록', users.length ? table(['ID', '이메일', '생년월일', '구분', '보호자(법정대리인)', '답변수', '가입일'], users.map(function (u) { return [u.id, u.email + (u.is_admin ? ' 🛡️' : ''), u.birth_date, u.is_minor ? '14세 미만' : '성인', u.is_minor ? [u.guardian_name, u.guardian_relation, u.guardian_contact, u.guardian_consent ? '동의' : '미동의'].filter(Boolean).join(' · ') : '-', u.answer_count, u.created_at]; })) : el('p', { text: '회원이 없습니다.' })); }).catch(function (error) { message(error.message, 'error'); }); }
  function loadAnswers() { requestNavigation(loadAnswersNow); }
  function loadAnswersNow() { leaveEditor(); selectTab('answers'); message('불러오는 중...'); api('/api/admin/answers').then(function (data) { var answers = data.answers || []; renderList('답변 목록', answers.length ? table(['회원', '문항키', '질문', '답변', '페이지', '저장시각'], answers.map(function (a) { return [a.email, a.item_key, a.prompt, a.answer, a.page_url, a.updated_at]; })) : el('p', { text: '저장된 답변이 없습니다.' })); }).catch(function (error) { message(error.message, 'error'); }); }
  function loadNewsletters(offset) { requestNavigation(function () { loadNewslettersNow(offset || 0); }); }
  function loadNewslettersNow(offset) { leaveEditor(); selectTab('newsletters'); message('불러오는 중...'); var limit = 50; api('/api/admin/newsletters?limit=' + limit + '&offset=' + offset).then(function (data) { empty(); var heading = el('div', { className: 'editorial-heading' }, [el('h2', { text: '뉴스레터' })]); heading.append(button('새 뉴스레터 작성', newDraft, false, 'btn btn-primary btn-sm')); panel.append(heading); var rows = data.newsletters || []; panel.append(rows.length ? table(['제목', '상태', '최종 수정', '작성자', '발송 시각', '대상'], rows.map(function (item) { return [button(item.subject, function () { editor = startEditor(item); state = editor.draft; renderEditor(); }, false, 'editorial-link'), item.status, item.updatedAt, item.authorEmail || '-', item.sentAt || '-', item.targetCount || 0]; })) : el('p', { text: offset ? '이 페이지에 뉴스레터가 없습니다.' : '작성한 뉴스레터가 없습니다.' })); panel.append(paginationControls(offset, limit, rows.length === limit, loadNewsletters)); }).catch(function (error) { message(error.message, 'error'); }); }
  function loadSubscribers(offset) { requestNavigation(function () { loadSubscribersNow(offset || 0); }); }
  function loadSubscribersNow(offset) { leaveEditor(); selectTab('subscribers'); message('불러오는 중...'); var limit = 50; api('/api/admin/newsletter-subscribers?limit=' + limit + '&offset=' + offset).then(function (data) { empty(); panel.append(el('h2', { className: 'editorial-list-title', text: '구독자' })); var rows = data.subscribers || []; panel.append(rows.length ? table(['이메일', '상태', '동의 시각', '확인 시각', '취소 시각'], rows.map(function (s) { return [s.email, s.status, s.consentAt, s.confirmedAt || '-', s.unsubscribedAt || '-']; })) : el('p', { text: offset ? '이 페이지에 구독자가 없습니다.' : '구독자가 없습니다.' })); panel.append(paginationControls(offset, limit, rows.length === limit, loadSubscribers)); }).catch(function (error) { message(error.message, 'error'); }); }
  function loadSends(offset) { requestNavigation(function () { loadSendsNow(offset || 0); }); }
  function loadSendsNow(offset) {
    leaveEditor(); selectTab('sends'); message('불러오는 중...');
    var limit = 50;
    api('/api/admin/newsletter-sends?limit=' + limit + '&offset=' + offset).then(function (data) {
      empty(); panel.append(el('h2', { className: 'editorial-list-title', text: '발송 기록' }));
      var rows = data.sends || [];
      panel.append(rows.length ? table(['뉴스레터', '상태', '대상', '성공', '전체 실패', '재시도 가능 실패', '확인 필요', '시작', '완료', '수신 내역', '재시도'], rows.map(function (s) {
        var outcome = sendOutcome(s);
        return [
          s.subject, s.status, s.targetCount, s.successCount, s.failureCount,
          outcome.retryableCount ? outcome.retryableCount + '명' : '-',
          outcome.reconciliationMessage || '-',
          s.startedAt || '-', s.completedAt || '-',
          button('수신 내역', function () { loadDeliveries(s.id, 0); }, false),
          outcome.canRetry ? button('알려진 실패 수신자 재시도', function () { startFailedRecipientRetry(s); }, false) : '-',
        ];
      })) : el('p', { text: offset ? '이 페이지에 발송 기록이 없습니다.' : '발송 기록이 없습니다.' }));
      panel.append(paginationControls(offset, limit, rows.length === limit, loadSends));
    }).catch(function (error) { message(error.message, 'error'); });
  }
  function loadDeliveries(sendId, offset) { requestNavigation(function () { loadDeliveriesNow(sendId, offset || 0); }); }
  function loadDeliveriesNow(sendId, offset) {
    leaveEditor(); selectTab('sends'); message('수신 내역을 불러오는 중...');
    var limit = 50;
    api('/api/admin/newsletter-sends?sendId=' + encodeURIComponent(sendId) + '&limit=' + limit + '&offset=' + offset).then(function (data) {
      empty();
      var heading = el('div', { className: 'editorial-heading' }, [el('h2', { text: '수신 내역' })]);
      heading.append(button('발송 기록으로', function () { loadSends(0); })); panel.append(heading);
      var rows = data.deliveries || [];
      var indeterminateCount = rows.filter(function (delivery) { return delivery.certainty === 'indeterminate'; }).length;
      if (indeterminateCount) panel.append(el('p', { className: 'editorial-error', text: '확인 필요 ' + indeterminateCount + '명: 제공업체 확인이 필요합니다. 이 상태는 일반 재시도 대상이 아닙니다.' }));
      panel.append(rows.length ? table(['이메일', '상태', '확실성', '오류 코드', '오류 내용', '발송 시각', '변경 시각'], rows.map(function (d) {
        return [d.email, d.status, d.certainty === 'indeterminate' ? '확인 필요 · 제공업체 확인' : '확인됨', d.errorCode || '-', d.errorMessage || '-', d.sentAt || '-', d.updatedAt || '-'];
      })) : el('p', { text: offset ? '이 페이지에 수신 내역이 없습니다.' : '수신 내역이 없습니다.' }));
      panel.append(paginationControls(offset, limit, rows.length === limit, function (nextOffset) { loadDeliveries(sendId, nextOffset); }));
    }).catch(function (error) { message(error.message, 'error'); });
  }
  tabs.users.addEventListener('click', loadUsers); tabs.answers.addEventListener('click', loadAnswers); bindInitialPageLoader(tabs.newsletters, loadNewsletters); tabs.subscribers.addEventListener('click', function () { loadSubscribers(0); }); tabs.sends.addEventListener('click', function () { loadSends(0); });
  window.AilitAuth.me().then(function (data) { if (!data.user.isAdmin) { adminInfo.textContent = '관리자 권한이 없습니다.'; message('이 페이지는 관리자만 볼 수 있습니다.', 'error'); return; } adminInfo.textContent = data.user.email + ' (관리자)'; loadUsers(); }).catch(function () { location.href = 'login.html'; });
}());
