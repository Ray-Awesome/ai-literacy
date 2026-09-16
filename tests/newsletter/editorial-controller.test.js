import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bindInitialPageLoader,
  createSendConfirmationController,
} from '../../js/admin-editorial-controller.js';
import { createEditorState } from '../../js/admin-editorial-state.js';

function draft(id = 12, subject = '저장된 제목') {
  return { id, subject, previewText: '미리보기', blocks: [{ id: 'p1', type: 'paragraph', data: { text: '본문' } }], status: 'draft' };
}

class ClickTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  dispatchEvent(event) { this.listeners.get(event.type)?.(event); }
}

test('newsletter tab click always loads the first page instead of passing its MouseEvent', () => {
  const tab = new ClickTarget();
  const offsets = [];
  bindInitialPageLoader(tab, (offset) => offsets.push(offset));

  tab.dispatchEvent({ type: 'click', constructor: { name: 'MouseEvent' } });

  assert.deepEqual(offsets, [0]);
});

test('active-count response after an edit cannot create a sendable final confirmation', () => {
  const editor = createEditorState(draft(), 'editor-12');
  const controller = createSendConfirmationController();
  const request = controller.begin(editor, true);
  editor.revision += 1;
  editor.dirty = true;

  assert.equal(controller.resolve(request, 17, editor, true), null);
  assert.equal(controller.canSubmit(editor, true), false);
  assert.equal(controller.current(), null);
});

test('final confirmation rejects invalid, saving, switched, or newer save revisions', () => {
  const controller = createSendConfirmationController();
  const editor = createEditorState(draft(), 'editor-12');
  const request = controller.begin(editor, true);
  const confirmation = controller.resolve(request, 17, editor, true);
  assert.equal(controller.canSubmit(editor, true), true);

  editor.saving = true;
  assert.equal(controller.canSubmit(editor, true), false);
  editor.saving = false;
  assert.equal(controller.canSubmit(editor, false), false);
  assert.equal(controller.canSubmit(createEditorState(draft(13), 'editor-13'), true), false);
  editor.revision += 1;
  assert.equal(controller.canSubmit(editor, true), false);
  assert.equal(confirmation.subject, '저장된 제목');
});

test('unchanged saved draft keeps the exact confirmed subject and recipient count sendable', () => {
  const controller = createSendConfirmationController();
  const editor = createEditorState(draft(), 'editor-12');
  const request = controller.begin(editor, true);
  const confirmation = controller.resolve(request, 23, editor, true);

  assert.deepEqual(confirmation, {
    identity: 'editor-12', draftId: 12, revision: 0, subject: '저장된 제목', requestId: 1, status: 'ready', recipientCount: 23,
  });
  assert.equal(controller.canSubmit(editor, true), true);
});

test('a superseded confirmation cannot submit with an earlier recipient count', () => {
  const controller = createSendConfirmationController();
  const editor = createEditorState(draft(), 'editor-12');
  const first = controller.resolve(controller.begin(editor, true), 23, editor, true);
  const second = controller.resolve(controller.begin(editor, true), 24, editor, true);

  assert.equal(controller.canSubmit(editor, true, first), false);
  assert.equal(controller.canSubmit(editor, true, second), true);
});

test('final-click controller calls send only for the exact current saved confirmation', () => {
  const controller = createSendConfirmationController();
  const editor = createEditorState(draft(), 'editor-12');
  const confirmation = controller.resolve(controller.begin(editor, true), 23, editor, true);
  const submissions = [];

  editor.revision += 1;
  assert.equal(controller.submit(editor, true, confirmation, (value) => submissions.push(value)), false);
  assert.deepEqual(submissions, []);

  editor.revision -= 1;
  assert.equal(controller.submit(editor, true, confirmation, (value) => submissions.push(value)), true);
  assert.deepEqual(submissions, [confirmation]);
});
