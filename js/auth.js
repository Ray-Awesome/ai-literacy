/* auth.js — AILIT 회원/답변 클라이언트 헬퍼
 * 같은 서버(동일 출처)에서 제공되는 /api/* 를 호출합니다.
 * - 로그인 상태에 따라 헤더의 '로그인' 링크를 '내 계정'으로 바꿉니다.
 * - [data-answer-key] 요소를 답변 저장 위젯으로 자동 변환합니다.
 */
(function () {
  'use strict';

  async function api(path, opts) {
    const res = await fetch(path, Object.assign({
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    }, opts || {}));
    let data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error(data.error || ('오류가 발생했습니다 (' + res.status + ')'));
    return data;
  }

  const AilitAuth = {
    me:        ()                       => api('/api/me'),
    signup:    (body)                   => api('/api/signup', { method: 'POST', body: JSON.stringify(body) }),
    login:     (email, password)        => api('/api/login',  { method: 'POST', body: JSON.stringify({ email, password }) }),
    logout:    ()                       => api('/api/logout', { method: 'POST' }),
    getAnswers:()                       => api('/api/answers'),
    saveAnswer:(itemKey, prompt, answer, pageUrl) =>
      api('/api/answers', { method: 'POST', body: JSON.stringify({ itemKey, prompt, answer, pageUrl: pageUrl || location.pathname }) }),
  };
  window.AilitAuth = AilitAuth;

  function esc(s){ return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

  // 헤더 로그인 상태 표시
  function updateHeader(user) {
    document.querySelectorAll('a.nav-cta').forEach(function (a) {
      var href = a.getAttribute('href') || '';
      if (!/login\.html$/.test(href)) return; // '로그인' 링크만 대상
      if (user) { a.textContent = '내 계정'; a.setAttribute('href', '/account.html'); }
    });
    if (user && user.isAdmin) {
      document.querySelectorAll('.nav-links').forEach(function (nav) {
        if (nav.querySelector('[data-admin-link]')) return;
        var a = document.createElement('a');
        a.setAttribute('href', '/admin.html'); a.setAttribute('data-admin-link', '1'); a.textContent = '관리자';
        nav.insertBefore(a, nav.querySelector('a.nav-cta'));
      });
    }
  }

  // 답변 저장 위젯 자동 변환
  function buildAnswerWidgets(user) {
    var boxes = document.querySelectorAll('[data-answer-key]');
    if (!boxes.length) return;

    boxes.forEach(function (box) {
      var key = box.getAttribute('data-answer-key');
      var q = box.getAttribute('data-answer-q') || '내 생각을 적어 보세요.';
      box.classList.add('answer-box');

      if (!user) {
        box.innerHTML = '<div class="answer-q">' + esc(q) + '</div>' +
          '<p class="answer-status">✍️ <a href="/login.html" style="color:var(--blue);font-weight:600;">로그인</a>하면 답변을 저장하고 다음에 이어서 볼 수 있어요. ' +
          '<a href="/signup.html" style="color:var(--blue);font-weight:600;">회원가입</a></p>';
        return;
      }

      box.innerHTML =
        '<div class="answer-q">' + esc(q) + '</div>' +
        '<textarea placeholder="여기에 답변을 적어 보세요..."></textarea>' +
        '<div class="answer-bar"><button class="btn btn-outline btn-sm" type="button">답변 저장</button>' +
        '<span class="answer-status"></span></div>';

      var ta = box.querySelector('textarea');
      var btn = box.querySelector('button');
      var status = box.querySelector('.answer-status');

      // 기존 답변 불러오기
      AilitAuth.getAnswers().then(function (d) {
        var found = (d.answers || []).find(function (a) { return a.item_key === key; });
        if (found) { ta.value = found.answer; status.textContent = '저장됨 · ' + found.updated_at; }
      }).catch(function () {});

      btn.addEventListener('click', function () {
        var v = ta.value.trim();
        if (!v) { status.textContent = '내용을 입력해 주세요.'; return; }
        btn.disabled = true; status.textContent = '저장 중...';
        AilitAuth.saveAnswer(key, q, v).then(function (d) {
          status.textContent = '✅ 저장됨 · ' + (d.answer && d.answer.updated_at || '');
        }).catch(function (e) {
          status.textContent = '⚠️ ' + e.message;
        }).finally(function () { btn.disabled = false; });
      });
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    AilitAuth.me().then(function (d) {
      updateHeader(d.user);
      buildAnswerWidgets(d.user);
    }).catch(function () {
      updateHeader(null);
      buildAnswerWidgets(null);
    });
  });
})();
