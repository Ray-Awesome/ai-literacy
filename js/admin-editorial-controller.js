import { canSend } from './admin-editorial-state.js';

export function bindInitialPageLoader(target, loader) {
  target.addEventListener('click', function () { loader(0); });
}

function matches(confirmation, editor, isValid) {
  return Boolean(confirmation)
    && canSend(editor, isValid)
    && confirmation.identity === editor.identity
    && confirmation.draftId === editor.draft.id
    && confirmation.revision === editor.revision
    && confirmation.subject === editor.draft.subject;
}

export function createSendConfirmationController() {
  let active = null;
  let nextRequestId = 1;

  return {
    begin(editor, isValid) {
      if (!canSend(editor, isValid)) return null;
      active = {
        identity: editor.identity,
        draftId: editor.draft.id,
        revision: editor.revision,
        subject: editor.draft.subject,
        requestId: nextRequestId++,
        status: 'loading',
        recipientCount: null,
      };
      return active;
    },
    resolve(request, recipientCount, editor, isValid) {
      if (active !== request || !matches(request, editor, isValid) || !Number.isSafeInteger(recipientCount) || recipientCount < 0) {
        if (active === request) active = null;
        return null;
      }
      request.status = 'ready';
      request.recipientCount = recipientCount;
      return request;
    },
    canSubmit(editor, isValid, confirmation = active) {
      return active === confirmation && active?.status === 'ready' && matches(active, editor, isValid);
    },
    submit(editor, isValid, confirmation, onSubmit) {
      if (!this.canSubmit(editor, isValid, confirmation)) return false;
      onSubmit(confirmation);
      return true;
    },
    current() { return active; },
    invalidate() { active = null; },
  };
}
