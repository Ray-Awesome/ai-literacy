/* ailit — main.js */

// 다크/라이트 모드 토글 — localStorage 지속
(function () {
  var html = document.documentElement;
  var btn  = document.getElementById('themeToggle');
  if (!btn) return;

  // localStorage에서 저장된 테마 읽어서 적용 (head 인라인 스크립트와 이중 보호)
  var saved = localStorage.getItem('ailit-theme') || 'light';
  html.setAttribute('data-theme', saved);

  btn.addEventListener('click', function () {
    var current = html.getAttribute('data-theme') || 'light';
    var next    = current === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    localStorage.setItem('ailit-theme', next);
  });
})();

// 스크롤 프로그레스 바
(function () {
  const bar = document.querySelector('.progress-bar');
  if (!bar) return;
  window.addEventListener('scroll', function () {
    const total = document.documentElement.scrollHeight - window.innerHeight;
    bar.style.width = (window.scrollY / total * 100) + '%';
  });
})();

// 모바일 메뉴 토글
(function () {
  const toggle = document.querySelector('.nav-toggle');
  const menu   = document.querySelector('.mobile-menu');
  if (!toggle || !menu) return;
  toggle.addEventListener('click', function () {
    toggle.classList.toggle('open');
    menu.classList.toggle('open');
  });
  // 메뉴 링크 클릭 시 닫기
  menu.querySelectorAll('a').forEach(function (a) {
    a.addEventListener('click', function () {
      toggle.classList.remove('open');
      menu.classList.remove('open');
    });
  });
})();

// 현재 페이지 nav 활성 표시
(function () {
  const path = window.location.pathname;
  document.querySelectorAll('.nav-links a, .mobile-menu a').forEach(function (a) {
    if (a.href && a.href !== window.location.origin + '/') {
      if (path.includes(a.getAttribute('href').replace(/^\.\.\//, '').replace(/\/$/, ''))) {
        a.classList.add('active');
      }
    }
  });
})();

// 섹션 등장 애니메이션
(function () {
  if (!('IntersectionObserver' in window)) return;
  const obs = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) {
        e.target.classList.add('visible');
        obs.unobserve(e.target);
      }
    });
  }, { threshold: 0.08 });
  document.querySelectorAll('.fade-up').forEach(function (el) { obs.observe(el); });
})();
