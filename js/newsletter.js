(function () {
  const statusMessages = Object.freeze({
    confirmed: {
      title: '구독이 완료되었습니다.',
      detail: '에이릿 뉴스레터를 이메일로 보내드립니다.',
    },
    unsubscribed: {
      title: '구독이 취소되었습니다.',
      detail: '앞으로 뉴스레터를 보내드리지 않습니다.',
    },
    invalid: {
      title: '확인 링크를 사용할 수 없습니다.',
      detail: '링크가 올바르지 않거나 만료되었습니다. 새 확인 메일을 요청해 주세요.',
      action: 'newsletter.html',
      actionLabel: '새 확인 메일 요청하기',
    },
  });

  function setFeedback(element, message, kind) {
    element.hidden = !message;
    element.textContent = message || '';
    element.className = `newsletter-feedback${kind ? ` ${kind}` : ''}`;
  }

  function setupSubscriptionForm() {
    const form = document.getElementById('newsletter-form');
    const feedback = document.getElementById('newsletter-feedback');
    const submit = document.getElementById('newsletter-submit');
    if (!form || !feedback || !submit) return;

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      submit.disabled = true;
      form.setAttribute('aria-busy', 'true');
      setFeedback(feedback, '구독 신청을 처리하고 있습니다.', 'loading');
      const data = new FormData(form);
      try {
        const response = await fetch('/api/newsletter/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: data.get('email'),
            consent: data.get('consent') === 'on',
            company: data.get('company'),
          }),
        });
        if (!response.ok) throw new Error('request failed');
        const payload = await response.json();
        setFeedback(feedback, typeof payload.message === 'string' ? payload.message : '확인 메일을 보냈습니다. 이메일의 링크를 눌러 구독을 완료해 주세요.', 'success');
        form.reset();
      } catch {
        setFeedback(feedback, '처리하지 못했습니다. 잠시 후 다시 시도해 주세요.', 'error');
      } finally {
        submit.disabled = false;
        form.removeAttribute('aria-busy');
      }
    });
  }

  function setupStatusPage() {
    const title = document.getElementById('newsletter-status-title');
    const detail = document.getElementById('newsletter-status-detail');
    const action = document.getElementById('newsletter-status-action');
    if (!title || !detail || !action) return;
    const state = new URLSearchParams(window.location.search).get('state');
    const message = statusMessages[state] || statusMessages.invalid;
    title.textContent = message.title;
    detail.textContent = message.detail;
    action.hidden = !message.action;
    if (message.action) {
      action.href = message.action;
      action.textContent = message.actionLabel;
    }
  }

  setupSubscriptionForm();
  setupStatusPage();
})();
